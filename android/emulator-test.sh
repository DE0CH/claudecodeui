#!/usr/bin/env bash
# The YYC AI Android app on a foldable emulator (Pixel Fold; README.md), with a screenshot of each step in $OUT:
# 1. the release APK: the site loads signed out (its 「登入」 / Sign in) unfolded and folded, folding never restarts
#    the app, and tapping Sign in opens Chrome (a Custom Tab on Access's login);
# 2. the test build (YYC_TEST_PAGE=1, a local page with a text box): in both postures, focusing the box brings up the
#    keyboard and the page's viewport shrinks, so the box stays above the keyboard.
# Run inside android-emulator-runner. Usage: emulator-test.sh RELEASE_APK TEST_APK OUT
set -euo pipefail
APK=${1:?release apk}
TEST_APK=${2:?test apk}
OUT=${3:?out dir}
PKG=dev.de0ch.yycai
mkdir -p "$OUT"

shot() { adb exec-out screencap -p > "$OUT/$1.png"; }
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml; }
resumed() { adb shell dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity" || true; }
fail() { shot "fail-$1"; echo "FAIL: $2" >&2; exit 1; }

# the centre of a node="<node … bounds="[x1,y1][x2,y2]" …>"
centre() {
  local x1 y1 x2 y2
  read -r x1 y1 x2 y2 < <(sed -E 's/.*bounds="\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]".*/\1 \2 \3 \4/' <<< "$1")
  echo $(((x1 + x2) / 2)) $(((y1 + y2) / 2))
}

# waits up to $2 s for a node whose text or content-desc matches the ERE $1 (whole value); prints it.
# A system "isn't responding" dialog (the emulator's launcher, not this app) is answered with Wait.
wait_text() {
  local t=$1 n=$2 i anr
  for ((i = 0; i < n; i += 2)); do
    if dump > "$OUT/ui.xml"; then
      if anr=$(grep -o '<node[^>]*text="Wait"[^>]*>' "$OUT/ui.xml" | head -1 | grep .); then
        adb shell input tap $(centre "$anr")
        sleep 2
        continue
      fi
      grep -o '<node[^>]*>' "$OUT/ui.xml" | grep -E "(text|content-desc)=\"($t)\"" | head -1 | grep . && return 0
    fi
    sleep 2
  done
  return 1
}

# the emulator's hinge: fold | unfold
posture() {
  adb emu "$1" > /dev/null
  sleep 5
}

pid() { adb shell pidof "$PKG" || true; }

# ---- 1. the release APK
adb install -r "$APK"
posture unfold
adb shell am start -W -n "$PKG/.MainActivity"
sleep 5
wait_text "登入|Sign in" 90 > /dev/null || fail 1-unfolded "the signed-out site (Sign in) did not appear unfolded"
shot 1-unfolded
p0=$(pid)

posture fold
wait_text "登入|Sign in" 30 > /dev/null || fail 2-folded "the site did not show Sign in after folding"
shot 2-folded
[[ "$(pid)" == "$p0" ]] || fail 2-folded "folding restarted the app (pid $p0 -> $(pid))"

posture unfold
node=$(wait_text "登入|Sign in" 30) || fail 3-unfolded-again "the site did not show Sign in after unfolding"
shot 3-unfolded-again
[[ "$(pid)" == "$p0" ]] || fail 3-unfolded-again "unfolding restarted the app (pid $p0 -> $(pid))"

adb shell input tap $(centre "$node")
ok=
for i in $(seq 1 20); do
  sleep 2
  top=$(resumed)
  if [[ "$top" != *"$PKG/.MainActivity"* && "$top" == *"chrome"* ]]; then ok=1; break; fi
done
[[ -n "$ok" ]] || fail 4-signin "tapping Sign in did not open Chrome; top activity: $(resumed)"
sleep 4
shot 4-signin-in-chrome
echo "ok: release build (unfolded, folded, sign-in in Chrome)"
adb shell am force-stop com.android.chrome || true

# ---- 2. the keyboard, on the test build
vh() { wait_text 'vh=[0-9]+' 20 | sed -E 's/.*(text|content-desc)="vh=([0-9]+)".*/\2/' | head -1; }
keyboard_shown() { adb shell dumpsys input_method | grep -q -E "mInputShown=true|isInputViewShown=true"; }

adb install -r "$TEST_APK"
for state in unfold fold; do
  posture "$state"
  adb shell am force-stop "$PKG"
  adb shell am start -W -n "$PKG/.MainActivity" > /dev/null
  sleep 4
  before=$(vh) || true
  [[ -n "$before" ]] || fail "5-$state" "the test page did not show its height ($state)"
  box=$(wait_text "test box" 20) || fail "5-$state" "the test page's text box is missing ($state)"
  adb shell input tap $(centre "$box")
  for i in $(seq 1 10); do sleep 1; keyboard_shown && break; done
  keyboard_shown || fail "5-$state" "the keyboard did not come up ($state)"
  sleep 2
  after=$(vh) || true
  shot "5-keyboard-$state"
  echo "$state: viewport $before -> $after with the keyboard"
  [[ -n "$after" && "$after" -lt $((before - 100)) ]] \
    || fail "5-$state" "the WebView did not shrink for the keyboard ($state: $before -> ${after:-?})"
  wait_text "test box" 10 > /dev/null || fail "5-$state" "the text box is not on screen with the keyboard ($state)"
  adb shell input keyevent KEYCODE_BACK
done
echo "ok: the keyboard shrinks the WebView, folded and unfolded"
