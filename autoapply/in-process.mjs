// Companies the owner is in a hiring process with right now: never apply or cold-email there.
// Source 1: tracker rows with status Responded / Interview / Offer (any date).
// Source 2: `in_process_companies` in config/apply-facts.yml, for processes the tracker
// does not know about (applied by hand, a recruiter reached out...).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

export const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const IN_PROCESS = /^(responded|interview|offer)$/i;

export function inProcessCompanies(root) {
  const read = (p) => existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '';
  const out = new Set();
  for (const l of read('data/applications.md').split('\n')) {
    const c = l.split('|').map((x) => x.trim());
    if (/^\d+$/.test(c[1] || '') && IN_PROCESS.test(c[6] || '')) out.add(norm(c[3]));
  }
  let listed = [];
  try { listed = yaml.load(read('config/apply-facts.yml'))?.in_process_companies || []; } catch {}
  for (const c of listed) if (norm(c)) out.add(norm(c));
  return out;
}
