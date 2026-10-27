#!/bin/bash
# Open the bot's browser (runner slot 0) so the owner can sign in to Google by hand.
# A signed-in browser gets far fewer reCAPTCHA puzzles. After the window is closed,
# the sign-in is copied to the other runner slots.
#   autoapply/google-login.sh          sign in, then copy slot 0 -> slots 1..3
#   autoapply/google-login.sh --copy   only copy slot 0 -> slots 1..3
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/profiles"
if pgrep -f "user-data-dir=$P/runner-slot" >/dev/null; then echo "a bot browser is running; try again after the run" >&2; exit 1; fi
# Same Chromium build as the profile, or Chrome may refuse an older/newer profile.
APP="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app | sort -V | tail -1)"
if [ "${1:-}" != "--copy" ]; then
  # --use-mock-keychain matches how Playwright starts it, so the saved cookies stay readable for the bot.
  open -W -n -a "$APP" --args --user-data-dir="$P/runner-slot-0" --use-mock-keychain --no-first-run \
    "https://accounts.google.com/"
fi
for n in 1 2 3; do
  rsync -a --delete --exclude 'Singleton*' --exclude '*.lock' "$P/runner-slot-0/" "$P/runner-slot-$n/"
done
echo "copied sign-in to runner slots 1-3"
