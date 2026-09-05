// Minimal stand-ins so this example typechecks without installing React Native.
// A real app has the real types and can delete this file.
declare namespace JSX {
  type Element = unknown;
  interface ElementAttributesProperty {
    props: unknown;
  }
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}

declare module "react" {
  export function useCallback<T>(fn: T, deps: unknown[]): T;
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  export function useRef<T>(initial: T): { current: T };
  export function useState<T>(initial: T | (() => T)): [T, (next: T) => void];
}

declare module "react-native" {
  export const View: (props: Record<string, unknown>) => JSX.Element;
  export const Alert: {
    alert(
      title: string,
      message?: string,
      buttons?: { text: string; style?: string; onPress?: () => void }[],
    ): void;
  };
}

declare module "react-native-webview" {
  export type WebViewNavigation = { url: string; loading: boolean };
  export type WebViewMessageEvent = { nativeEvent: { data: string } };
  export type WebViewProps = Record<string, unknown>;
  export type WebViewInstance = { injectJavaScript(script: string): void };
  export const WebView: (props: Record<string, unknown>) => JSX.Element;
}
