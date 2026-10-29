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

Before interacting with the application form, Read `{{APPLYRULES}}` ONCE and follow
ALL of its source-of-truth, hard, free-text, browser, result and evidence rules.
This is the complete apply-prompt.md rendered for this attempt, including the correct
resume path, account rules, mode and result destination. Do not also read the raw template.
No invented facts. Confirm every required field against sources before filling;
unknown required facts on the live form → `needs_answer`. Dry-run never submits.

## Step 5 — Result file (always write it)

Write `autoapply/results/{{NUM}}.json` with the same shape as in `{{APPLYRULES}}`,
plus `"score": X.X` and `"report": "reports/<file>.md"`. Status is one of
`submitted | dry_run_ok | needs_answer | skipped | failed`.

Do not edit any other file. The runner updates the tracker and pipeline.
