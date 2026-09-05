import {
  DEFAULT_CHANNEL,
  isHostToPage,
  type HostToPageEnvelope,
  type PageToHostEnvelope,
} from "../protocol/envelope";
import type { PageTransport } from "../inpage/core/transport";

export type PostMessageTransportOptions = {
  channel?: string | undefined;
  /** The window to talk through; defaults to the page's own. */
  target?: Window | undefined;
};

/**
 * Page side for browser extensions: envelopes ride `window.postMessage` and an
 * isolated-world content script relays them onward. Same-window and same-origin
 * are both checked, so a frame cannot inject responses for its parent.
 */
export function postMessageTransport(options: PostMessageTransportOptions = {}): PageTransport {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const win = options.target ?? window;

  return {
    post(env: PageToHostEnvelope): void {
      win.postMessage(env, win.location.origin);
    },
    onMessage(handler: (env: HostToPageEnvelope) => void): void {
      win.addEventListener("message", (event: MessageEvent) => {
        if (event.source !== win) return;
        if (event.origin !== win.location.origin) return;
        if (!isHostToPage(event.data, channel)) return;
        handler(event.data);
      });
    },
  };
}
