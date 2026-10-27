#!/usr/bin/env bash
# Tell the owner a filled form is waiting on a CAPTCHA. Returns at once; never waits for him.
# Usage: autoapply/captcha-alert.sh "<company>" "<role>"
company=${1:-a job}; role=${2:-}
msg="CAPTCHA at $company${role:+ ($role)}. Solve it in that browser window within 3 min, or ignore it."
osascript -e "display notification \"${msg//\"/}\" with title \"Auto-apply needs you\" sound name \"Glass\"" >/dev/null 2>&1 &
exit 0
