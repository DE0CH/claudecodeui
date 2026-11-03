import { requireNativeModule } from "expo-modules-core";

const native = requireNativeModule<{
  set(url: string, cookie: string): Promise<boolean>;
  clear(): Promise<null>;
  setInsetsBackground(color: string): void;
}>("YycCookies");

/** Sets one cookie (a Set-Cookie value) for url in the WebView's cookie jar; resolves true when it was accepted. */
export function setCookie(url: string, cookie: string): Promise<boolean> {
  return native.set(url, cookie);
}

export function clearCookies(): Promise<null> {
  return native.clear();
}

/** The colour behind the system bars and the display cutout (the native content view's padding). */
export function setInsetsBackground(color: string): void {
  native.setInsetsBackground(color);
}
