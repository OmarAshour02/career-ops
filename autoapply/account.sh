#!/bin/bash
# Job-site account passwords, kept in the macOS login Keychain (one random password per site).
#   autoapply/account.sh get <site>   print the saved password; exit 1 if this site has none
#   autoapply/account.sh new <site>   make + save a password (or print the saved one)
#   autoapply/account.sh list         sites with an account (no passwords)
# <site> is the hostname of the job site, e.g. acme.wd5.myworkdayjobs.com or amazon.jobs.
# The list of sites (never the passwords) is kept in autoapply/accounts.tsv.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/accounts.tsv"
EMAIL="$(grep -m1 -E '^[[:space:]]+email:' "$HERE/../config/apply-facts.yml" | sed -E 's/^[^:]+:[[:space:]]*"?([^"#]*)"?.*/\1/' | xargs)"
[ -n "$EMAIL" ] || { echo "no contact.email in config/apply-facts.yml" >&2; exit 2; }
cmd="${1:-}"; site="$(printf '%s' "${2:-}" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*##')"
service() { printf 'career-ops job site %s' "$site"; }

case "$cmd" in
  get)
    [ -n "$site" ] || { echo "usage: account.sh get <site>" >&2; exit 2; }
    security find-generic-password -s "$(service)" -a "$EMAIL" -w 2>/dev/null || { echo "no account for $site" >&2; exit 1; }
    ;;
  new)
    [ -n "$site" ] || { echo "usage: account.sh new <site>" >&2; exit 2; }
    if pw="$(security find-generic-password -s "$(service)" -a "$EMAIL" -w 2>/dev/null)"; then echo "$pw"; exit 0; fi
    # 16 random letters/digits plus a fixed upper, lower, digit and symbol: passes the usual site rules.
    pw="$(set +o pipefail; LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)Aa7!" # head closing the pipe is fine here
    security add-generic-password -s "$(service)" -a "$EMAIL" -w "$pw" -U
    [ -f "$LOG" ] || printf 'site\temail\tcreated\n' > "$LOG"
    printf '%s\t%s\t%s\n' "$site" "$EMAIL" "$(date +%F)" >> "$LOG"
    echo "$pw"
    ;;
  list)
    [ -f "$LOG" ] && cut -f1,3 "$LOG" | tail -n +2 || true
    ;;
  *) echo "usage: account.sh get|new <site> | list" >&2; exit 2 ;;
esac
