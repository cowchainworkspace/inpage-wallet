import {
  DEFAULT_CHANNEL,
  isHostToPage,
  isPageToHost,
  type HostToPageEnvelope,
  type PageToHostEnvelope,
} from "../protocol/envelope";
import { originOf } from "../host/origin";

/**
 * What the isolated world hands the service worker: an envelope plus its origin.
 * `tabId` and `frameId` are a passthrough for a relay that already knows them —
 * a worker should prefer `sender.tab.id` and `sender.frameId`, which the page
 * cannot influence.
 */
export type WorkerBoundMessage = {
  origin: string;
  env: PageToHostEnvelope;
  tabId?: number | undefined;
  frameId?: number | undefined;
};

export type ContentScriptRelayOptions = {
  channel?: string | undefined;
  /** chrome.runtime.sendMessage, browser.runtime.sendMessage, or your own. */
  sendToWorker(message: WorkerBoundMessage): void;
  /** Subscribe to worker → page messages. Return an unsubscribe function. */
  onWorkerMessage(handler: (env: HostToPageEnvelope) => void): () => void;
  /**
   * The MAIN world cannot read an extension URL, so the icon is resolved here and
   * pushed over as `init`. An empty result leaves the placeholder in place.
   */
  resolveIcon?: (() => Promise<string>) | undefined;
};

export type ContentScriptRelay = { stop(): void };

/**
 * Isolated-world relay between the injected providers and the service worker.
 * Parametrised by the two messaging calls so it works with chrome.*,
 * webextension-polyfill, or a test double, without importing any of them.
 */
export function createContentScriptRelay(
  options: ContentScriptRelayOptions,
): ContentScriptRelay {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  // A sandboxed iframe, a data: or file: document and plain http all give an
  // origin the host cannot key a session on — "null" is shared by every one of
  // them. There is nothing safe to relay, so this frame gets no wallet at all.
  const origin = originOf(window.location.href);
  if (!origin) return { stop: () => {} };

  const toPage = (env: HostToPageEnvelope): void => {
    window.postMessage(env, origin);
  };

  let iconRequest: Promise<string> | null = null;
  const sendInit = (): void => {
    if (!options.resolveIcon) return;
    iconRequest = iconRequest ?? options.resolveIcon();
    void iconRequest.then(
      (icon) => {
        if (!icon) return;
        toPage({ channel, direction: "host-to-page", kind: "init", icon });
      },
      () => {
        /* no icon is better than a broken one; the placeholder stands */
      },
    );
  };

  const onPageMessage = (event: MessageEvent): void => {
    if (event.source !== window) return;
    if (event.origin !== origin) return;
    if (!isPageToHost(event.data, channel)) return;

    if (event.data.kind === "ready") {
      sendInit();
      return;
    }
    options.sendToWorker({ origin, env: event.data });
  };

  window.addEventListener("message", onPageMessage);
  const offWorker = options.onWorkerMessage((env) => {
    if (!isHostToPage(env, channel)) return;
    toPage(env);
  });

  // The MAIN world may already be listening when this runs.
  sendInit();

  return {
    stop() {
      window.removeEventListener("message", onPageMessage);
      offWorker();
    },
  };
}
