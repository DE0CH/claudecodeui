// The YYC AI Android app (README.md): one WebView of the YYC AI site, the same UI as the browser. The site's address
// is the YYC_SITE build secret, never in this public repo. The package id is also the URL scheme the router's
// sign-in (GET /api/jarvis/app-signin) returns to, as for the iOS app.
const PACKAGE_ID = "dev.de0ch.yycai";

export default {
  expo: {
    name: "YYC AI",
    slug: "yyc-ai-android",
    version: "1.0.0",
    // no lock: a foldable or a tablet shows the site at its full width, as Chrome does
    orientation: "default",
    icon: "./assets/yyc-icon.png",
    scheme: PACKAGE_ID,
    userInterfaceStyle: "automatic",
    android: {
      package: PACKAGE_ID,
      versionCode: Number(process.env.VERSION_CODE || 1),
      adaptiveIcon: {
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundColor: "#1B2A3A",
      },
      edgeToEdgeEnabled: true,
      softwareKeyboardLayoutMode: "resize",
      permissions: ["android.permission.INTERNET"],
      blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW"],
    },
    plugins: [
      ["expo-build-properties", { android: { minSdkVersion: 29 } }],
      "./plugins/with-release-signing",
    ],
    extra: {
      yycSite: process.env.YYC_SITE,
      // CI's keyboard test build only (App.tsx TEST_PAGE)
      testPage: process.env.YYC_TEST_PAGE === "1",
    },
  },
};
