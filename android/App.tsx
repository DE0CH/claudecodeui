// The YYC AI Android app (README.md): the site in one full-screen WebView. Signing in goes through Chrome (a Custom
// Tab), because Google refuses sign-ins inside a WebView: the router's GET /api/jarvis/app-signin sends the person's
// own Access token back to this app's scheme, and the app puts it in the WebView's cookie jar as CF_Authorization.
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Linking, Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { setCookie, setInsetsBackground } from "./modules/yyc-cookies/src";

const SITE = String(Constants.expoConfig?.extra?.yycSite ?? "").replace(/\/+$/, "");
const SCHEME = "dev.de0ch.yycai";
// Access's token lasts 720 h (the iOS app's access-token.ts); the cookie lives as long
const TOKEN_MAX_AGE = 720 * 3600;

const DARK = "#1B2A3A";

// CI's test build only (YYC_TEST_PAGE=1, emulator-test.sh): a local page with a text box at the bottom that shows
// the viewport's height, to check the keyboard shrinks the WebView. Release builds never have it.
const TEST_PAGE = Constants.expoConfig?.extra?.testPage
  ? `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column;font:16px sans-serif">
<p id="h" style="flex:1;margin:16px"></p><textarea id="box" placeholder="test box" style="height:48px;margin:8px"></textarea>
<script>const h=document.getElementById("h");const u=()=>{h.textContent="vh="+window.innerHeight};
addEventListener("resize",u);u();</script></body></html>`
  : null;

function siteOrigin(): string {
  const m = /^https?:\/\/[^/]+/.exec(SITE);
  return m ? m[0] : SITE;
}

/** What a top-frame navigation is: the site itself, a sign-in (the router's or Access's login), or anything else. */
function classify(url: string): "site" | "signin" | "inline" | "outside" {
  if (/^(about:|data:|blob:|javascript:)/.test(url)) return "inline";
  const m = /^https?:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(url);
  if (!m) return "outside";
  const host = m[1].toLowerCase();
  const path = m[2] || "/";
  if (host.endsWith(".cloudflareaccess.com") || path.startsWith("/cdn-cgi/access/")) return "signin";
  if (url.startsWith(siteOrigin() + "/") || url === siteOrigin()) {
    return path === "/api/jarvis/signin" || path === "/api/jarvis/app-signin" ? "signin" : "site";
  }
  return "outside";
}

/** The page a sign-in returns to: the web app's `/api/jarvis/signin?next=/…`, else the start page. */
function nextPath(url: string): string {
  const m = /[?&]next=([^&#]*)/.exec(url);
  const next = m ? decodeURIComponent(m[1]) : "/";
  return /^\/(?![\/\\])[^\s]*$/.test(next) && !next.startsWith("/api/") ? next : "/";
}

/** The token and state from `<scheme>://signed-in?state=…#token=…`. */
function parseCallback(url: string): { state: string; token: string } | null {
  const q = /[?&]state=([^&#]*)/.exec(url);
  const f = /[#&]token=([^&]*)/.exec(url);
  if (!q || !f) return null;
  return { state: decodeURIComponent(q[1]), token: decodeURIComponent(f[1]) };
}

export default function App() {
  const dark = useColorScheme() === "dark";
  const web = useRef<WebView>(null);
  const canGoBack = useRef(false);
  const signingIn = useRef(false);
  const [uri, setUri] = useState(SITE + "/");
  const [key, setKey] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const background = dark ? "#000000" : "#ffffff";

  useEffect(() => setInsetsBackground(background), [background]);

  const signIn = useCallback(async (next = "/") => {
    if (signingIn.current) return;
    signingIn.current = true;
    try {
      const state = Crypto.randomUUID();
      const result = await WebBrowser.openAuthSessionAsync(
        `${SITE}/api/jarvis/app-signin?state=${state}`,
        `${SCHEME}://signed-in`,
        { showInRecents: false },
      );
      if (result.type !== "success") return;
      const cb = parseCallback(result.url);
      if (!cb || cb.state !== state || !cb.token) return;
      await setCookie(
        siteOrigin(),
        `CF_Authorization=${cb.token}; Path=/; Max-Age=${TOKEN_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`,
      );
      setUri(SITE + next);
      setKey((k) => k + 1);
    } finally {
      signingIn.current = false;
    }
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack.current) {
        web.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

  const onShouldStart = useCallback(
    (req: ShouldStartLoadRequest) => {
      if (req.isTopFrame === false) return true;
      switch (classify(req.url)) {
        case "site":
        case "inline":
          return true;
        case "signin":
          void signIn(nextPath(req.url));
          return false;
        default:
          void Linking.openURL(req.url);
          return false;
      }
    },
    [signIn],
  );

  if (!SITE && !TEST_PAGE) {
    return (
      <View style={[styles.center, { backgroundColor: DARK }]}>
        <Text style={styles.message}>This build has no YYC_SITE.</Text>
      </View>
    );
  }

  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      {/* the native content view is already padded by the system bars and the keyboard (modules/yyc-cookies) */}
      <View style={[styles.fill, { backgroundColor: background }]}>
        {failed ? (
          <View style={styles.center}>
            <Text style={[styles.message, { color: dark ? "#ffffff" : "#000000" }]}>未能連線 Could not connect</Text>
            <Pressable
              accessibilityRole="button"
              style={styles.retry}
              onPress={() => {
                setFailed(null);
                setKey((k) => k + 1);
              }}
            >
              <Text style={styles.retryText}>重試 Retry</Text>
            </Pressable>
          </View>
        ) : (
          <WebView
            key={key}
            ref={web}
            testID="site"
            source={TEST_PAGE ? { html: TEST_PAGE } : { uri }}
            style={styles.fill}
            originWhitelist={["https://*", "about:*", "data:*", "blob:*"]}
            onShouldStartLoadWithRequest={onShouldStart}
            onNavigationStateChange={(nav: WebViewNavigation) => {
              canGoBack.current = nav.canGoBack;
            }}
            onError={(e) => setFailed(e.nativeEvent.description || "error")}
            javaScriptEnabled
            domStorageEnabled
            sharedCookiesEnabled
            thirdPartyCookiesEnabled={false}
            allowsBackForwardNavigationGestures
            setSupportMultipleWindows={false}
            allowFileAccess={false}
            mediaPlaybackRequiresUserAction
            pullToRefreshEnabled={false}
            overScrollMode="never"
            applicationNameForUserAgent="YYCAI-Android/1.0"
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  message: { fontSize: 16, color: "#ffffff" },
  retry: { borderWidth: 1, borderColor: "#888888", paddingHorizontal: 20, paddingVertical: 10 },
  retryText: { fontSize: 16, color: "#888888" },
});
