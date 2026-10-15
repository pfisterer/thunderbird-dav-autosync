#!/bin/sh
# Downloads Thunderbird ESR into .local/tb for tests (macOS or Linux x86_64). Does not touch any installed Thunderbird.
# macOS: unpacked into a plain folder (not *.app), because macOS forbids writing a policies.json into a signed app bundle.
#   scripts/get-thunderbird.sh [lang]   default lang: en-US
set -eu
cd "$(dirname "$0")/.."
LANG_CODE=${1:-en-US}
rm -rf .local/tb
mkdir -p .local
case "$(uname -s)" in
  Darwin)
    curl -sSfL -o .local/tb.dmg "https://download.mozilla.org/?product=thunderbird-esr-latest-SSL&os=osx&lang=$LANG_CODE"
    MNT=$(hdiutil attach -nobrowse -readonly .local/tb.dmg | awk -F'\t' '/\/Volumes\//{print $NF}')
    ditto "$MNT/Thunderbird.app" .local/tb
    hdiutil detach -quiet "$MNT"
    rm .local/tb.dmg
    ;;
  Linux)
    mkdir -p .local/tb
    curl -sSfL "https://download.mozilla.org/?product=thunderbird-esr-latest-SSL&os=linux64&lang=$LANG_CODE" | tar -xJ --strip-components=1 -C .local/tb
    ;;
  *)
    echo "Nicht unterstützt: $(uname -s)" >&2; exit 1 ;;
esac
"$(node -p "require('./test/e2e/thunderbird.cjs').paths().binary")" --version
