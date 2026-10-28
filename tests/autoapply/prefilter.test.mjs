import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const PREFILTER = join(import.meta.dirname, '../../autoapply/prefilter.mjs');

function queue(t, { pipeline, tracker = [], results = [], prescored = [], perCompany = 5, location = () => 'Remote', extraFacts = '', portals = '', factsEditedAfter = false }) {
  const root = mkdtempSync(join(tmpdir(), 'prefilter-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const d of ['data', 'config', 'autoapply/results']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'config/apply-facts.yml'), `limits:\n  max_per_company_per_30_days: ${perCompany}\n${extraFacts}`);
  if (portals) writeFileSync(join(root, 'portals.yml'), portals);
  writeFileSync(join(root, 'data/pipeline.md'), pipeline.map(([url, company, title]) => `- [ ] ${url} | ${company} | ${title} | ${location(title)} | posted: 2026-10-19`).join('\n') + '\n');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(join(root, 'data/applications.md'), tracker.map(([n, company, role, status]) => `| ${n} | ${today} | ${company} | ${role} | 3/5 | ${status} | ✅ | [${n}](reports/${n}.md) | |`).join('\n') + '\n');
  results.forEach((r, i) => writeFileSync(join(root, `autoapply/results/${i + 1}.json`), JSON.stringify(r)));
  if (factsEditedAfter) { const later = new Date(Date.now() + 60_000); utimesSync(join(root, 'config/apply-facts.yml'), later, later); }
  prescored.forEach((url, i) => { const d = join(root, `autoapply/attempts/p${i}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'record.json'), JSON.stringify({ stage: 'prescore', mode: 'live', status: 'skipped', url })); });
  const out = execFileSync(process.execPath, [PREFILTER], { env: { ...process.env, AUTOAPPLY_ROOT: root }, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean).map((l) => l.split('\t').slice(0, 2));
}

test('one role posted per country is queued once', t => {
  const got = queue(t, { pipeline: [
    ['https://jobs.ashbyhq.com/clip/1', 'clipbook', 'Founding Senior Software Engineer (Portugal)'],
    ['https://jobs.ashbyhq.com/clip/2', 'clipbook', 'Founding Senior Software Engineer (Poland)'],
    ['https://jobs.ashbyhq.com/clip/3', 'clipbook', 'Founding Senior Software Engineer (Germany)'],
    ['https://boards.greenhouse.io/acme/jobs/1', 'acme', 'Senior AI Search Engineer'],
    ['https://boards.greenhouse.io/acme/jobs/2', 'acme', 'Senior AI Search Engineer(m/f/x)'],
  ] });
  assert.deepEqual(got.map(([c]) => c), ['clipbook', 'acme']);
});

test('different roles at one company are kept, up to the per-company cap', t => {
  const got = queue(t, { perCompany: 2, pipeline: [
    ['https://jobs.lever.co/x/1', 'x', 'Software Engineer, Backend'],
    ['https://jobs.lever.co/x/2', 'x', 'Software Engineer, Applied AI'],
    ['https://jobs.lever.co/x/3', 'x', 'Software Engineer, Product'],
  ] });
  assert.equal(got.length, 2);
});

test('a role already in the tracker or results is not queued again', t => {
  const got = queue(t, {
    tracker: [[6, 'ElevenLabs', 'Full-Stack Engineer (Backend Leaning) - Platform Engineering', 'SKIP']],
    results: [{ url: 'https://jobs.lever.co/old/9', company: 'smartcat', role: 'Senior DevOps and Infrastructure Engineer', status: 'skipped' }],
    pipeline: [
      ['https://jobs.ashbyhq.com/eleven/2', 'ElevenLabs', 'Full-Stack Engineer (Backend Leaning) - Platform Engineering'],
      ['https://boards.greenhouse.io/smartcat/jobs/2', 'smartcat', 'Senior DevOps and Infrastructure Engineer'],
      ['https://jobs.ashbyhq.com/eleven/3', 'ElevenLabs', 'Backend Engineer, Payments'],
    ],
  });
  assert.deepEqual(got, [['ElevenLabs', 'Backend Engineer, Payments']]);
});

test('location suffixes and brackets do not split one role', t => {
  const got = queue(t, { pipeline: [
    ['https://jobs.ashbyhq.com/y/1', 'y', 'Backend Engineer - Europe – Remote'],
    ['https://jobs.ashbyhq.com/y/2', 'y', 'Backend Engineer, Germany'],
    ['https://jobs.ashbyhq.com/y/3', 'y', 'Backend Engineer (Europe – Remote)'],
    ['https://jobs.ashbyhq.com/y/4', 'y', 'Software Engineer (Backend)'],
    ['https://jobs.ashbyhq.com/y/5', 'y', 'Software Engineer (Data Platform)'],
  ] });
  assert.deepEqual(got.map(([, title]) => title), ['Backend Engineer - Europe – Remote', 'Software Engineer (Data Platform)']);
});

test('a city, state, country suffix from the location field is stripped', t => {
  const pipeline = [
    ['https://jobs.ashbyhq.com/s/1', 'speechify', 'Software Engineer, AI Data - Mountain View, CA, USA'],
    ['https://jobs.ashbyhq.com/s/2', 'speechify', 'Software Engineer, AI Data - Long Beach, CA, USA'],
  ];
  const got = queue(t, { pipeline, location: (title) => title.split(' - ')[1] });
  assert.equal(got.length, 1);
});

test('a US city suffix is stripped, but a place word inside a role name is kept', t => {
  const got = queue(t, { location: () => 'Remote · Distributed', pipeline: [
    ['https://jobs.ashbyhq.com/s/1', 'speechify', 'Software Engineer, AI Data - Mountain View, CA, USA'],
    ['https://jobs.ashbyhq.com/s/2', 'speechify', 'Software Engineer, AI Data - New York, NY, USA'],
    ['https://jobs.ashbyhq.com/s/3', 'speechify', 'Software Engineer - US Payments'],
  ] });
  assert.deepEqual(got.map(([, title]) => title), ['Software Engineer, AI Data - Mountain View, CA, USA', 'Software Engineer - US Payments']);
});

test('the same words in another order are one role', t => {
  const got = queue(t, { pipeline: [
    ['https://jobs.lever.co/xe/1', 'xebia', 'DevOps AWS'],
    ['https://jobs.lever.co/xe/2', 'xebia', 'AWS DevOps'],
    ['https://jobs.lever.co/xe/3', 'xebia', 'DevOps Engineer'],
    ['https://jobs.lever.co/xe/4', 'xebia', 'Software Engineer'],
    ['https://jobs.lever.co/xe/5', 'xebia', 'Senior Software Engineer'],
  ] });
  assert.deepEqual(got.map(([, title]) => title), ['DevOps AWS', 'DevOps Engineer', 'Software Engineer', 'Senior Software Engineer']);
});

test('prescore skips do not take the company places', t => {
  const got = queue(t, { perCompany: 2, prescored: ['https://jobs.lever.co/x/1', 'https://jobs.lever.co/x/2'], pipeline: [
    ['https://jobs.lever.co/x/1', 'x', 'Software Engineer, Backend'],
    ['https://jobs.lever.co/x/2', 'x', 'Software Engineer, Applied AI'],
    ['https://jobs.lever.co/x/3', 'x', 'Software Engineer, Product'],
  ] });
  assert.deepEqual(got.map(([, title]) => title), ['Software Engineer, Product']);
});

test('guest-apply ATS sites are queued, other sites are not', t => {
  const got = queue(t, { pipeline: [
    ['https://apply.workable.com/j/DB4D7C0EC8', 'Hugging Face', 'Open-Source Python Engineer'],
    ['https://jobs.smartrecruiters.com/Acme/7441', 'Acme', 'Backend Engineer'],
    ['https://synapseanalytics.recruitee.com/o/backend-engineer', 'Synapse Analytics', 'Backend Engineer'],
    ['https://instabug.bamboohr.com/careers/312', 'Instabug', 'Backend Engineer'],
    ['https://careers.allianz.com/global/en/job/1/Platform-Engineer', 'Allianz', 'Platform Engineer'],
    ['https://www.arbeitnow.com/jobs/companies/x/backend-engineer-1', 'X', 'Backend Engineer'],
  ] });
  assert.deepEqual(got.map(([c]) => c).sort(), ['Acme', 'Hugging Face', 'Instabug', 'Synapse Analytics']);
});

test('account sites (Workday, own career sites) are queued only after account consent', t => {
  const pipeline = [
    ['https://acme.wd5.myworkdayjobs.com/External/job/Berlin/Backend-Engineer_R1', 'acme', 'Backend Engineer'],
    ['https://careers.bigco.com/job/42', 'bigco', 'Platform Engineer'],
    ['https://www.linkedin.com/jobs/view/1', 'other', 'Software Engineer'],
  ];
  const portals = 'tracked_companies:\n  - name: bigco\n    careers_url: https://careers.bigco.com/search\n';
  assert.deepEqual(queue(t, { pipeline, portals }), []);
  const got = queue(t, { pipeline, portals, extraFacts: 'consent:\n  create_accounts_since: "2026-10-28"\n' });
  assert.deepEqual(got.map(([c]) => c), ['acme', 'bigco']);
});

test('big companies get their own higher per-company cap', t => {
  const pipeline = [1, 2, 3, 4].flatMap((i) => [
    [`https://jpmc.fa.oraclecloud.com/job/${i}`, 'JPMorgan Chase', `Software Engineer ${['Payments', 'Kafka', 'Cloud', 'Data'][i - 1]}`],
    [`https://jobs.lever.co/small/${i}`, 'small', `Software Engineer ${['Payments', 'Kafka', 'Cloud', 'Data'][i - 1]}`],
  ]);
  const extraFacts = '  max_per_big_company_per_30_days: 3\n  big_companies: [JPMorgan Chase]\nconsent:\n  create_accounts_since: "2026-10-28"\n';
  const got = queue(t, { perCompany: 1, pipeline, extraFacts });
  assert.equal(got.filter(([c]) => c === 'JPMorgan Chase').length, 3);
  assert.equal(got.filter(([c]) => c === 'small').length, 1);
});

test('companies in a hiring process are never queued', t => {
  const got = queue(t, {
    extraFacts: 'in_process_companies: [ Google ]\n',
    tracker: [['1', 'Cloudflare', 'Systems Engineer', 'Interview'], ['2', 'acme', 'Backend Engineer', 'Rejected']],
    pipeline: [
      ['https://boards.greenhouse.io/cloudflare/jobs/9', 'Cloudflare', 'Software Engineer, Network'],
      ['https://boards.greenhouse.io/google/jobs/9', 'Google', 'Site Reliability Engineer'],
      ['https://boards.greenhouse.io/acme/jobs/9', 'acme', 'Platform Engineer'],
    ],
  });
  assert.deepEqual(got.map(([c]) => c), ['acme']);
});

test('a job stopped on a missing answer is retried after the answer bank changes', t => {
  const url = 'https://jobs.ashbyhq.com/acme/1';
  const args = {
    tracker: [['1', 'acme', 'Backend Engineer', 'Evaluated']],
    results: [{ url, company: 'acme', role: 'Backend Engineer', status: 'needs_answer' }, { url: 'https://jobs.ashbyhq.com/beta/1', company: 'beta', role: 'Platform Engineer', status: 'submitted', finished_at: new Date().toISOString() }],
    pipeline: [[url, 'acme', 'Backend Engineer'], ['https://jobs.ashbyhq.com/beta/1', 'beta', 'Platform Engineer']],
  };
  assert.deepEqual(queue(t, args).map(([c]) => c), []);
  assert.deepEqual(queue(t, { ...args, factsEditedAfter: true }).map(([c]) => c), ['acme']);
});
