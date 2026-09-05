// Just enough of the MV3 surface for this example to typecheck without @types/chrome.
declare const chrome: {
  runtime: {
    getURL(path: string): string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (message: unknown, sender: { tab?: { id?: number } }) => boolean | void,
      ): void;
    };
  };
  tabs: {
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    query(query: { url?: string }): Promise<{ id?: number }[]>;
  };
};
