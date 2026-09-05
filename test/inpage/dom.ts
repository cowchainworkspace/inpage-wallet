/**
 * The jsdom document is shared by every test in a file, so providers installed by
 * one test would keep answering `eip6963:requestProvider` in the next. Tracking
 * window listeners lets each test start from a clean document.
 */
const tracked: [string, EventListenerOrEventListenerObject, unknown][] = [];
const realAdd = window.addEventListener.bind(window);

window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, opts?: unknown) => {
  tracked.push([type, listener, opts]);
  realAdd(type, listener, opts as boolean | AddEventListenerOptions | undefined);
}) as typeof window.addEventListener;

export function resetWindowListeners(): void {
  for (const [type, listener, opts] of tracked) {
    window.removeEventListener(type, listener, opts as boolean | EventListenerOptions | undefined);
  }
  tracked.length = 0;
}
