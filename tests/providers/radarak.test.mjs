// tests/providers/radarak.test.mjs
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — radarak');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/radarak.mjs')).href);
  const radarak = mod.default;
  const { normalizeRadarakJob, canApplyFrom } = mod;

  if (radarak.id === 'radarak') pass('radarak.id is "radarak"');
  else fail(`radarak.id is ${JSON.stringify(radarak.id)}`);

  // --- detect() --------------------------------------------------------------
  const hit = radarak.detect({ name: 'X', provider: 'radarak' });
  const miss = radarak.detect({ name: 'X', careers_url: 'https://moamenmoussa172.github.io/job-market-radar/' });
  if (hit && hit.url.endsWith('/job-market-radar/data/jobs.json') && miss === null) {
    pass('detect() claims only an explicit provider: radarak entry');
  } else {
    fail(`detect() hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)}`);
  }

  // --- canApplyFrom() --------------------------------------------------------
  const cases = [
    [{ co: ['Egypt'], w: 'Onsite', rg: [] }, true, 'located in the country'],
    [{ co: [], w: 'Remote', ww: 1, rg: ['Worldwide'] }, true, 'remote worldwide'],
    [{ co: ['Germany'], w: 'Remote', rg: ['Europe', 'MENA'] }, true, 'remote open to the region'],
    [{ co: ['Germany'], w: 'Remote', rg: ['Europe'] }, false, 'remote, other region only'],
    [{ co: ['Germany'], w: 'Onsite', rg: ['MENA'] }, false, 'onsite elsewhere'],
  ];
  const bad = cases.filter(([job, want]) => canApplyFrom(job, 'Egypt', 'MENA') !== want);
  if (bad.length === 0) pass('canApplyFrom() mirrors the site rule (country, worldwide, region, onsite)');
  else fail(`canApplyFrom() wrong for: ${bad.map((c) => c[2]).join(', ')}`);
  if (canApplyFrom({ co: ['Germany'], w: 'Onsite', rg: [] }, '', '')) pass('canApplyFrom() keeps everything without apply_from');
  else fail('canApplyFrom() dropped a row with no apply_from');

  // --- normalizeRadarakJob() --------------------------------------------------
  const full = normalizeRadarakJob({
    t: '  Backend Engineer II ', c: 'Synapse Analytics', l: 'Maadi, Egypt', co: ['Egypt'], rg: [],
    w: 'Hybrid', p: '2026-10-14', u: 'https://synapseanalytics.recruitee.com/o/backend-engineer-ii',
    s: 'Junior', r: 'Backend Engineer', k: [1, 0],
  }, ['Docker', 'Python']);
  if (full
      && full.title === 'Backend Engineer II'
      && full.company === 'Synapse Analytics'
      && full.location === 'Maadi, Egypt'
      && full.url === 'https://synapseanalytics.recruitee.com/o/backend-engineer-ii'
      && full.postedAt === Date.parse('2026-10-14')
      && full.description === 'Role: Backend Engineer. Seniority: Junior. Skills: Python, Docker') {
    pass('normalizeRadarakJob maps title/company/location/url/date and skill names');
  } else {
    fail(`normalizeRadarakJob full = ${JSON.stringify(full)}`);
  }

  const remote = normalizeRadarakJob({ t: 'SRE', c: 'Lyft', l: 'U.S. Anywhere', co: [], rg: ['Worldwide'], ww: 1, w: 'Remote', u: 'https://x.example/j' });
  if (remote && remote.location === 'U.S. Anywhere · Remote') {
    pass('remote rows keep their own text and never gain a "Worldwide" label');
  } else {
    fail(`remote location = ${JSON.stringify(remote?.location)}`);
  }

  const dropped = [
    normalizeRadarakJob({ t: '', u: 'https://x.example/j' }),
    normalizeRadarakJob({ t: 'X', u: 'http://x.example/j' }),
    normalizeRadarakJob({ t: 'X', u: 'not a url' }),
    normalizeRadarakJob(null),
  ];
  if (dropped.every((d) => d === null)) pass('normalizeRadarakJob drops empty titles, non-https and malformed URLs');
  else fail(`dropped = ${JSON.stringify(dropped)}`);

  // --- fetch() ---------------------------------------------------------------
  const calls = [];
  const ctx = {
    async fetchJson(url, opts) {
      calls.push([url, opts?.redirect]);
      if (url.endsWith('/meta.json')) return { skills: ['Go'], countries: [{ name: 'Egypt', region: 'MENA' }] };
      return [
        { t: 'A', c: 'C', co: ['Egypt'], rg: [], w: 'Onsite', u: 'https://a.example/1', k: [0] },
        { t: 'Nationals', c: 'C', co: ['Egypt'], rg: [], w: 'Onsite', u: 'https://a.example/2', f: 2 },
        { t: 'Far', c: 'C', co: ['Japan'], rg: [], w: 'Onsite', u: 'https://a.example/3' },
        { t: 'Region', c: 'C', co: ['Germany'], rg: ['MENA'], w: 'Remote', u: 'https://a.example/4' },
      ];
    },
  };
  const jobs = await radarak.fetch({ name: 'R', provider: 'radarak', apply_from: 'Egypt' }, ctx);
  const titles = jobs.map((j) => j.title).join(',');
  if (titles === 'A,Region' && calls.every(([, r]) => r === 'error')) {
    pass('fetch() filters by apply_from (region from meta.json), drops nationals-only, uses redirect:error');
  } else {
    fail(`fetch() titles=${titles} calls=${JSON.stringify(calls)}`);
  }

  let threw = false;
  try {
    await radarak.fetch({ name: 'R', provider: 'radarak' }, { fetchJson: async () => ({ jobs: [] }) });
  } catch {
    threw = true;
  }
  if (threw) pass('fetch() throws when jobs.json is not an array');
  else fail('fetch() accepted a non-array jobs.json');
} catch (err) {
  fail(`radarak provider tests crashed: ${err.message}`);
}
