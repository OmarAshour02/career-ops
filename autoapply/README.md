# Autoapply runner

The shell entrypoints now delegate to `runner.mjs`. The first optimization pass
adds execution bounds, stable job/attempt identities, quota stopping and usage
records. It does **not** yet replace browser work with ATS adapters, switch model
providers, or integrate Simplify/Hunter. No token-saving percentage is claimed
until comparable real runs have been measured.

## Running

```sh
./autoapply/run-fast.sh --dry-run --limit 5 --parallel 1
./autoapply/run-apply.sh --dry-run --limit 5
./autoapply/run-outreach.sh --dry-run --limit 5
node autoapply/usage.mjs --dry-run
node autoapply/usage.mjs --day 2026-10-15 --json
```

Use `--live` only for the existing authorized application/outreach workflow.
Default is dry-run for the three worker entrypoints; `daily.sh` and `nonstop.sh`
retain their existing live defaults. Dry-run outreach never queues mail for later
delivery. A dry-run application can fill a form but must not submit it.

Supported limits: `--limit` (default 25, positive), `--parallel` (1, maximum 8),
`--max-turns` (40), `--timeout-ms` (600000), `--max-attempts` (2 per job/family/mode),
`--max-daily-attempts` (100 across worker stages, per mode), `--min-score` (3 for
outreach). Application and mail daily sending limits still come from
`config/apply-facts.yml`. Counters use UTC. `--model ID` or `AUTOAPPLY_MODEL`
selects a model; otherwise the current CLI default is preserved and the observed
model is logged. No automatic model switching.

The runner's limits are process-enforced. Prompt instructions are not the retry
or timeout mechanism. Jobs run at most once per batch. The daily attempt cap
includes failures; reaching an application cap cannot cause unlimited attempts.

## CAPTCHAs

Workers try to solve a CAPTCHA in the browser before giving up. They click the
widget, then `Read` a cropped screenshot of the challenge and click the matching
tiles or point with `browser_run_code_unsafe` (the exact snippets are in
`apply-prompt.md`). Limit: 3 puzzle rounds or 3 minutes. If it still fails (audio,
SMS, "press and hold", a Cloudflare loop or repeated wrong answers), the worker runs
`captcha-alert.sh`, waits up to 3 minutes for the owner, then records `skipped`
(reason `captcha`). `google-login.sh` reduces how often puzzles appear at all.

## Prescore (cheap fit check, opt-in)

`--prescore` (or `AUTOAPPLY_PRESCORE=1`) on the fast lane runs one OpenCode call
per job before any Claude browser worker starts. It reads the JD from the ATS API
(`fetch-jd.mjs`) plus `modes/_brief.md` and returns a score and hard-gate reason.

- Skip only on a stated hard gate or a score below `--prescore-min` (default 2.5).
  Skips are recorded as stage `prescore` attempts. They block re-scoring but do not
  count toward `--limit` or `--max-daily-attempts`. `--max-prescore` (150) caps calls.
- No JD, model error or unparseable reply means "unknown": the normal worker runs.
  Three errors in a row turn prescore off for that batch. Prescore errors never
  write `provider-block.json`.
- Passing jobs hand their fetched JD to the worker (`attempts/<id>/jd.md`).
- Model: `AUTOAPPLY_PRESCORE_MODEL` (default `opencode/deepseek-v4.1-flash-free`).
- Paid fallback: if the free model fails for a provider reason (e.g. OpenCode
  blocks the IP), it is paused for 2h and `AUTOAPPLY_PRESCORE_FALLBACK` (default
  `deepseek/deepseek-v4-flash`) is used instead. Only runs when `DEEPSEEK_API_KEY`
  is set (env or `.env`). `AUTOAPPLY_PRESCORE_MAX_PAID` (default 150) caps paid
  calls per UTC day. Daily state: `autoapply/logs/prescore-budget-<day>.json`.
  Binary: `AUTOAPPLY_OPENCODE_BIN`, else `~/.opencode/bin/opencode`, else PATH.
- Safety: the call runs in an empty temp directory whose `opencode.json` denies
  shell, edit, write, web and external-directory tools. Its OpenCode session
  (which holds the JD and brief) is deleted after usage is read. Free models may
  keep prompts on the provider side; only the public JD and `_brief.md` are sent.

Check accuracy against past Claude decisions before turning it on in `daily.sh`:

```sh
node autoapply/prescore-bench.mjs --parallel 4 [--min 3.0] [--limit N]
```

The report lands in `autoapply/logs/prescore-bench-*.json`.

## Cold outreach (daily, hybrid)

`run-cold.sh` (stage `cold`) emails companies you have not applied to. `cold-queue.mjs`
(zero tokens) interleaves two kinds: `role` = fitting pending jobs on sites the fast lane
can't apply through; `startup` = enabled `portals.yml` companies with no pending role,
rotated daily. Blacklisted, recently applied, already-emailed and already-tried companies
are skipped. Workers follow `cold-prompt.md` (no browser) and write drafts to
`autoapply/outreach/c<id>.json` in live mode only.

Draft count = 4 × the room left under today's send cap (`mail.py room`), max 60, since
most companies end as `no_contact`. Sending goes through `mail.py send`: 25/day total
(applications outreach + cold + follow-ups), 120s apart, each address checked for a mail
server (and by Hunter when a key exists). Mail stages have their own daily attempt budget,
separate from applications.

## Hunter (outreach contact lookup, off until a key exists)

`hunter.mjs` calls the Hunter.io API (domain search, email finder, verifier) with no
model tokens. Add `HUNTER_API_KEY=...` to `career-ops/.env` to turn it on; without
it the script exits 3 and the outreach worker uses public-web search as before.
The worker uses at most 3 calls per job. A Hunter address counts as real only with
a source URL or a `valid` finder result (rule 3 in `outreach-prompt.md`).

## Stopping and recovery

`touch autoapply/.nonstop.stop` stops new dispatch; already-running workers settle.
It also prevents direct worker batches and daily scans. Remove that marker when
ready to resume. The optimization rollout left it present after stopping the old
runaway loop; it does not restart jobs automatically.

Provider quota, authentication and missing-worker errors create
`autoapply/provider-block.json`. All worker entrypoints respect this file. Fix
the underlying issue or wait for the actual provider reset, then explicitly run:

```sh
node autoapply/runner.mjs unblock
```

This clears only the provider breaker. It does not clear the stop marker or
unblock uncertain applications. The runner does not guess reset times or silently
buy credits. Nonstop/daily exit on worker errors instead of continuing to dispatch.

An interrupted live worker with model activity is `uncertain` when there is no
validated result. A crash can leave `started`. Both block reapplication. Verify
the portal/confirmation before resolving such attempts; never delete the ledger
to force retries. Missing usage is reported as unavailable, not zero. Submitted
results require a saved confirmation artifact. Confirmation content still relies
on the worker's interpretation and is not independently authenticated by the runner.

`reconciliation_error` means a result was obtained but tracker publication failed.
Reconcile the stored payload through the core tracker commands without rerunning
the application. Existing legacy failures and mismatches are preserved rather
than silently repaired or retried.

## Identity and records

- Job ID: normalized job URL hash, retaining requisition query parameters.
- Attempt ID: UUID for every execution; fast/apply share application deduplication.
- Report IDs reserve against tracker entries, reports, legacy results and attempts.
- `attempts/<UUID>/record.json`: identity, stage, outcome, errors, timestamps, usage.
- `payload.json`: worker result, accepted only with matching job/attempt identity.
- `events.jsonl`: raw CLI output (may contain plain stderr as well as JSON).
- `logs/batch-<UUID>.json`: batch outcome, including blocked/empty batches.
- Existing numbered results/outreach are published only after validation, in live
  mode. Failed attempts do not overwrite another job's legacy result.

The shared runner lock serializes batches across entrypoints. Workers within one
batch can run concurrently. Pipeline edits use the core pipeline lock; tracker
writes use merge-tracker/set-status, with explicit row versus report selectors.
Mail commands use a separate OS lock. Send intent and message ID are persisted
before SMTP; interrupted/uncertain sends are not retried automatically. This is
duplicate prevention, not an exactly-once delivery guarantee.

## Measurement

`usage.mjs` and the daily summary report per stage/mode/date:

- Attempts, outcome counts, categorized failures and missing usage.
- Fresh input, cache creation, cached reads and output separately.
- Observed models, model messages, tool calls, median first-request input size.
- Summed worker duration (not batch wall time).
- Known CLI dollar estimates and missing-cost count; cost per confirmed submission
  only when every attempt in that stage has cost information.

Terminal aggregate usage takes precedence over streamed message usage. Repeated
message/tool IDs are deduplicated. Partial transcripts are labeled partial.
`fast` combines evaluation and application; it is not an exact per-browser-action
cost breakdown. CLI cost estimates are not subscription billing charges. Historical
logs are not silently mixed into these new metrics.

## Offline validation

```sh
node --test tests/autoapply/*.test.mjs
python3 -I autoapply/mail_test.py
```

Tests use temporary roots, fake model executables and mocked SMTP. They exercise
quota stopping, parallel dispatch, ID collisions, mismatched output, isolated
stdin, bounded retries, timeouts, uncertain outcomes, dry runs, locks, usage
aggregation and interrupted sends. They submit no applications and send no mail.
