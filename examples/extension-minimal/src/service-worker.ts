import {
  createDappRouter,
  layeredSessionStore,
  type ConnectDecision,
  type LocalSessionCache,
  type SignRequest,
} from "inpage-wallet/host";
import type { HostToPageEnvelope, PageToHostEnvelope, Session } from "inpage-wallet/protocol";
import { DEFAULT_CHANNEL, hostToPage, sessionKey } from "inpage-wallet/protocol";
import type { WorkerBoundMessage } from "inpage-wallet/transports/extension-content-script";

import { NETWORKS } from "../wallet";

// A real extension would back this with chrome.storage; a Map keeps the example
// to the wiring. `layeredSessionStore` takes the same shape either way.
const cache = new Map<string, Session>();
const local: LocalSessionCache = {
  get: (origin, family) => cache.get(sessionKey(origin, family)) ?? null,
  set: (s) => void cache.set(sessionKey(s.origin, s.family), s),
  clear: (origin, family) => void cache.delete(sessionKey(origin, family)),
  list: () => [...cache.values()],
};

async function tabIdFor(origin: string): Promise<number | undefined> {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  return tabs[0]?.id;
}

async function toPage(origin: string, env: HostToPageEnvelope): Promise<void> {
  const tabId = await tabIdFor(origin);
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, env).catch(() => {});
}

/**
 * A sheet that cannot show a field must not ask the user to approve it. This one
 * renders `to` and `value` only, so anything else in the request is a refusal.
 */
function describe(req: SignRequest): string {
  switch (req.method) {
    case "eth_sendTransaction":
    case "eth_signTransaction":
      if (req.tx.unknownFields.length > 0 || (req.tx.authorizationList?.length ?? 0) > 0) {
        throw { code: -32602, message: "This transaction has fields this wallet cannot show" };
      }
      return `Send ${req.tx.value} to ${req.tx.to ?? "a new contract"}`;
    case "personal_sign":
    case "eth_sign":
      return `Sign message: ${req.message.slice(0, 64)}`;
    default:
      return `Approve ${req.method}`;
  }
}

/**
 * In a real wallet these two callbacks open the approval window and return what
 * the user decided. The package never sees a key or a signer.
 */
const router = createDappRouter({
  networks: NETWORKS,
  sessions: layeredSessionStore({ local }),
  ui: {
    connect: async (req): Promise<ConnectDecision | null> => {
      const approved = confirm(`${req.origin} wants to connect (${req.family}).`);
      return approved ? { accounts: ["0x0000000000000000000000000000000000000001"] } : null;
    },
    sign: async (req): Promise<unknown> => {
      if (!confirm(`${req.origin}\n\n${describe(req)}`)) {
        throw { code: 4001, message: "User rejected the request" };
      }
      // Your signer goes here. Returning a placeholder keeps the example keyless.
      return `0x${"11".repeat(32)}`;
    },
  },
  emit: (origin, event) => {
    void toPage(origin, hostToPage(DEFAULT_CHANNEL, { kind: "event", ...event }));
  },
  // The extension keeps its own three-minute approval window.
  policy: { requestTimeoutMs: 180_000 },
});

chrome.runtime.onMessage.addListener((message: unknown): boolean => {
  const bound = message as WorkerBoundMessage | undefined;
  if (!bound) return false;
  const env: PageToHostEnvelope = bound.env;
  if (env.kind !== "request") return false;
  const { origin } = bound;

  void router
    .handle({ origin, method: env.method, params: env.params })
    .then((outcome) =>
      toPage(origin, hostToPage(DEFAULT_CHANNEL, { kind: "response", id: env.id, ...outcome })),
    );

  // The answer travels as its own message, so there is no async sendResponse.
  return false;
});
