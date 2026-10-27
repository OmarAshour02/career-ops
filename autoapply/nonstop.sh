#!/usr/bin/env bash
# Nonstop loop: keep applying (fast lane) and sending outreach within the daily caps.
# Stop with: touch autoapply/.nonstop.stop   (or kill the process)
# Usage: autoapply/nonstop.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# Schedulers start with a bare PATH: add the usual Node/Claude/opencode homes (nvm, Homebrew, Linuxbrew) when present.
NVM_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
LOCK=autoapply/.workflow.lock
mkdir "$LOCK" 2>/dev/null || { echo "already running"; exit 0; }
trap 'rmdir "$LOCK"' EXIT

while [[ ! -f autoapply/.nonstop.stop ]]; do
  echo "===== $(date) cycle ====="
  if OUT=$(./autoapply/run-fast.sh --live --parallel 4 --limit 400 --max-daily-attempts 400 --max-prescore 600 --max-turns 200 --timeout-ms 1500000 --prescore --model claude-haiku-5-5 2>&1); then
    echo "$OUT"
  else
    code=$?; echo "$OUT"; echo "Runner halted (exit $code); inspect provider-block.json and attempt records."
    exit "$code"
  fi
  [[ ! -f autoapply/.nonstop.stop ]] || break
  if echo "$OUT" | grep -q "Batch: 0 attempts\|daily_cap"; then
    echo "--- refreshing job feed"
    node scan-ats-full.mjs --ats greenhouse,lever,ashby --since 30 2>&1 | tail -3
    # Wait an hour before checking again; the daily cap resets at midnight.
    for _ in $(seq 1 60); do [[ -f autoapply/.nonstop.stop ]] && break; sleep 60; done
    continue
  fi
  ./autoapply/run-outreach.sh --live --parallel 2 --model claude-haiku-5-5 2>&1 | tail -n 20 || echo "outreach step failed (exit $?); continuing"
  python3 -I autoapply/mail.py check || echo "mail check failed (exit $?); continuing"
  python3 -I autoapply/mail.py followup || echo "mail followup failed (exit $?); continuing"
  sleep 30
done
echo "stopped $(date)"
