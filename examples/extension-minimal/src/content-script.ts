import type { HostToPageEnvelope } from "inpage-wallet/protocol";
import { createContentScriptRelay } from "inpage-wallet/transports/extension-content-script";

/** The MAIN world cannot read an extension URL, so the icon is resolved here. */
async function resolveIcon(): Promise<string> {
  const url = chrome.runtime.getURL("icons/icon-48.png");
  try {
    const blob = await fetch(url).then((res) => res.blob());
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return url;
  }
}

createContentScriptRelay({
  sendToWorker: (message) => {
    // Fire and forget: the answer comes back as its own tabs.sendMessage.
    void chrome.runtime.sendMessage(message).catch(() => {});
  },
  onWorkerMessage: (handler) => {
    const listener = (message: unknown): boolean => {
      handler(message as HostToPageEnvelope);
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {};
  },
  resolveIcon,
});
