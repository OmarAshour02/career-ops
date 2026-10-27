// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Radarak provider — moamenmoussa172.github.io/job-market-radar, a free,
// daily-refreshed board of tech jobs for Egypt, the Gulf and Europe. The site
// is static; its whole inventory is two public JSON files, no auth:
//
//   data/jobs.json → [ { id, t, c, l, co, rg, w, ww?, p, u, s, r, k, f? }, ... ]
//   data/meta.json → { generated_at, countries: [{ name, region }], skills, ... }
//
//   t title · c company · l location text · co countries · rg regions a remote
//   role is open to · w work mode · ww 1 = remote worldwide · p posted date
//   (YYYY-MM-DD) · u apply URL (usually the employer's ATS) · s seniority ·
//   r role · k skill indexes into meta.skills · f flag bits (FLAG below)
//
// Configure via a `job_boards` entry with `provider: radarak`:
//
//   - name: Radarak (Egypt-eligible tech jobs)
//     provider: radarak
//     apply_from: Egypt        # optional: keep only jobs open to this country
//     enabled: true
//
// --- Design notes -----------------------------------------------------------
//
// Eligibility. `apply_from` mirrors the site's own canApplyFrom(): a job is
// kept when it is located in that country, or is remote and open worldwide or
// to the country's region (looked up in meta.json). Without `apply_from` the
// full inventory is emitted and scan.mjs's location_filter decides alone.
//
// Location. The emitted location keeps the posting's own text and appends the
// regions a remote role is open to ("Remote Canada · Remote (Worldwide)"), so
// location_filter's always_allow can rescue an eligible remote role whose text
// names a blocked country, and the evaluator sees why it was kept.
//
// Nationals-only roles (e.g. "Saudi nationals only") are dropped unless the
// entry sets `include_nationals: true`.
//
// Skills ride in `description` ("Skills: Python, Docker, …") — they come free
// with the list payload and give content_filter something to read.

const ORIGIN = 'https://moamenmoussa172.github.io';
const BASE = `${ORIGIN}/job-market-radar/data`;
const JOBS_URL = `${BASE}/jobs.json`;
const META_URL = `${BASE}/meta.json`;
// jobs.json is ~5 MB; the shared 10s default is tight for that on a slow link.
const TIMEOUT_MS = 60_000;
const FLAG = { visa: 1, nationals: 2, arabic: 4, longOpen: 8 };

/** NaN-safe Date.parse. */
function toEpochMs(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

/** Same rule as the site's canApplyFrom(job, country). */
export function canApplyFrom(job, country, region) {
  if (!country) return true;
  if (strings(job.co).includes(country)) return true;
  const rg = strings(job.rg);
  return job.w === 'Remote' && (job.ww === 1 || rg.includes('Worldwide') || (!!region && rg.includes(region)));
}

/** Employer's https URL, or '' (row dropped). */
function resolveUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

// The site's `ww`/`rg` are inferred: any "Remote" text with no country becomes
// Worldwide, "U.S. Anywhere" included. So only the posting's own text and
// countries are emitted, and location_filter judges eligibility from those.
function resolveLocation(job) {
  const parts = [];
  const text = typeof job.l === 'string' ? job.l.trim() : '';
  if (text) parts.push(text);
  if (job.w === 'Remote' && !/remote/i.test(text)) parts.push('Remote');
  const countries = strings(job.co).filter((c) => !text.includes(c));
  if (countries.length) parts.push(countries.join(', '));
  return parts.join(' · ');
}

/**
 * Normalize one jobs.json row into a Job; null when unusable.
 * Exported for tests.
 * @param {any} row
 * @param {string[]} [skills] meta.skills, for the skill-index lookup
 */
export function normalizeRadarakJob(row, skills = []) {
  if (!row || typeof row !== 'object') return null;
  const title = typeof row.t === 'string' ? row.t.trim() : '';
  if (!title) return null;
  const url = resolveUrl(row.u);
  if (!url) return null;

  /** @type {any} */
  const out = {
    title,
    url,
    company: (typeof row.c === 'string' && row.c.trim()) || 'Radarak',
    location: resolveLocation(row),
  };

  const names = Array.isArray(row.k) ? row.k.map((i) => skills[i]).filter((s) => typeof s === 'string') : [];
  const notes = [];
  if (typeof row.r === 'string' && row.r) notes.push(`Role: ${row.r}`);
  if (typeof row.s === 'string' && row.s) notes.push(`Seniority: ${row.s}`);
  if (names.length) notes.push(`Skills: ${names.join(', ')}`);
  if (notes.length) out.description = notes.join('. ');

  const postedAt = toEpochMs(row.p);
  if (postedAt !== undefined) out.postedAt = postedAt;
  return out;
}

/** @type {Provider} */
export default {
  id: 'radarak',

  detect(entry) {
    return entry?.provider === 'radarak' ? { url: JOBS_URL } : null;
  },

  async fetch(entry, ctx) {
    const rows = await ctx.fetchJson(JOBS_URL, { redirect: 'error', timeoutMs: TIMEOUT_MS });
    if (!Array.isArray(rows)) {
      const keys = rows && typeof rows === 'object' ? Object.keys(rows).slice(0, 8).join(', ') : typeof rows;
      throw new Error(`radarak: expected jobs.json to be an array, got ${keys}`);
    }

    // meta.json is optional: without it skills stay blank and region-based
    // eligibility falls back to `apply_region` (or worldwide-only).
    let skills = [];
    let region = typeof entry?.apply_region === 'string' ? entry.apply_region : '';
    const country = typeof entry?.apply_from === 'string' ? entry.apply_from.trim() : '';
    try {
      const meta = /** @type {any} */ (await ctx.fetchJson(META_URL, { redirect: 'error', timeoutMs: TIMEOUT_MS }));
      if (Array.isArray(meta?.skills)) skills = meta.skills;
      if (!region && country && Array.isArray(meta?.countries)) {
        region = meta.countries.find((c) => c?.name === country)?.region || '';
      }
    } catch {
      // keep going with what we have
    }

    const out = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (!entry?.include_nationals && (Number(row.f) & FLAG.nationals)) continue;
      if (!canApplyFrom(row, country, region)) continue;
      const job = normalizeRadarakJob(row, skills);
      if (job) out.push(job);
    }
    return out;
  },
};
