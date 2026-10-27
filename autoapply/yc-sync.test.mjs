import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pickYc } from './yc-sync.mjs';

const co = (name, extra = {}) => ({ name, status: 'Active', website: `https://${name}.com`, team_size: 20, industry: 'B2B', subindustry: 'B2B -> Sales', tags: ['SaaS'], regions: ['Remote'], isHiring: false, ...extra });

test('pickYc keeps small active remote software companies, infra and hiring first', () => {
  const picked = pickYc([
    co('sales'),
    co('infra', { subindustry: 'B2B -> Infrastructure' }),
    co('hiring', { isHiring: true }),
    co('dead', { status: 'Inactive' }),
    co('huge', { team_size: 900 }),
    co('usonly', { regions: ['United States of America'] }),
    co('robots', { tags: ['Robotics'] }),
    co('clinic', { industry: 'Healthcare', subindustry: 'Healthcare -> Services' }),
    co('devtoolhealth', { industry: 'Healthcare', tags: ['Developer Tools'] }),
    co('twosites', { website: 'https://a.io, https://b.com' }),
  ]).map(c => c.name);
  assert.deepEqual(picked, ['infra', 'devtoolhealth', 'hiring', 'sales']);
});

test('cold queue adds YC startups but skips companies already tried or with a pending role', () => {
  const root = mkdtempSync(join(tmpdir(), 'cold-queue-test-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'autoapply/outreach'), { recursive: true });
    writeFileSync(join(root, 'data/pipeline.md'), '- [ ] https://jobs.lever.co/busy/1 | Busy | Backend Engineer | Remote | posted: 2026-10-20\n');
    writeFileSync(join(root, 'autoapply/outreach/c1.json'), JSON.stringify({ company: 'Emailed' }));
    writeFileSync(join(root, 'data/cold-startups.json'), JSON.stringify(['Fresh', 'Emailed', 'Busy'].map(name => ({ name, website: `https://${name}.com`, location: 'Remote' }))));
    const out = execFileSync(process.execPath, [join(import.meta.dirname, 'cold-queue.mjs')], { env: { ...process.env, AUTOAPPLY_ROOT: root }, encoding: 'utf8' });
    assert.deepEqual(out.trim().split('\n').map(l => l.split('\t').slice(0, 2)), [['startup', 'Fresh']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
