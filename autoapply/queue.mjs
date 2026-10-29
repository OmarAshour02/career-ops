#!/usr/bin/env node
// Build the auto-apply queue from data/applications.md + reports/.
// Gates: status Evaluated, score >= min_score, supported ATS, not blacklisted, not in process (in-process.mjs),
// no Applied row for the same company in the last N days, not already attempted.
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { inProcessCompanies } from './in-process.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');

const facts = read('config/apply-facts.yml');
const num = (key, dflt) => Number((facts.match(new RegExp(`${key}:\\s*([\\d.]+)`)) || [])[1] ?? dflt);
const MIN_SCORE = num('min_score', 3.5);
const COMPANY_DAYS = num('max_per_company_per_30_days', 1) ? 30 : 0;

const ATS = [/greenhouse\.io|gh_jid=/i, /jobs\.(eu\.)?lever\.co/i, /jobs\.ashbyhq\.com/i, /apply\.workable\.com/i, /jobs\.smartrecruiters\.com/i, /\.recruitee\.com/i, /\.bamboohr\.com/i];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const blacklist = existsSync(join(ROOT, 'data/blacklist.md'))
  ? read('data/blacklist.md').split('\n').filter((l) => l.startsWith('| ') && !l.includes('---'))
      .map((l) => norm(l.split('|')[1])).filter((c) => c && c !== 'company')
  : [];

// A job counts as attempted once it has a live result file, except needs_answer
// results older than apply-facts.yml (you answered the question -> retry it).
const RES = join(ROOT, 'autoapply/results');
const factsMtime = statSync(join(ROOT, 'config/apply-facts.yml')).mtimeMs;
const attempted = new Set(
  existsSync(RES) ? readdirSync(RES).filter((f) => /^\d+\.json$/.test(f)).filter((f) => {
    try {
      const r = JSON.parse(readFileSync(join(RES, f), 'utf-8'));
      return !(r.status === 'needs_answer' && statSync(join(RES, f)).mtimeMs < factsMtime);
    } catch { return true; }
  }).map((f) => f.split('.')[0]) : []
);

const rows = (existsSync(join(ROOT, 'data/applications.md')) ? read('data/applications.md') : '').split('\n')
  .filter((l) => /^\|\s*\d+\s*\|/.test(l))
  .map((l) => {
    const c = l.split('|').map((x) => x.trim());
    return { num: c[1], date: c[2], company: c[3], role: c[4], score: parseFloat(c[5]), status: c[6], report: c[8] };
  });

const inProcess = inProcessCompanies(ROOT);
const now = Date.now();
const recentApplied = new Set(rows
  .filter((r) => /applied|responded|interview|offer/i.test(r.status) && (now - Date.parse(r.date)) / 864e5 < COMPANY_DAYS)
  .map((r) => norm(r.company)));

const out = [];
for (const r of rows) {
  if (!/^evaluated$/i.test(r.status) || !(r.score >= MIN_SCORE)) continue;
  if (attempted.has(r.num.padStart(3, '0'))) continue;
  if (blacklist.includes(norm(r.company))) continue;
  if (inProcess.has(norm(r.company))) continue;
  if (recentApplied.has(norm(r.company))) continue;
  const reportPath = (r.report.match(/\(\.\.\/(reports\/[^)]+)\)/) || [])[1];
  if (!reportPath || !existsSync(join(ROOT, reportPath))) continue;
  const rep = read(reportPath);
  const url = (rep.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1];
  const pdf = (rep.match(/^\*\*PDF:\*\*\s*(\S+)/m) || [])[1];
  if (!url || !ATS.some((re) => re.test(url))) continue;
  if (/❌|no sponsorship|does not sponsor/i.test((rep.match(/^\*\*Work Auth:\*\*(.*)$/m) || [])[1] || '')) continue;
  recentApplied.add(norm(r.company)); // one per company per run
  out.push({ score: r.score, line: [r.num.padStart(3, '0'), r.company, r.role, r.score, url, reportPath, pdf || ''].join('\t') });
}
const limit = Number(process.argv[2] || 0);
out.sort((a, b) => b.score - a.score);
const lines = out.map((o) => o.line);
console.log((limit ? lines.slice(0, limit) : lines).join('\n'));
