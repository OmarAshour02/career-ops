#!/usr/bin/env bash
# Runs every 30 minutes from the schedule. When a run stopped on the Claude usage limit
# (autoapply/provider-block.json, reason quota_exhausted), try one tiny Claude call; once it
# works again, clear the block and start the daily run. Any other block (login, auth) still needs the owner.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
NVM_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
BLOCK=autoapply/provider-block.json
[[ -f $BLOCK ]] || exit 0
grep -q '"reason": *"quota_exhausted"' "$BLOCK" || exit 0
[[ ! -f autoapply/.nonstop.stop ]] || exit 0
[[ ! -d autoapply/.workflow.lock ]] || exit 0 # a run is still going
mkdir -p autoapply/logs
exec >> autoapply/logs/quota-watch.log 2>&1
MODEL=$(node autoapply/profile.mjs model apply 2>/dev/null || true)
# perl alarm: a hung probe must not keep this job alive (macOS has no `timeout`).
OUT=$(perl -e 'alarm shift; exec @ARGV' 120 "${AUTOAPPLY_CLAUDE_BIN:-claude}" -p "Reply with just: ok" ${MODEL:+--model "$MODEL"} --tools "" 2>&1)
if [[ $? -ne 0 || ! $OUT =~ ^[[:space:]]*ok ]]; then
  echo "[$(date)] still limited: $(echo "$OUT" | head -1 | cut -c1-120)"; exit 0
fi
echo "[$(date)] limit is back: clearing the block and starting the daily run"
node autoapply/runner.mjs unblock
exec /bin/bash autoapply/daily.sh
