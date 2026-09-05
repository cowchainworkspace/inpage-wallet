import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, View } from "react-native";
import {
  WebView,
  type WebViewInstance,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";

import {
  createDappRouter,
  createNonce,
  layeredSessionStore,
  nextCommittedNavigation,
  originOf,
  type CommittedNavigation,
  type ConnectDecision,
  type LocalSessionCache,
  type SignRequest,
} from "inpage-wallet/host";
import type { NetworkDef, Session } from "inpage-wallet/protocol";
import { DEFAULT_CHANNEL, hostToPage, sessionKey } from "inpage-wallet/protocol";
import type { WalletIdentity } from "inpage-wallet/inpage";
import { buildInjectedScript } from "inpage-wallet/script";
import { createRnHostTransport } from "inpage-wallet/transports/rn-webview";

const IDENTITY: WalletIdentity = {
  name: "Example Wallet",
  rdns: "com.example.wallet",
  uuid: "6f9d3c1e-0a2b-4c8d-9e1f-2a3b4c5d6e7f",
};

const NETWORKS: NetworkDef[] = [
  { id: "1", family: "evm", name: "Ethereum", wire: { evmChainId: "0x1", caip2: "eip155:1" } },
  {
    id: "sol_mainnet",
    family: "solana",
    name: "Solana",
    wire: { walletStandardChain: "solana:mainnet" },
  },
];

// MMKV or AsyncStorage in a real app; the store only needs these four calls.
const cache = new Map<string, Session>();
const local: LocalSessionCache = {
  get: (origin, family) => cache.get(sessionKey(origin, family)) ?? null,
  set: (s) => void cache.set(sessionKey(s.origin, s.family), s),
  clear: (origin, family) => void cache.delete(sessionKey(origin, family)),
  list: () => [...cache.values()],
};

function ask(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: "Approve", onPress: () => resolve(true) },
    ]);
  });
}

/**
 * A sheet that cannot show a field must not ask the user to approve it. This one
 * renders `to` and `value` only, so a feature that changes what is signed but
 * isn't rendered here is a refusal; `ignoredFields` is safe to skip.
 */
function describe(req: SignRequest): string {
  switch (req.method) {
    case "eth_sendTransaction":
    case "eth_signTransaction":
      if (
        (req.tx.authorizationList?.length ?? 0) > 0 ||
        req.tx.hasBlobPayload ||
        (req.tx.accessList?.length ?? 0) > 0
      ) {
        throw { code: -32602, message: "This transaction has fields this wallet cannot show" };
      }
      return (
        `Send ${req.tx.value} to ${req.tx.to ?? "a new contract"}` +
        (req.tx.ignoredFields.length > 0
          ? `\n\n(unrendered, informational: ${req.tx.ignoredFields.join(", ")})`
          : "")
      );
    case "eth_signTypedData_v4":
      return req.typedData?.primaryType ?? "Sign typed data";
    case "personal_sign":
      return req.message.slice(0, 120);
    default:
      return req.method;
  }
}

export default function DappBrowser({ uri }: { uri: string }): JSX.Element {
  const ref = useRef<WebViewInstance | null>(null);
  // The security boundary: origin comes from the committed navigation, never
  // from anything the page says about itself. The nonce travels with it — on
  // Android every frame can reach ReactNativeWebView.postMessage, so only the
  // stamp the injected script carries tells the top-level document apart.
  const committed = useRef<CommittedNavigation | null>(null);
  const nonce = useRef(createNonce());
  const [scriptNonce, setScriptNonce] = useState(nonce.current);

  const injected = useMemo(
    () => buildInjectedScript({ identity: IDENTITY, networks: NETWORKS, nonce: scriptNonce }),
    [scriptNonce],
  );

  const transport = useMemo(
    () => createRnHostTransport({ inject: (script) => ref.current?.injectJavaScript(script) }),
    [],
  );

  const router = useMemo(
    () =>
      createDappRouter({
        networks: NETWORKS,
        sessions: layeredSessionStore({ local }),
        ui: {
          connect: async (req): Promise<ConnectDecision | null> => {
            const ok = await ask("Connect", `${req.origin} wants to connect (${req.family}).`);
            return ok ? { accounts: ["0x0000000000000000000000000000000000000001"] } : null;
          },
          sign: async (req): Promise<unknown> => {
            const ok = await ask("Confirm", `${req.origin}\n\n${describe(req)}`);
            if (!ok) throw { code: 4001, message: "User rejected the request" };
            // Your on-device signer goes here.
            return `0x${"11".repeat(32)}`;
          },
        },
        emit: (origin, event) => {
          if (origin !== committed.current?.origin) return;
          transport.deliver(origin, hostToPage(DEFAULT_CHANNEL, { kind: "event", ...event }));
        },
        // Mobile keeps its own 90-second sheet timeout.
        policy: { requestTimeoutMs: 90_000 },
      }),
    [transport],
  );

  useMemo(() => {
    transport.onMessage((origin, env) => {
      if (env.kind === "ready") return;
      void router
        .handle({ origin, method: env.method, params: env.params })
        .then((outcome) =>
          transport.deliver(
            origin,
            hostToPage(DEFAULT_CHANNEL, { kind: "response", id: env.id, ...outcome }),
          ),
        );
    });
  }, [router, transport]);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      transport.receive(committed.current?.origin ?? null, event.nativeEvent.data);
    },
    [transport],
  );

  const onNavigationStateChange = useCallback(
    (nav: WebViewNavigation) => {
      // A load starting on a different site gets its own nonce, so the document
      // that replaces this one cannot reuse its stamp. If the prop update loses
      // the race with the load, that document is simply ignored — the failure is
      // a page with no wallet, never a page speaking for another origin.
      if (nav.loading && committed.current && originOf(nav.url) !== committed.current.origin) {
        nonce.current = createNonce();
        setScriptNonce(nonce.current);
      }
      const next = nextCommittedNavigation(committed.current, nav, nonce.current);
      committed.current = next;
      transport.commit(next);
    },
    [transport],
  );

  return (
    <View style={{ flex: 1 }}>
      <WebView
        ref={ref}
        source={{ uri }}
        // The default, and it must stay on: the nonce only means anything while
        // the script is the main frame's alone.
        injectedJavaScriptForMainFrameOnly
        injectedJavaScriptBeforeContentLoaded={injected}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
      />
    </View>
  );
}
