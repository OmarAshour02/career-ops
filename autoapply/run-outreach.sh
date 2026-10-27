#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE=dry-run
for arg in "$@"; do
  case "$arg" in --live) MODE=live;; --dry-run) MODE=dry-run;; esac
done
node autoapply/runner.mjs outreach "$@"
# Never invoke the sender in a dry run; previews live in attempt payloads.
if [[ "$MODE" == live && ! -f autoapply/.nonstop.stop ]]; then
  python3 -I autoapply/mail.py check
  python3 -I autoapply/mail.py send
fi
