#!/usr/bin/env node
// Fast-lane queue: pending URLs in data/pipeline.md -> cheap filters, zero tokens.
// Keeps: Greenhouse/Lever/Ashby/Workable/SmartRecruiters/Recruitee/BambooHR (plus account sites such as Workday,
// iCIMS and companies' own career sites once consent.create_accounts_since is set), non-staff titles, not blacklisted, at most
// PER_COMPANY applications per company per 30 days and per run (big companies: their own cap), newest first.
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { roleFuzzyMatch } from '../role-matcher.mjs';
import { attemptRecords, normalizeUrl } from './runtime.mjs';
import { inProcessCompanies } from './in-process.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const urlKey = (u) => { try { return normalizeUrl(u); } catch { return u; } };
// Roles already in the tracker or results, by company. The same role posted once per country
// ("Engineer (Portugal)", "Engineer (m/f/d)") is one application: match roles the way
// merge-tracker does, or a second copy gets merged into the first row and reconcile fails.
// The matcher drops some place names and keeps others, so strip location parts first:
// a bracketed, dash or comma segment made only of place words, or a gender tag.
const PLACE = /\b(remote|hybrid|on-?site|anywhere|worldwide|global|distributed|europe|emea|eu|uk|us|usa|latam|apac|americas|portugal|poland|germany|netherlands|spain|france|italy|ireland|united kingdom|united states|canada|mexico|brazil|argentina|colombia|india|singapore|japan|australia|romania|greece|egypt|uae|israel|switzerland|austria|belgium|sweden|denmark|norway|finland|estonia|lithuania|latvia|czech republic|czechia|czech|hungary|slovakia|slovenia|luxembourg|iceland|montenegro|albania|bosnia|north macedonia|macedonia|moldova|belarus|kosovo|monaco|liechtenstein|andorra|morocco|tunisia|saudi arabia|ksa|qatar|kuwait|bahrain|oman|kenya|nigeria|south africa|philippines|vietnam|indonesia|malaysia|thailand|pakistan|chile|peru|uruguay|costa rica|new zealand|south korea|korea|china|hong kong|taiwan|bulgaria|serbia|croatia|ukraine|turkey|georgia|armenia|cyprus|malta|london|berlin|munich|amsterdam|paris|madrid|barcelona|lisbon|warsaw|krakow|dublin|zurich|new york|nyc|san francisco|sf|toronto|dubai|cairo|bangalore|tel aviv|prague|budapest|bucharest|vienna|stockholm|copenhagen|oslo|helsinki|tallinn)\b/gi;
const GENDER = /^\s*(?:[mfwdx]|div)(?:\s*\/\s*(?:[mfwdx]|div))+\s*$/i;
const baseTitle = (title, location = '') => {
  // A segment is a location only if nothing but place words is left in it.
  const isPlace = (seg) => GENDER.test(seg) || !seg.replace(PLACE, '').replace(/[\s,·|/&–—-]+/g, '')
    || (location && seg.trim().length >= 2 && location.toLowerCase().includes(seg.trim().toLowerCase()));
  const t = String(title).replace(/\(([^)]*)\)/g, (m, seg) => (isPlace(seg) ? '' : m));
  // "Role - Mountain View, CA, USA": drop a dash suffix whose last comma part is a place.
  const dash = t.split(/\s+[-–—|]\s+/);
  while (dash.length > 1 && isPlace(dash[dash.length - 1].split(/,\s*/).pop())) dash.pop();
  const comma = dash.join(' - ').split(/,\s+/);
  while (comma.length > 1 && isPlace(comma[comma.length - 1])) comma.pop();
  return comma.join(', ').replace(/\s+/g, ' ').trim();
};
const seenRoles = new Map();
// Same words in another order ("DevOps AWS" / "AWS DevOps", "DevOps" / "DevOps Engineer").
const GENERIC = new Set(['engineer', 'software', 'developer', 'and', 'the', 'of', 'for']);
const words = (t) => [...new Set(t.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w && !GENERIC.has(w)))].sort().join(' ');
const sameRole = (a, b) => roleFuzzyMatch(a, b) || (words(a) !== '' && words(a) === words(b));
const seenRole = (company, title, location) => (seenRoles.get(norm(company)) || []).some((r) => sameRole(r, baseTitle(title, location)));
const addRole = (company, title, location) => seenRoles.set(norm(company), [...(seenRoles.get(norm(company)) || []), baseTitle(title, location)]);
const facts = existsSync(join(ROOT, 'config/apply-facts.yml')) ? read('config/apply-facts.yml') : '';
const PER_COMPANY = Number((facts.match(/max_per_company_per_30_days:\s*(\d+)/) || [])[1] ?? 5);
// Big companies (limits.big_companies) get their own, higher cap: many separate hiring teams.
let limitsYaml = {};
try { limitsYaml = yaml.load(facts)?.limits || {}; } catch {}
const BIG = new Set((limitsYaml.big_companies || []).map(norm));
const capFor = (c) => (BIG.has(c) ? Number(limitsYaml.max_per_big_company_per_30_days ?? PER_COMPANY) : PER_COMPANY);

const ATS = /jobs\.ashbyhq\.com|greenhouse\.io|gh_jid=|jobs\.(eu\.)?lever\.co|apply\.workable\.com|jobs\.smartrecruiters\.com|\.recruitee\.com|\.bamboohr\.com/i;
// Sites that need an account to apply: only once the owner allowed the bot to make accounts.
const ACCOUNT_ATS = /\.myworkdayjobs\.com|\.icims\.com|amazon\.jobs|successfactors\.|\.oraclecloud\.com|\.eightfold\.ai|\.taleo\.net|\.avature\.net|\.jibeapply\.com|\.csod\.com/i;
const accountsOk = /^\s*create_accounts_since:\s*"?\d{4}-\d\d-\d\d/m.test(facts);
// A tracked company's own career site (careers.allianz.com...) is its apply form too.
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const ownHosts = new Set();
try {
  for (const c of yaml.load(read('portals.yml'))?.tracked_companies || []) if (c.enabled !== false) ownHosts.add(hostOf(c.careers_url || c.api));
} catch {}
ownHosts.delete('');
const applyable = (url) => ATS.test(url) || (accountsOk && (ACCOUNT_ATS.test(url) || ownHosts.has(hostOf(url))));
const TOO_SENIOR = /\b(staff|principal|lead|manager|director|head|vp|chief|architect|distinguished|fellow|phd|intern(ship)?|working student|werkstudent|apprentice|trainee)\b/i;
const OFF_TARGET = /\b(sales|account|marketing|recruit|designer|legal|finance|analyst|scientist|researcher|support|consultant|solutions engineer|ios|android|mobile|flutter|react native|frontend|front-end|qa|test)\b/i;

const blacklist = existsSync(join(ROOT, 'data/blacklist.md'))
  ? read('data/blacklist.md').split('\n').filter((l) => l.startsWith('| ') && !l.includes('---'))
      .map((l) => norm(l.split('|')[1])).filter((c) => c && c !== 'company')
  : [];
// Never apply where the owner is already interviewing.
const inProcess = inProcessCompanies(ROOT);

// Applications per company in the last 30 days (tracker + result files).
const recent = new Map();
const bump = (c) => recent.set(c, (recent.get(c) || 0) + 1);
for (const l of read('data/applications.md').split('\n')) {
  const c = l.split('|').map((x) => x.trim());
  if (/^\d+$/.test(c[1] || '')) addRole(c[3], c[4]);
  if (/^\d+$/.test(c[1] || '') && /applied|responded|interview|offer/i.test(c[6]) && (Date.now() - Date.parse(c[2])) / 864e5 < 30) bump(norm(c[3]));
}
const RES = join(ROOT, 'autoapply/results');
const seenUrls = new Set();
for (const f of existsSync(RES) ? readdirSync(RES) : []) {
  if (!f.endsWith('.json') || f.startsWith('dry-')) continue;
  try {
    const r = JSON.parse(readFileSync(join(RES, f), 'utf-8'));
    seenUrls.add(urlKey(r.url));
    addRole(r.company, r.role);
    if (r.status === 'submitted' && (Date.now() - Date.parse(r.finished_at)) / 864e5 < 30) bump(norm(r.company));
  } catch {}
}
// Prescore skips leave no result file. Drop them here too, or they keep taking
// the company's places in the queue and the runner then throws them away.
for (const r of attemptRecords(ROOT)) if (r.stage === 'prescore' && r.mode === 'live') seenUrls.add(urlKey(r.url));

const jobs = [];
for (const line of read('data/pipeline.md').split('\n')) {
  const m = line.match(/^- \[ \] (\S+) \| ([^|]+) \| ([^|]+)(?: \| ([^|]*?))?(?: \| posted: (\S+))?\s*$/);
  if (!m) continue;
  const [, url, company, title, location = '', posted = ''] = m.map((x) => (x ?? '').trim());
  if (!applyable(url) || seenUrls.has(urlKey(url)) || seenRole(company, title, location)) continue;
  if (TOO_SENIOR.test(title) || OFF_TARGET.test(title)) continue;
  if (blacklist.includes(norm(company)) || inProcess.has(norm(company))) continue;
  addRole(company, title, location);
  jobs.push({ url, company, title, location, posted });
}
jobs.sort((a, b) => (b.posted || '').localeCompare(a.posted || ''));
const out = jobs.filter((j) => {
  const c = norm(j.company), n = recent.get(c) || 0;
  if (n >= capFor(c)) return false;
  recent.set(c, n + 1);
  return true;
});
const limit = Number(process.argv[2] || 0);
for (const j of limit ? out.slice(0, limit) : out) console.log([j.company, j.title, j.url, j.location, j.posted].join('\t'));
