#!/bin/sh
# Starts the test copy of Thunderbird (.local/tb, see scripts/get-thunderbird.sh) with its own profile, independent of the production Thunderbird.
#   scripts/tb-test.sh        profile .local/profile
#   scripts/tb-test.sh e2e    profile of the end-to-end test (add-on, alice's login and synced calendars already set up)
cd "$(dirname "$0")/.." || exit 1
PROFILE="$PWD/.local/profile"
if [ "$1" = "e2e" ]; then
  PROFILE="$PWD/.local/e2e-profile"
  shift
fi
mkdir -p "$PROFILE"
[ -f "$PROFILE/user.js" ] || cp test/e2e/user.js "$PROFILE/user.js"
exec "$(node -p "require('./test/e2e/thunderbird.cjs').paths().binary")" -profile "$PROFILE" -no-remote "$@"
