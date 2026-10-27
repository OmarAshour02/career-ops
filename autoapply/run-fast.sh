#!/usr/bin/env bash
# Compatibility entrypoint. Shared runner owns dispatch, identities and telemetry.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node autoapply/runner.mjs fast "$@"
