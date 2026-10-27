#!/usr/bin/env node
// YC startups for cold outreach, zero tokens. Downloads the public YC directory mirror
// (yc-oss.github.io, refreshed daily) at most once every 7 days and keeps small, active,
// software companies that work remote or in Europe/MENA. Hiring or not: a speculative
// note to a founder works either way.
// Output: data/cold-startups.json, best targets first (read by cold-queue.mjs).
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'https://yc-oss.github.io/api/companies/all.json';
const OUT = join(ROOT, 'data/cold-startups.json');
const MAX_AGE_DAYS = 7;

const REGIONS = new Set(['Remote', 'Fully Remote', 'Europe', 'United Kingdom', 'Germany', 'Netherlands', 'France', 'Middle East and North Africa', 'Africa', 'Egypt']);
const INDUSTRIES = new Set(['B2B', 'Fintech']);
const SOFTWARE_TAGS = new Set(['Developer Tools', 'Infrastructure', 'API', 'Open Source', 'Security', 'Analytics', 'Databases', 'DevOps', 'Cloud Computing', 'Data Engineering']);
const TOP_SUB = /Infrastructure|Engineering, Product and Design|Security|Analytics|Payments/;
const NOT_SOFTWARE = new Set(['Hardware', 'Hard Tech', 'Robotics', 'Biotech', 'Manufacturing']);

const validUrl = s => { try { return /^https?:\/\/\S+$/.test(s) && !s.includes(',') && !!new URL(s); } catch { return false; } };

// 0 = infra / dev tools (closest to backend + SRE work), 1 = other B2B or fintech software.
export function pickYc(companies) {
  const out = [];
  for (const c of companies) {
    const tags = new Set(c.tags || []);
    const size = c.team_size || 0;
    if (c.status !== 'Active' || !validUrl(c.website) || size < 2 || size > 200) continue;
    if (!(c.regions || []).some(r => REGIONS.has(r))) continue;
    if ([...tags].some(t => NOT_SOFTWARE.has(t))) continue;
    const devtools = [...tags].some(t => SOFTWARE_TAGS.has(t)) || TOP_SUB.test(c.subindustry || '');
    if (!INDUSTRIES.has(c.industry) && !devtools) continue;
    out.push({
      name: c.name, website: c.website, yc_url: c.url || '', one_liner: c.one_liner || '',
      location: c.all_locations || '', team_size: size, hiring: !!c.isHiring, batch: c.batch || '',
      tier: devtools ? 0 : 1,
    });
  }
  // Infra first, then hiring first, then teams near ~25 people: big enough to pay, small
  // enough that a founder or CTO still reads cold mail.
  const fit = c => Math.abs(Math.log(c.team_size / 25));
  return out.sort((a, b) => a.tier - b.tier || b.hiring - a.hiring || fit(a) - fit(b));
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force && existsSync(OUT) && (Date.now() - statSync(OUT).mtimeMs) / 864e5 < MAX_AGE_DAYS) {
    console.log(`yc: ${JSON.parse(readFileSync(OUT, 'utf8')).length} startups (cached)`);
    return;
  }
  const res = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`yc: HTTP ${res.status}`);
  const all = await res.json();
  if (!Array.isArray(all) || all.length < 1000) throw new Error(`yc: unexpected payload (${all?.length} rows)`);
  const picked = pickYc(all);
  writeFileSync(OUT, JSON.stringify(picked, null, 1));
  console.log(`yc: ${picked.length} of ${all.length} companies kept (${picked.filter(c => c.tier === 0).length} infra/devtools, ${picked.filter(c => c.hiring).length} hiring)`);
}

if (isMainModule(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
