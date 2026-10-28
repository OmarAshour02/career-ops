#!/usr/bin/env node
// Daily summary of auto-apply + outreach (markdown on stdout).
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { usageSummary, formatUsage } from './usage.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const day = process.argv[2] || new Date().toISOString().slice(0, 10);
const load = (d) => existsSync(join(ROOT, d)) ? readdirSync(join(ROOT, d)).filter((f) => /^\d+\.json$/.test(f))
  .map((f) => { try { return JSON.parse(readFileSync(join(ROOT, d, f), 'utf-8')); } catch { return null; } }).filter(Boolean) : [];
const res = load('autoapply/results').filter((r) => String(r.finished_at).startsWith(day));
const out = load('autoapply/outreach');
const by = (s) => res.filter((r) => r.status === s);
const lines = [`# Auto-apply summary ${day}`, ''];
lines.push(`**Applied:** ${by('submitted').length} · **Skipped:** ${by('skipped').length} · **Need your answer:** ${by('needs_answer').length} · **Failed:** ${by('failed').length}`, '');
if (by('submitted').length) { lines.push('## Applied'); for (const r of by('submitted')) lines.push(`- ${r.company} — ${r.role} (score ${r.score ?? '?'})`); lines.push(''); }
if (by('needs_answer').length) { lines.push('## Questions for you (answer once, saved to config/apply-facts.yml)'); for (const r of by('needs_answer')) for (const q of r.questions_missing || []) lines.push(`- ${r.company}: ${q}`); lines.push(''); }
const reasons = {}; for (const r of by('skipped')) { const k = String(r.reason || '?').split(/[:(]/)[0].trim(); reasons[k] = (reasons[k] || 0) + 1; }
if (Object.keys(reasons).length) lines.push('## Skip reasons', ...Object.entries(reasons).map(([k, v]) => `- ${k}: ${v}`), '');
const spam = by('skipped').filter((r) => /^spam_flagged/i.test(String(r.reason || '')));
if (spam.length) { lines.push('## WARNING: flagged as spam (that site was stopped for the day)'); for (const r of spam) lines.push(`- ${r.company} — ${r.role}: ${r.url}`); lines.push(''); }
const captcha = by('skipped').filter((r) => /^captcha/i.test(String(r.reason || '')));
if (captcha.length) { lines.push('## CAPTCHA: still unsolved (apply by hand)'); for (const r of captcha) lines.push(`- ${r.company} — ${r.role}: ${r.url}`); lines.push(''); }
if (by('failed').length) { lines.push('## Failed'); for (const r of by('failed')) lines.push(`- ${r.company}: ${r.reason}`); lines.push(''); }
const sentToday = out.filter((d) => String(d.sent_at || '').startsWith(day));
const fuToday = out.filter((d) => String(d.followup_at || '').startsWith(day));
const inbox = existsSync(join(ROOT, 'autoapply/inbox/events.json')) ? JSON.parse(readFileSync(join(ROOT, 'autoapply/inbox/events.json'), 'utf-8')) : [];
const moved = inbox.filter((e) => e.status_to && String(e.date).startsWith(day));
if (moved.length) { lines.push('## Status changes from email'); for (const e of moved) lines.push(`- ${e.company} — ${e.role}: ${e.status_from} -> **${e.status_to}** (${e.reason})`); lines.push(''); }
lines.push(`## Outreach`, `- Emails sent today: ${sentToday.length} · follow-ups: ${fuToday.length}`);
for (const d of sentToday) lines.push(`  - ${d.company}: ${d.to_name} (${d.to_title}) <${d.to_email}>`);
const replies = out.filter((d) => d.replied_at);
lines.push(`- Total replies so far: ${replies.length}`); for (const d of replies) lines.push(`  - **${d.company}: ${d.to_name} replied** (${String(d.replied_at).slice(0, 10)})`);
const bounced = out.filter((d) => d.bounced); if (bounced.length) lines.push(`- Bounced: ${bounced.map((d) => d.company).join(', ')}`);
lines.push('', '## Worker usage', '', formatUsage(usageSummary(ROOT, { day })));
console.log(lines.join('\n'));
