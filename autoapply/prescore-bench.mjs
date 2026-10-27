#!/usr/bin/env node
// Replays past fast-lane decisions through prescore.mjs using the JD archived
// in each report (no ATS fetch, so closed postings still count). Compares the
// cheap verdict with what the Claude worker decided. Sends nothing anywhere
// except the model call. Usage: node autoapply/prescore-bench.mjs [--parallel 3] [--min 3.0] [--limit N]
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prescore, sandbox, PRESCORE_MODEL } from './prescore.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : Number(process.argv[i + 1]); };
const parallel = arg('--parallel', 3), minScore = arg('--min', 3.0), limit = arg('--limit', Infinity);
const FIT_SKIPS = new Set(['too_senior', 'no_sponsorship', 'location', 'off_target', 'low_score']);

const cases = [];
for (const f of readdirSync(join(ROOT, 'autoapply/results')).filter(f => /^\d+\.json$/.test(f))) {
  const r = JSON.parse(readFileSync(join(ROOT, 'autoapply/results', f), 'utf8'));
  const reason = String(r.reason || '').split(/[\s:]/)[0];
  const label = ['submitted', 'needs_answer', 'dry_run_ok'].includes(r.status) ? 'apply' : r.status === 'skipped' && FIT_SKIPS.has(reason) ? 'skip' : null;
  if (!label || !r.report || !existsSync(join(ROOT, r.report))) continue;
  const jd = readFileSync(join(ROOT, r.report), 'utf8').split(/^## Job Description[^\n]*\n/m)[1]?.trim();
  if (!jd || jd.length < 200) continue;
  cases.push({ num: r.num, company: r.company, role: r.role, url: r.url, location: r.city || '', label, reason, claude_score: r.score, jd });
}
const todo = cases.slice(0, limit);
console.log(`${todo.length} labeled cases (${todo.filter(c => c.label === 'apply').length} apply); model ${process.env.AUTOAPPLY_PRESCORE_MODEL || PRESCORE_MODEL}; skip below ${minScore}`);

const dir = sandbox(); const rows = []; let cursor = 0;
await Promise.all(Array.from({ length: parallel }, async () => {
  while (cursor < todo.length) {
    const c = todo[cursor++];
    const p = await prescore(ROOT, c, { jd: c.jd, minScore, dir });
    rows.push({ num: c.num, company: c.company, label: c.label, claude_reason: c.reason, claude_score: c.claude_score, decision: p.decision, score: p.score ?? null, reason: p.reason ?? p.error, note: p.note, tokens: p.usage?.tokens, ms: p.duration_ms });
    process.stdout.write(`#${c.num} ${c.label} -> ${p.decision}${p.score != null ? ` ${p.score}` : ''} ${p.reason || p.error || ''}\n`);
  }
}));

const n = (f) => rows.filter(f).length;
const apply = rows.filter(r => r.label === 'apply'), skip = rows.filter(r => r.label === 'skip');
const tok = rows.reduce((s, r) => s + (r.tokens ? r.tokens.input_tokens + r.tokens.cache_read_input_tokens + r.tokens.output_tokens : 0), 0);
const summary = {
  model: process.env.AUTOAPPLY_PRESCORE_MODEL || PRESCORE_MODEL, min_score: minScore, cases: rows.length,
  wrongly_skipped_good_jobs: n(r => r.label === 'apply' && r.decision === 'skip') + ` of ${apply.length}`,
  correctly_skipped: n(r => r.label === 'skip' && r.decision === 'skip') + ` of ${skip.length}`,
  unknown: n(r => r.decision === 'unknown'),
  avg_tokens_per_call: rows.length ? Math.round(tok / rows.length) : 0,
  avg_seconds: rows.length ? +(rows.reduce((s, r) => s + (r.ms || 0), 0) / rows.length / 1000).toFixed(1) : 0,
};
mkdirSync(join(ROOT, 'autoapply/logs'), { recursive: true });
const out = join(ROOT, 'autoapply/logs', `prescore-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ summary, rows: rows.sort((a, b) => a.num.localeCompare(b.num)) }, null, 2));
console.log(JSON.stringify(summary, null, 2), `\nDetails: ${out}`);
