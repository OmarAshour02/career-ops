#!/usr/bin/env bash
# Daily auto-apply run: scan -> fast-lane apply -> inbox status sync -> outreach -> cold outreach -> follow-ups -> reply check -> report.
# Usage: autoapply/daily.sh [--dry-run]   (default: live)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# Schedulers start with a bare PATH: add the usual Node/Claude/opencode homes (nvm, Homebrew, Linuxbrew) when present.
NVM_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:${NVM_BIN:+$NVM_BIN:}/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
MODE=--live; [[ "${1:-}" == --dry-run ]] && MODE=--dry-run
TODAY=$(date -u +%F); LOG="autoapply/logs/daily-$TODAY.log"
mkdir -p autoapply/logs
exec >> "$LOG" 2>&1
[[ ! -f autoapply/.nonstop.stop ]] || { echo "Dispatch is stopped (autoapply/.nonstop.stop)."; exit 0; }
[[ ! -f autoapply/provider-block.json ]] || { echo "Provider blocked; resolve access before restarting."; exit 75; }
LOCK=autoapply/.workflow.lock
if ! mkdir "$LOCK" 2>/dev/null; then echo "[$(date)] already running"; exit 0; fi
trap 'rmdir "$LOCK"' EXIT

echo "===== $(date) daily run ($MODE) ====="
echo "--- scan (curated portals)";  node scan.mjs | tail -3
echo "--- scan (all GH/Lever/Ashby boards, last 30 days)"
node scan-ats-full.mjs --ats greenhouse,lever,ashby --since 30 | tail -3
echo "--- fast lane";   ./autoapply/run-fast.sh $MODE --parallel 4 --limit 400 --max-daily-attempts 400 --max-prescore 600 --max-turns 60 --prescore --model "$(node autoapply/profile.mjs model apply)" || echo "fast lane halted (exit $?); continuing"
echo "--- resumes";     node autoapply/snapshot-resumes.mjs || echo "resume snapshot failed (exit $?); continuing"
echo "--- replies";     [[ $MODE != --live ]] || python3 -I autoapply/mail.py check || echo "mail check failed (exit $?); continuing"
echo "--- inbox";       [[ $MODE != --live ]] || node autoapply/inbox-sync.mjs || echo "inbox sync failed (exit $?); continuing"
echo "--- outreach";    ./autoapply/run-outreach.sh $MODE --parallel 2 --model "$(node autoapply/profile.mjs model outreach)" || echo "outreach step failed (exit $?); continuing"
# Cold outreach on/off: schedule.cold_outreach in config/apply-facts.yml (Settings in the desktop app).
if [[ "$(node autoapply/profile.mjs get schedule.cold_outreach)" == true ]]; then
  echo "--- yc startups";  node autoapply/yc-sync.mjs || echo "yc sync failed (exit $?); continuing"
  echo "--- cold outreach"; ./autoapply/run-cold.sh $MODE --parallel 3 --model "$(node autoapply/profile.mjs model outreach)" || echo "cold outreach failed (exit $?); continuing"
else
  echo "--- cold outreach: off in settings"
fi
echo "--- follow-ups";  [[ $MODE != --live ]] || python3 -I autoapply/mail.py followup || echo "mail followup failed (exit $?); continuing"
echo "--- summary";     node autoapply/summary.mjs | tee "autoapply/summary-$TODAY.md"
echo "===== $(date) done ====="
