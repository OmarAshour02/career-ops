#!/usr/bin/env bash
# Daily cold outreach: draft only as many emails as today's send cap still has room for
# (about 4 drafts per free slot: without a Hunter key ~1 in 5 companies has a real
# public address), then send.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE=dry-run
for arg in "$@"; do
  case "$arg" in --live) MODE=live;; --dry-run) MODE=dry-run;; esac
done
ROOM=$(python3 -I autoapply/mail.py room)
DRAFTS=$(( ROOM * 4 > 60 ? 60 : ROOM * 4 ))
if [[ "$MODE" == live && "$DRAFTS" -le 0 ]]; then echo "cold: send cap already used today"; exit 0; fi
[[ "$DRAFTS" -gt 0 ]] || DRAFTS=5
node autoapply/runner.mjs cold --limit "$DRAFTS" "$@"
# Never invoke the sender in a dry run; previews live in attempt payloads.
if [[ "$MODE" == live && ! -f autoapply/.nonstop.stop ]]; then
  python3 -I autoapply/mail.py send
fi
