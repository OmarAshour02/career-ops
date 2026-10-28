#!/usr/bin/env bash
# Tell the owner auto-apply could not solve a CAPTCHA. Returns at once; never waits for him.
# Usage: autoapply/captcha-alert.sh "<company>" "<role>"
company=${1:-a job}; role=${2:-}
msg="Auto-apply could not solve the CAPTCHA at $company${role:+ ($role)}. Solve it in that browser window within 3 min, or ignore it."
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"${msg//\"/}\" with title \"Auto-apply needs you\" sound name \"Glass\"" >/dev/null 2>&1 &
elif command -v notify-send >/dev/null 2>&1; then
  notify-send -u critical "Auto-apply needs you" "$msg" >/dev/null 2>&1 &
fi
exit 0
