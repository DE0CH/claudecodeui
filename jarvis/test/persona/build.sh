#!/usr/bin/env bash
# The persona build (aviary WP-54): the staff web app exactly as the ui image builds it (scripts/build-paseo-ui.mjs),
# with EXPO_PUBLIC_YYC_PERSONA=1 so window.__yycPersona and the seeded defects exist (paseo/packages/app/src/yyc/
# persona.ts). Output: <out>/ (the edge stand-in serves it). Never deployed: the ui image's build sets no such flag.
#   jarvis/test/persona/build.sh <out dir>
set -euo pipefail
root=$(cd "$(dirname "$0")/../../.." && pwd)
out=${1:?out dir}
cd "$root"
[ -d paseo/node_modules ] || HUSKY=0 npm --prefix paseo ci
[ -d node_modules ] || HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm ci
EXPO_PUBLIC_YYC_PERSONA=1 node scripts/build-paseo-ui.mjs
rm -rf "$out" && mkdir -p "$out" && cp -r dist/. "$out/"
grep -rlq "yyc-persona-defect" "$out" || { echo "build.sh: the persona hooks are not in the bundle" >&2; exit 1; }
echo "persona build in $out"
