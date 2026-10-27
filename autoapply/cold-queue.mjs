#!/usr/bin/env node
// Cold-outreach queue, zero tokens. Hybrid, interleaved:
//   role    = fitting pending jobs the fast lane can't apply to (not Greenhouse/
//             Lever/Ashby/Workable/SmartRecruiters/Recruitee/BambooHR), so an email to a real person is the only way in.
//   startup = enabled portals.yml companies with no pending role, then YC startups from
//             data/cold-startups.json (yc-sync.mjs, hiring or not): a short speculative note.
// Skips blacklisted companies, companies applied to in the last 30 days, and
// any company already emailed or already tried by a cold worker.
// Output: kind \t company \t role \t url \t location
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { attemptRecords } from './runtime.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.env.AUTOAPPLY_MODE || 'live';
const read = p => existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '';
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Same title gates as prefilter.mjs.
const ATS = /jobs\.ashbyhq\.com|greenhouse\.io|gh_jid=|jobs\.(eu\.)?lever\.co|apply\.workable\.com|jobs\.smartrecruiters\.com|\.recruitee\.com|\.bamboohr\.com/i;
const TOO_SENIOR = /\b(staff|principal|lead|manager|director|head|vp|chief|architect|distinguished|fellow|phd|intern(ship)?|working student|werkstudent|apprentice|trainee)\b/i;
const OFF_TARGET = /\b(sales|account|marketing|recruit|designer|legal|finance|analyst|scientist|researcher|support|consultant|solutions engineer|ios|android|mobile|frontend|front-end|qa|test)\b/i;

const excluded = new Set(read('data/blacklist.md').split('\n').filter(l => l.startsWith('| ') && !l.includes('---')).map(l => norm(l.split('|')[1])));
for (const l of read('data/applications.md').split('\n')) {
  const c = l.split('|').map(x => x.trim());
  if (/^\d+$/.test(c[1] || '') && /applied|responded|interview|offer/i.test(c[6]) && (Date.now() - Date.parse(c[2])) / 864e5 < 30) excluded.add(norm(c[3]));
}
const OUT = join(ROOT, 'autoapply/outreach');
for (const f of existsSync(OUT) ? readdirSync(OUT).filter(f => f.endsWith('.json')) : []) {
  try { excluded.add(norm(JSON.parse(readFileSync(join(OUT, f), 'utf8')).company)); } catch {}
}
for (const r of attemptRecords(ROOT)) if (r.stage === 'cold' && r.mode === MODE) excluded.add(norm(r.company));

const pending = [];
for (const line of read('data/pipeline.md').split('\n')) {
  const m = line.match(/^- \[ \] (\S+) \| ([^|]+) \| ([^|]+)(?: \| ([^|]*?))?(?: \| posted: (\S+))?\s*$/);
  if (m) pending.push({ url: m[1], company: m[2].trim(), role: m[3].trim(), location: (m[4] || '').trim(), posted: m[5] || '' });
}
const withRole = new Set(pending.map(j => norm(j.company)));
const seen = new Set();
const once = c => !excluded.has(norm(c)) && !seen.has(norm(c)) && seen.add(norm(c));

const roles = pending.filter(j => !ATS.test(j.url) && !TOO_SENIOR.test(j.role) && !OFF_TARGET.test(j.role))
  .sort((a, b) => b.posted.localeCompare(a.posted)).filter(j => once(j.company));

// Rotate startups daily so each run reaches different companies.
const today = new Date().toISOString().slice(0, 10);
const rank = name => createHash('sha256').update(today + name).digest('hex');
const portals = existsSync(join(ROOT, 'portals.yml')) ? yaml.load(read('portals.yml')) : {};
const startups = (portals.tracked_companies || [])
  .filter(c => c.enabled !== false && c.name && c.careers_url && /^https?:/.test(c.careers_url) && !withRole.has(norm(c.name)))
  .sort((a, b) => rank(a.name).localeCompare(rank(b.name))).filter(c => once(c.name))
  .map(c => ({ company: c.name, role: 'Backend / Infrastructure Engineer (speculative)', url: c.careers_url, location: '' }));
// YC list is already ranked best-first; companies tried before drop out, so each run reaches new ones.
let yc = [];
try { yc = JSON.parse(read('data/cold-startups.json') || '[]'); } catch {}
startups.push(...yc.filter(c => c.name && c.website && !withRole.has(norm(c.name)) && once(c.name))
  .map(c => ({ company: c.name, role: 'Backend / Infrastructure Engineer (speculative)', url: c.website, location: c.location || '' })));

const out = [];
for (let i = 0; i < Math.max(roles.length, startups.length); i++) {
  if (roles[i]) out.push(['role', roles[i]]);
  if (startups[i]) out.push(['startup', startups[i]]);
}
for (const [kind, j] of out) console.log([kind, j.company, j.role, j.url, j.location].map(v => String(v).replace(/[\t\n]/g, ' ')).join('\t'));
