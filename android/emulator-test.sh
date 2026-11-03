#!/usr/bin/env bash
# The YYC AI Android app on an emulator (README.md): installs the APK, checks the site loads signed out in the WebView
# (its 「登入」), taps it and checks the sign-in opens in Chrome (a Custom Tab on Access's login), with a screenshot
# of each step in $OUT. Run inside android-emulator-runner. Usage: emulator-test.sh APK OUT
set -euo pipefail
APK=${1:?apk}
OUT=${2:?out dir}
PKG=dev.de0ch.yycai
mkdir -p "$OUT"

shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml; }
resumed() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" || true; }

# waits up to $2 s for the screen's accessibility tree to contain $1; prints the matching node
wait_text() {
  local t=$1 n=$2 i
  for ((i = 0; i < n; i += 2)); do
    if dump > "$OUT/ui.xml" && grep -o "<node[^>]*text=\"[^\"]*$t[^\"]*\"[^>]*>" "$OUT/ui.xml" | head -1 | grep .; then return 0; fi
    sleep 2
  done
  return 1
}

adb install -r "$APK"
adb shell am start -W -n "$PKG/.MainActivity"
sleep 5
shot 1-launch

if ! node=$(wait_text "登入" 90); then
  shot 2-no-signin
  echo "FAIL: the signed-out site (「登入」) did not appear" >&2
  exit 1
fi
shot 2-signed-out
echo "found: $node"

# the button's centre from its bounds="[x1,y1][x2,y2]"
read -r x1 y1 x2 y2 < <(sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/' <<< "$node")
adb shell input tap $(((x1 + x2) / 2)) $(((y1 + y2) / 2))

for i in $(seq 1 20); do
  sleep 2
  top=$(resumed)
  if [[ "$top" != *"$PKG/.MainActivity"* && "$top" == *"chrome"* ]]; then
    sleep 4
    shot 3-signin-in-chrome
    echo "ok: sign-in opened in Chrome ($top)"
    exit 0
  fi
done
shot 3-no-custom-tab
echo "FAIL: tapping 「登入」 did not open Chrome; top activity: $(resumed)" >&2
exit 1
