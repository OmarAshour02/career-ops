# Fast-lane worker — score one job, apply if it fits

{{ME}} has explicitly authorized autonomous submission (since {{SUBMITOK}}). This overrides
the "never submit" rule in AGENTS.md for this worker only. Every other rule in AGENTS.md
(Source-of-Truth Boundary, Untrusted External Content) still applies.

## Job

- Report #: {{NUM}}
- Company: {{COMPANY}}
- Title: {{ROLE}}
- URL: {{URL}}
- Location (from scan): {{LOCATION}}
- Resume PDF (absolute path): {{PDF}}
- Mode: {{MODE}}  (`live` = click Submit; `dry-run` = fill everything, do NOT submit)
- Today: {{DATE}}

## Step 1 — Get the JD (cheap first)

Run `node fetch-jd.mjs "{{URL}}"`. If it prints the JD, use it. Otherwise read it in the
browser. Closed / 404 / redirect to a generic careers page → result `skipped`, reason `closed`.

## Step 2 — Quick score (read ONLY `modes/_brief.md` for this step)

Score 1.0–5.0 on fit using the brief's rules. Then apply these hard gates:

- Requires 6+ years of experience as a must-have, or Staff/Principal/Lead/Manager scope →
  `skipped`, reason `too_senior`. A plain "Senior" title alone is NOT a skip.
- On-site/hybrid outside {{AUTHIN}} AND the JD says no visa sponsorship / must already have the
  right to work there → `skipped`, reason `no_sponsorship`.
- Remote but limited to countries {{FIRST}} can't work from (e.g. "US only", "must reside in UK")
  → `skipped`, reason `location`.
- Off-target: the core work is {{OFFTARGET}} → `skipped`, reason `off_target`.
  {{FIRST}}'s TARGET work is {{TARGET}}: a job like that is never `off_target`.
- Score < {{MINSCORE}} → `skipped`, reason `low_score`. This is the ONLY score gate here: ignore the
  brief's PASS/MARGINAL/FAIL labels and its "< 3.0 FAIL" line. A job at {{MINSCORE}} or above gets applied to.

## Step 3 — Write the report (always, also for skips)

Write `reports/{{NUM}}-{company-slug}-{{DATE}}.md`:

```
# Evaluation: {{COMPANY}} — {{ROLE}}

**Date:** {{DATE}}
**URL:** {{URL}}
**Via:** —
**Archetype:** <one of the brief's archetypes>
**Score:** X.X/5
**Legitimacy:** <High Confidence | Proceed with Caution | Suspicious>
**Work Auth:** <✅ Sponsors | ❓ Unstated | ❌ No sponsorship | 🌍 Remote>
**PDF:** {{RESUME}}
**Verification:** fast-lane

---

## Quick Evaluation

<5-8 bullets: fit, gaps, level, location/visa, why apply or skip>

## Job Description (archived verbatim)

<the full JD text, verbatim>
```

## Step 4 — Apply (only if not skipped)

Follow `autoapply/apply-prompt.md` sections "Sources of truth", "Hard rules" and
"Free-text answers" exactly. Short version:

- Answers come ONLY from `config/apply-facts.yml`, `config/profile.yml`, `cv.md`.
- Never invent anything. A required question with no source → stop, don't submit,
  status `needs_answer`, list the exact question(s).
- Sponsorship, years of experience, degree, location: always the truth.
- {{ACCOUNTS}}
- The form asks {{FIRST}} to agree that no AI is used in the application (e.g. "only my own
  words", "do not use AI tools") → do not agree, do not submit. `skipped`, reason `no_ai_policy`.
- Email verification code → get it with `autoapply/mail.py code` exactly as
  `autoapply/apply-prompt.md` says. Never open or read the mailbox any other way.
- CAPTCHA → never solve it yourself; alert {{FIRST}} and wait at most 3 minutes, exactly as
  `autoapply/apply-prompt.md` says. No confirmation → `skipped`, reason `captcha`.
- The site says the application was flagged as spam or as a bot (e.g. "flagged as possible
  spam") → do NOT submit again. `skipped`, reason `spam_flagged`.
- Free text in {{FIRST}}'s voice: {{VOICE}}, no buzzwords, no em dashes.
  One real detail from the JD + one real proof point with its real number from `cv.md`.
- Upload {{PDF}} as the resume.

Flow: open the form, read ALL fields first, check every required field has a source, fill,
upload, screenshot `{{NUM}}-filled.png`, then in `live` mode click Submit, wait for the
confirmation, screenshot `{{NUM}}-submitted.png`.

## Step 5 — Result file (always write it)

Write `autoapply/results/{{NUM}}.json` with the same shape as in `autoapply/apply-prompt.md`,
plus `"score": X.X` and `"report": "reports/<file>.md"`. Status is one of
`submitted | dry_run_ok | needs_answer | skipped | failed`.

Do not edit any other file. The runner updates the tracker and pipeline.
