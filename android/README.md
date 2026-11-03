# YYC AI for Android

A thin React Native (Expo) shell, package `dev.de0ch.yycai`: one full-screen WebView of the YYC AI site, so it shows
the same UI as the browser. The site's address is the `YYC_SITE` build secret, never in this public repo.

- **Sign-in:** Google refuses sign-ins inside a WebView, so a navigation to a sign-in (the web app's
  `/api/jarvis/signin`, or Access's `*.cloudflareaccess.com` login) is stopped and the app opens the router's
  `GET /api/jarvis/app-signin?state=…` in a Chrome Custom Tab instead. The router answers with
  `dev.de0ch.yycai://signed-in?state=…#token=…` (the person's own Access token, as for the iOS app); the app checks the
  state and puts the token in the WebView's cookie jar as `CF_Authorization` (`modules/yyc-cookies`, Android's
  `CookieManager`), then reloads the page the sign-in started from. When the token expires, the site's 「登入」 takes the
  same path.
- **Links** off the site open in the phone's browser; the hardware back button goes back in the WebView.
- **Keyboard and screen sizes:** Android 15+ draws apps edge to edge and no longer shrinks the window for the keyboard,
  so `modules/yyc-cookies` pads the activity's content view by the system bars, the cutout and the keyboard; the page
  sees the smaller viewport, as in Chrome. No orientation lock, and folding or resizing never restarts the activity
  (`smallestScreenSize` and `screenSize` are config changes), so a foldable keeps the page and what was typed.
- **CI** (`.github/workflows/yyc-android.yml`, on every push to `android/`): a release APK (arm64-v8a, x86_64) signed
  with the upload key (secrets `YYC_ANDROID_UPLOAD_KEYSTORE`, a base64 PKCS12 with alias `upload`, and
  `YYC_ANDROID_UPLOAD_KEYSTORE_PASSWORD`), then `emulator-test.sh` on a Pixel Fold emulator: the site loads signed out
  folded and unfolded without a restart, 「登入」 opens Chrome, and on a test build (`YYC_TEST_PAGE=1`, a local page)
  the keyboard shrinks the viewport in both postures. The APK and screenshots leave CI only as the age-encrypted artifact `yyc-android-encrypted`.
- **Download:** a pushed build that passes goes to the bucket (secrets `YYC_S3_*`, object
  `apps/yyc-ai-android.apk`); the router serves it to signed-in staff at `/api/jarvis/android.apk` (`JARVIS_APK_S3_*`),
  the Download button in Settings → General.
- **Local build:** `npm ci && YYC_SITE=https://… npm run prebuild && (cd android && ./gradlew assembleRelease)`;
  without `ANDROID_KEYSTORE` the release build is signed with the debug key.
