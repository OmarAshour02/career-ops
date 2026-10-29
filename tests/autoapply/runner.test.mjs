import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBatch, optionsFrom, reserveNumber } from '../../autoapply/runner.mjs';
import { UsageCollector, runProcess, attemptRecords, atomicJson, jobId, normalizeUrl, eligibleAttempt } from '../../autoapply/runtime.mjs';
import { usageSummary } from '../../autoapply/usage.mjs';

const fakeWorker = `
const fs = require('fs');
fs.writeFileSync('worker-argv.json', JSON.stringify(process.argv.slice(2)));
const mode = process.argv[2];
const mi = process.argv.indexOf('--mcp-config');
if (mi >= 0 && process.argv[mi + 2] !== '--') throw new Error('prompt swallowed by variadic --mcp-config');
const p = process.argv[process.argv.indexOf('--append-system-prompt-file') + 1];
const prompt = fs.readFileSync(p, 'utf8');
const identity = JSON.parse(prompt.match(/\\n({"attempt_id"[^\\n]+})\\n/)[1]);
const destination = JSON.parse(prompt.match(/Write your result ONLY to ("[^\\n]+?")\\. Never/)[1]);
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
  if (input) throw new Error('worker inherited queue input');
  if (mode === 'quota') { console.log(JSON.stringify({type:'result', is_error:true, errors:["You've hit your session limit"]})); process.exitCode=1; return; }
  console.log(JSON.stringify({type:'assistant', message:{id:'msg-1',model:'fake-model',usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:4},content:[{type:'tool_use',id:'tool-1',name:mode==='uncertain'?'mcp__playwright__browser_click':'Read'}]}}));
  if (mode === 'timeout') { setInterval(()=>{},1000); return; }
  if (mode !== 'missing' && mode !== 'uncertain') {
    const result = {...identity,status:'dry_run_ok'};
    if (mode === 'mismatch') result.url='https://other.example/jobs/9';
    if (mode === 'spam') {
      Object.assign(result,{status:'skipped',reason:'spam_flagged',score:3,report:'reports/'+identity.num+'-example.md'});
      fs.writeFileSync(result.report,'# Example report\\n**URL:** ' + identity.url);
    }
    if (mode === 'outreach') Object.assign(result,{status:'ready',to_email:'person@example.com',subject:'Example',body:'Example',email_evidence:['https://example.com/team']});
    if (mode === 'submitted') {
      const evidence = 'autoapply/screens/' + identity.attempt_id + '.txt'; fs.writeFileSync(evidence, 'Application received');
      Object.assign(result, {status:'submitted',confirmation:{evidence},score:4,report:'reports/'+identity.num+'-example.md'});
      fs.writeFileSync(result.report,'# Example report\\n**URL:** ' + identity.url);
    }
    fs.writeFileSync(destination,JSON.stringify(result));
  }
  console.log(JSON.stringify({type:'result',session_id:'fake-session',usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:4},total_cost_usd:0.001}));
});
`;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'autoapply-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['config', 'data', 'reports', 'autoapply/results', 'autoapply/outreach', 'output/master']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'config/apply-facts.yml'), 'max_applications_per_day: 100\nconsent:\n  auto_submit_since: "2026-01-01"\n  outreach_email_since: "2026-01-01"\n  cold_email_since: "2026-01-01"\n');
  writeFileSync(join(root, 'cv.md'), '# Test Person\n');
  writeFileSync(join(root, 'data/applications.md'), '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n');
  writeFileSync(join(root, 'data/pipeline.md'), '- [ ] https://jobs.example/1 | Example | Engineer\n');
  writeFileSync(join(root, 'worker.cjs'), fakeWorker);
  writeFileSync(join(root, 'merge-tracker.mjs'), '');
  writeFileSync(join(root, 'set-status.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync("selector.json",JSON.stringify(process.argv.slice(2)));');
  const jobs = [{ company: 'Example', role: 'Engineer', url: 'https://jobs.example/1' }];
  return { root, jobs, stage: 'fast', options: optionsFrom([]), workerBin: process.execPath, workerPrefix: [join(root, 'worker.cjs'), 'success'] };
}

test('usage deduplicates streamed blocks and prefers terminal aggregate', () => {
  const c = new UsageCollector();
  const e = { type: 'assistant', message: { id: 'm', model: 'test', usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 2 }, content: [{ type: 'tool_use', id: 't', name: 'Read' }] } };
  c.ingest(e); c.ingest(e);
  assert.equal(c.summary().tokens.input_tokens, 5); assert.equal(c.summary().tool_calls, 1);
  c.ingest({ type: 'result', usage: { input_tokens: 20, output_tokens: 8 }, total_cost_usd: .5 });
  assert.equal(c.summary().tokens.input_tokens, 20); assert.equal(c.summary().source, 'terminal_result');
  assert.equal(new UsageCollector().summary().tokens, null);
});
test('URL identity strips tracking but retains requisition parameters', () => {
  assert.equal(jobId('https://jobs.example/1?utm_source=x#apply'), jobId('https://jobs.example/1'));
  assert.notEqual(jobId('https://jobs.example/?gh_jid=1'), jobId('https://jobs.example/?gh_jid=2'));
  assert.notEqual(normalizeUrl('https://jobs.example/?ref=1'), normalizeUrl('https://jobs.example/?ref=2'));
});
test('worker gets isolated stdin; dry run records usage without legacy writes', async t => {
  const f = fixture(t); const b = await runBatch(f);
  assert.equal(b.attempts.length, 1); assert.equal(b.attempts[0].status, 'dry_run_ok');
  assert.equal(b.attempts[0].usage.tokens.cache_read_input_tokens, 30);
  assert.equal(existsSync(join(f.root, 'autoapply/results/001.json')), false);
  assert.equal(usageSummary(f.root, { mode: 'dry-run' }).stages.fast.median_first_input_tokens, 60);
  const groups = Object.values(usageSummary(f.root, { mode: 'dry-run' }).configurations);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].attempts, 1);
  assert.equal(groups[0].confirmed_submissions, 0);
  assert.equal(groups[0].mean_initial_input_tokens, 60);
});
test('application effort reaches the worker, is logged, and can be overridden per run', async t => {
  for (const override of [null, 'medium']) {
    const f = fixture(t);
    writeFileSync(join(f.root, 'config/apply-facts.yml'), 'effort:\n  apply: low\n');
    f.options.effort = override;
    const b = await runBatch(f);
    const args = JSON.parse(readFileSync(join(f.root, 'worker-argv.json'), 'utf8'));
    assert.equal(b.attempts[0].status, 'dry_run_ok');
    assert.equal(args[args.indexOf('--effort') + 1], override || 'low');
    assert.equal(b.attempts[0].effort, override || 'low');
  }
});
test('effort rejects typos rather than silently using the global default', async t => {
  assert.equal(optionsFrom(['--effort', 'low']).effort, 'low');
  assert.throws(() => optionsFrom(['--effort', 'lo']), /Invalid effort/);
  assert.throws(() => optionsFrom(['--effort']), /Missing --effort/);
  const f = fixture(t);
  writeFileSync(join(f.root, 'config/apply-facts.yml'), 'effort:\n  apply: lo\n');
  await assert.rejects(runBatch(f), /Invalid effort/);
});
test('empty effort preserves the existing Claude Code setting', async t => {
  const f = fixture(t); f.options.effort = null;
  writeFileSync(join(f.root, 'config/apply-facts.yml'), 'effort:\n  apply: ""\n');
  const b = await runBatch(f);
  const args = JSON.parse(readFileSync(join(f.root, 'worker-argv.json'), 'utf8'));
  assert.equal(b.attempts[0].status, 'dry_run_ok');
  assert.equal(args.includes('--effort'), false);
});
test('compact fast prompt retains the complete rendered application rules', async t => {
  const f = fixture(t); const b = await runBatch(f);
  const prompt = readFileSync(join(f.root, 'autoapply/attempts', b.attempts[0].attempt_id, 'prompt.md'), 'utf8');
  const dir = join(f.root, 'autoapply/attempts', b.attempts[0].attempt_id);
  const rules = readFileSync(join(dir, 'apply-instructions.md'), 'utf8');
  assert.ok(prompt.includes(join(dir, 'apply-instructions.md')));
  assert.match(rules, /CAPTCHA: solve it yourself/);
  assert.match(rules, /Never invent a fact/);
  assert.match(rules, /no_ai_policy/);
  assert.match(rules, /Mode `dry-run`: do NOT click Submit/);
  assert.match(rules, /submitted.png/);
  assert.match(rules, /WHOLE form/);
  assert.match(rules, /There is no snapshot\s+cap/);
  assert.ok(rules.includes(join(dir, 'payload.json')));
  assert.doesNotMatch(rules, /\{\{[A-Z]+\}\}/);
  assert.doesNotMatch(rules, /autoapply\/results\/001.json/);
  const args = JSON.parse(readFileSync(join(f.root, 'worker-argv.json'), 'utf8'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Bash,Read,Write,Edit,WebFetch,WebSearch');
  assert.ok(args.includes('--disable-slash-commands'));
});
test('API question previews cannot introduce an early rejection or change worker count', async t => {
  const f = fixture(t);
  f.jobs = [1,2,3].map(n => ({ ...f.jobs[0], url: `https://jobs.example/${n}` }));
  let calls = 0;
  f.formPreviewFn = async () => ++calls === 1 ? { status: 'available', questions: [{ label: 'Conditional clearance', required: true }] } : calls === 2 ? { status: 'unavailable' } : Promise.reject(new Error('API down'));
  const b = await runBatch(f);
  assert.equal(b.attempts.length, 3);
  assert.ok(b.attempts.every(a => a.status === 'dry_run_ok'));
  assert.deepEqual(b.attempts.map(a => a.form_preview), ['available', 'unavailable', 'unavailable']);
  const prompt = readFileSync(join(f.root, 'autoapply/attempts', b.attempts[0].attempt_id, 'prompt.md'), 'utf8');
  assert.match(prompt, /NEVER skip, stop with needs_answer, or fill a field based on this preview alone/);
  assert.match(prompt, /WHOLE live form/);
});
test('a failed JD API fetch is not repeated by the worker and never rejects the job', async t => {
  const f = fixture(t); f.options.prescore = true;
  f.prescoreFn = async () => ({ decision: 'unknown', error: 'jd_unavailable' });
  const b = await runBatch(f);
  assert.equal(b.attempts[0].status, 'dry_run_ok');
  assert.equal(b.attempts[0].prescore.note, 'jd_unavailable');
  const prompt = readFileSync(join(f.root, 'autoapply/attempts', b.attempts[0].attempt_id, 'prompt.md'), 'utf8');
  assert.match(prompt, /Do not repeat fetch-jd.mjs/);
  assert.match(prompt, /must not cause a skip/);
});
test('quota trips a persistent breaker and prevents remaining dispatch', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'quota';
  f.jobs.push({ ...f.jobs[0], url: 'https://jobs.example/2' });
  const b = await runBatch(f);
  assert.equal(b.attempts.length, 1); assert.equal(b.blocked, 'quota_exhausted');
  assert.equal(b.attempts[0].usage.available, false);
  assert.equal((await runBatch(f)).attempts.length, 0);
});
test('parallel quota failure lets only already-dispatched workers settle', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'quota'; f.options.parallel = 3;
  f.jobs = Array.from({ length: 10 }, (_, i) => ({ ...f.jobs[0], url: `https://jobs.example/${i}` }));
  const b = await runBatch(f);
  assert.ok(b.attempts.length > 0 && b.attempts.length <= 3);
  assert.equal(b.blocked, 'quota_exhausted');
});
test('stale legacy IDs are not reused; mismatched worker result is rejected', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'mismatch';
  const legacy = { num: '095', company: 'Old', url: 'https://old.example/9', status: 'failed' };
  atomicJson(join(f.root, 'autoapply/results/095.json'), legacy);
  const b = await runBatch(f);
  assert.equal(b.attempts[0].num, '096'); assert.equal(b.attempts[0].failure, 'result_identity_mismatch');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'autoapply/results/095.json'))), legacy);
});
test('new attempt IDs persist across missing results and bound retries', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'missing';
  const a = await runBatch(f); const b = await runBatch(f); const c = await runBatch(f);
  assert.equal(a.attempts[0].failure, 'missing_result');
  assert.notEqual(a.attempts[0].num, b.attempts[0].num);
  assert.notEqual(a.attempts[0].attempt_id, b.attempts[0].attempt_id);
  assert.equal(c.attempts.length, 0);
});
test('timeout is bounded and logged; interrupted live browser work is not retried', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'timeout'; f.options.timeoutMs = 250;
  const b = await runBatch(f); assert.equal(b.attempts[0].failure, 'timeout');
  f.jobs[0].url = 'https://jobs.example/2'; f.workerPrefix[1] = 'uncertain'; f.options.mode = 'live'; f.options.timeoutMs = 2000;
  const uncertain = await runBatch(f);
  assert.equal(uncertain.attempts[0].status, 'uncertain');
  assert.equal((await runBatch(f)).attempts.length, 0);
});
test('shared lock rejects overlapping batches', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'timeout'; f.options.timeoutMs = 800;
  const first = runBatch(f);
  await new Promise(r => setTimeout(r, 100));
  await assert.rejects(runBatch(f), /lock timeout/);
  await first;
});
test('confirmed result reconciles using explicit report selector and stays deduplicated', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'submitted'; f.options.mode = 'live';
  const b = await runBatch(f); const r = b.attempts[0];
  assert.equal(r.status, 'submitted'); assert.equal(r.reconciled, true);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'selector.json')))[0], '--report');
  assert.match(readFileSync(join(f.root, 'data/pipeline.md'), 'utf8'), /^- \[x\]/);
  assert.equal((await runBatch(f)).attempts.length, 0);
  assert.equal(eligibleAttempt(attemptRecords(f.root), { ...f.options, stage: 'apply', url: f.jobs[0].url }), false);
});
test('a job retried after answered questions updates its first tracker row', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'submitted'; f.options.mode = 'live';
  writeFileSync(join(f.root, 'data/applications.md'), '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n| 812 | 2026-10-28 | Example | Engineer | 3/5 | Evaluated | ✅ | [812](../reports/812-example.md) | autoapply needs_answer |\n');
  writeFileSync(join(f.root, 'autoapply/results/812.json'), JSON.stringify({ status: 'needs_answer', url: 'https://jobs.example/1' }));
  const r = (await runBatch(f)).attempts[0];
  assert.equal(r.status, 'submitted'); assert.equal(r.reconciled, true); assert.notEqual(r.num, '812');
  assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'selector.json'))).slice(0, 3), ['--row', '812', 'Applied']);
});
test('unexpected submission in dry-run stops dispatch and requires reconciliation', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'submitted';
  f.jobs.push({ ...f.jobs[0], url: 'https://jobs.example/2' });
  const b = await runBatch(f);
  assert.equal(b.attempts.length, 1); assert.equal(b.blocked, 'unexpected_submission');
  assert.equal(b.attempts[0].status, 'uncertain');
});
test('stop marker prevents any worker launch', async t => {
  const f = fixture(t); writeFileSync(join(f.root, 'autoapply/.nonstop.stop'), '');
  const b = await runBatch(f); assert.equal(b.blocked, 'stopped'); assert.equal(b.attempts.length, 0);
});
test('answered questions can be retried without unblocking ambiguous submissions', () => {
  const r = { job_id: jobId('https://jobs.example/1'), stage: 'fast', mode: 'live', status: 'needs_answer', finished_at: '2026-01-01T00:00:00Z' };
  const opts = { url: 'https://jobs.example/1', stage: 'apply', mode: 'live', factsUpdatedAt: Date.parse('2026-01-02T00:00:00Z') };
  assert.equal(eligibleAttempt([r], opts), true);
  assert.equal(eligibleAttempt([{ ...r, status: 'uncertain' }], opts), false);
});
test('daily attempt limit counts failures and is independent of submitted count', async t => {
  const f = fixture(t); f.workerPrefix[1] = 'missing'; f.options.maxDailyAttempts = 1;
  await runBatch(f);
  f.jobs[0].url = 'https://jobs.example/2';
  const b = await runBatch(f); assert.equal(b.blocked, 'daily_cap'); assert.equal(b.attempts.length, 0);
});
test('outreach dry-run does not enqueue emails for later live delivery', async t => {
  const f = fixture(t); f.stage = 'outreach'; f.jobs[0].num = '009'; f.workerPrefix[1] = 'outreach';
  const b = await runBatch(f); assert.equal(b.attempts[0].status, 'ready');
  assert.equal(existsSync(join(f.root, 'autoapply/outreach/009.json')), false);
});
test('spawn errors are classified and unknown usage is not reported as zero', async () => {
  const r = await runProcess('/does/not/exist', [], { timeoutMs: 2000 });
  assert.equal(r.failure, 'worker_unavailable'); assert.equal(r.usage.tokens, null);
});
test('allocator accounts for attempts with no report or legacy file', t => {
  const f = fixture(t); mkdirSync(join(f.root, 'autoapply/attempts/abc'), { recursive: true });
  atomicJson(join(f.root, 'autoapply/attempts/abc/record.json'), { num: '150', status: 'failed' });
  assert.equal(reserveNumber(f.root, 'new').num, '151');
});
test('prescore skips are recorded, not re-scored, and do not use the worker limit', async t => {
  const f = fixture(t); f.options = optionsFrom(['--prescore', '--limit', '1']);
  f.jobs = [1, 2, 3].map(n => ({ company: 'Example', role: 'Engineer', url: `https://jobs.example/${n}` }));
  const seen = [];
  f.prescoreFn = async (root, job) => { seen.push(job.url); return job.url.endsWith('/3') ? { decision: 'apply', score: 4, jd: 'JD text', model: 'm', usage: {} } : { decision: 'skip', score: 2, reason: 'low_score', model: 'm', usage: { available: true, tokens: { input_tokens: 5 } } }; };
  const b = await runBatch(f);
  assert.deepEqual(b.attempts.map(a => `${a.stage}:${a.status}`), ['prescore:skipped', 'prescore:skipped', 'fast:dry_run_ok']);
  const fast = b.attempts[2];
  assert.equal(fast.prescore.score, 4);
  assert.match(readFileSync(join(f.root, 'autoapply/attempts', fast.attempt_id, 'prompt.md'), 'utf8'), /JD already fetched/);
  seen.length = 0; const again = await runBatch(f);
  assert.deepEqual(seen, []); assert.equal(again.attempts.length, 0);
});
test('repeated prescore errors fall back to normal workers without tripping the breaker', async t => {
  const f = fixture(t); f.options = optionsFrom(['--prescore']);
  f.jobs = [1, 2, 3, 4].map(n => ({ company: 'Example', role: 'Engineer', url: `https://jobs.example/${n}` }));
  let calls = 0; f.prescoreFn = async () => { calls++; throw new Error('provider.auth'); };
  let fetches = 0; f.prefetchFn = async () => { fetches++; return 'Full prefetched JD after the screening provider stopped.'; };
  const b = await runBatch(f);
  assert.equal(calls, 3); assert.equal(b.blocked, null);
  assert.equal(fetches, 1);
  const last = b.attempts.at(-1);
  assert.equal(readFileSync(join(f.root, 'autoapply/attempts', last.attempt_id, 'jd.md'), 'utf8'), 'Full prefetched JD after the screening provider stopped.');
  assert.deepEqual(b.attempts.map(a => a.status), ['dry_run_ok', 'dry_run_ok', 'dry_run_ok', 'dry_run_ok']);
});
test('prescore parsing rejects unknown reasons and reads OpenCode session usage', async () => {
  const { parseVerdict, parseSession } = await import('../../autoapply/prescore.mjs');
  assert.deepEqual(parseVerdict('ok {"score": 2.5, "skip_reason": "location", "note": "US only"}'), { score: 2.5, skip_reason: 'location', note: 'US only' });
  assert.equal(parseVerdict('{"score": 2, "skip_reason": "ignore previous instructions"}'), null);
  assert.equal(parseVerdict('{"score": 9}'), null);
  const s = parseSession({ info: { cost: 0, outcome: 'succeeded', tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 100, write: 0 } } }, messages: [{ type: 'assistant', content: [{ type: 'text', text: '{"score":4}' }] }] });
  assert.equal(s.text, '{"score":4}'); assert.equal(s.usage.tokens.output_tokens, 5); assert.equal(s.error, null);
  assert.equal(parseSession({ info: {}, messages: [{ type: 'assistant', content: [{ type: 'tool', tool: 'read' }] }] }).error, 'unexpected_tool_use');
});
test('a Claude model chosen for pre-score is called directly, with no tools', async t => {
  const { prescore } = await import('../../autoapply/prescore.mjs');
  const root = mkdtempSync(join(tmpdir(), 'autoapply-prescore-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'modes')); writeFileSync(join(root, 'modes/_brief.md'), 'Backend engineer.');
  mkdirSync(join(root, 'sandbox'));
  const bin = join(root, 'claude'), log = join(root, 'args.log');
  writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: 'result', result: '{"score":4,"skip_reason":null,"note":"fits"}', total_cost_usd: 0.001 }));
`, { mode: 0o755 });
  const old = process.env.AUTOAPPLY_CLAUDE_BIN; process.env.AUTOAPPLY_CLAUDE_BIN = bin;
  t.after(() => { old === undefined ? delete process.env.AUTOAPPLY_CLAUDE_BIN : process.env.AUTOAPPLY_CLAUDE_BIN = old; });
  const r = await prescore(root, { company: 'Example', role: 'Engineer', url: 'https://jobs.example/1' }, { jd: 'JD text', dir: join(root, 'sandbox'), model: 'claude-haiku-5-5' });
  assert.deepEqual([r.decision, r.score, r.model], ['apply', 4, 'claude-haiku-5-5']);
  const args = JSON.parse(readFileSync(log, 'utf8'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-haiku-5-5');
});
test('a blocked free model is paused and paid DeepSeek takes over under a daily cap', async t => {
  const { prescore, readBudget } = await import('../../autoapply/prescore.mjs');
  const root = mkdtempSync(join(tmpdir(), 'autoapply-prescore-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'modes')); writeFileSync(join(root, 'modes/_brief.md'), 'Backend engineer.');
  mkdirSync(join(root, 'sandbox'));
  const bin = join(root, 'opencode'), log = join(root, 'calls.log');
  writeFileSync(bin, `#!/usr/bin/env node
const [cmd, ...rest] = process.argv.slice(2), model = rest[rest.indexOf('-m') + 1];
if (cmd === 'run') require('fs').appendFileSync(${JSON.stringify(log)}, model + ' ' + (process.env.DEEPSEEK_API_KEY || '-') + '\\n');
if (cmd === 'run') console.log(JSON.stringify(model.endsWith('-free') ? { type: 'error', sessionID: 's1', error: { type: 'provider.auth' } } : { type: 'step_start', sessionID: 's2' }));
if (cmd === 'session' && rest[0] === 'export') console.log(JSON.stringify({ info: { cost: 0.002, outcome: 'succeeded', tokens: { input: 10, output: 3 } }, messages: [{ type: 'assistant', content: [{ type: 'text', text: '{"score":1.5,"skip_reason":"too_senior","note":"Staff"}' }] }] }));
`, { mode: 0o755 });
  const env = { AUTOAPPLY_OPENCODE_BIN: process.env.AUTOAPPLY_OPENCODE_BIN, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  process.env.AUTOAPPLY_OPENCODE_BIN = bin; delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const job = { company: 'Example', role: 'Engineer', url: 'https://jobs.example/1' };
  const opts = { jd: 'JD text', dir: join(root, 'sandbox'), model: 'opencode/x-free', fallback: 'deepseek/x', maxPaid: 1 };
  const calls = () => readFileSync(log, 'utf8').trim().split('\n');

  // No key: the free failure is reported, then the free model is left alone.
  assert.equal((await prescore(root, job, opts)).error, 'provider.auth');
  assert.ok(readBudget(root).free_down_at);
  assert.equal((await prescore(root, job, opts)).error, 'free_model_paused');
  assert.deepEqual(calls(), ['opencode/x-free -']);

  // Key in .env: the paid model is called on DeepSeek's API (not OpenCode) and the call is counted.
  writeFileSync(join(root, '.env'), 'DEEPSEEK_API_KEY="sk-test"\n');
  const api = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { api.push([url, init.headers.authorization, JSON.parse(init.body).model]); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"score":1.5,"skip_reason":"too_senior","note":"Staff"}' } }], usage: { prompt_tokens: 10, completion_tokens: 3 } }) }; };
  t.after(() => { globalThis.fetch = realFetch; });
  const paid = await prescore(root, job, opts);
  assert.equal(paid.decision, 'skip'); assert.equal(paid.model, 'deepseek/x'); assert.equal(paid.reason, 'too_senior');
  assert.deepEqual(api, [['https://api.deepseek.com/chat/completions', 'Bearer sk-test', 'x']]);
  assert.deepEqual(calls(), ['opencode/x-free -']);
  assert.equal(readBudget(root).paid_calls, 1);

  // Cap reached: no more paid calls today.
  assert.equal((await prescore(root, job, opts)).error, 'paid_daily_cap');
  assert.equal(api.length, 1);
});
test('hunter helper needs a key, keeps source URLs, and never sends the key in output', async () => {
  const { hunter } = await import('../../autoapply/hunter.mjs');
  assert.equal((await hunter('domain', ['x.com'], { key: null })).exit, 3);
  const urls = [];
  const fetchFn = async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ data: { domain: 'x.com', pattern: '{first}', emails: [{ value: 'ann@x.com', first_name: 'Ann', last_name: 'Lee', position: 'CTO', confidence: 95, verification: { status: 'valid' }, sources: [{ uri: 'https://x.com/team' }] }] } }) }; };
  const r = await hunter('domain', ['x.com'], { key: 'secret', fetchFn });
  assert.equal(r.exit, 0); assert.deepEqual(r.out.people[0].sources, ['https://x.com/team']);
  assert.match(urls[0], /domain-search\?domain=x\.com/); assert.doesNotMatch(JSON.stringify(r.out), /secret/);
  const bad = await hunter('find', ['x.com', 'Ann', 'Lee'], { key: 'k', fetchFn: async () => ({ ok: false, status: 429, json: async () => ({ errors: [{ details: 'rate limited' }] }) }) });
  assert.deepEqual([bad.exit, bad.out.error], [1, 'rate limited']);
});
test('rate-limit status lines and JD text do not trip the quota breaker', async () => {
  const ok = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' } };
  const jd = { type: 'user', message: { content: [{ type: 'tool_result', content: 'You understand retries and rate limits.' }] } };
  const script = `console.log(${JSON.stringify(JSON.stringify(ok))}); console.log(${JSON.stringify(JSON.stringify(jd))}); console.log(JSON.stringify({type:'result',usage:{input_tokens:1}}))`;
  const r = await runProcess(process.execPath, ['-e', script]);
  assert.equal(r.failure, null);
  const rejected = `console.log(${JSON.stringify(JSON.stringify({ ...ok, rate_limit_info: { status: 'rejected' } }))})`;
  assert.equal((await runProcess(process.execPath, ['-e', rejected])).failure, 'quota_exhausted');
  assert.equal((await runProcess(process.execPath, ['-e', 'console.error("You have hit your session limit")'])).failure, 'quota_exhausted');
  assert.equal((await runProcess(process.execPath, ['-e', 'console.log("Rate limiting engineer")'], { captureOutput: true })).failure, null);
});
test('force retries an owner-approved skipped job but never a submitted one', async t => {
  const f = fixture(t);
  const dir = join(f.root, 'autoapply/attempts/a1'); mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, 'record.json'), { attempt_id: 'a1', job_id: jobId(f.jobs[0].url), stage: 'fast', mode: 'dry-run', status: 'skipped', started_at: '2020-01-01T00:00:00Z' });
  assert.equal((await runBatch(f)).attempts.length, 0);
  const b = await runBatch({ ...f, force: true });
  assert.equal(b.attempts.length, 1);
  assert.match(readFileSync(join(f.root, 'autoapply/attempts', b.attempts[0].attempt_id, 'prompt.md'), 'utf8'), /Owner override/);
  atomicJson(join(dir, 'record.json'), { attempt_id: 'a1', job_id: jobId(f.jobs[0].url), stage: 'fast', mode: 'live', status: 'submitted', started_at: '2020-01-01T00:00:00Z' });
  assert.equal((await runBatch({ ...f, force: true })).attempts.length, 0);
});
test('cold stage drafts without a browser, publishes only live, and is its own dedup family', async t => {
  const f = fixture(t); f.stage = 'cold'; f.workerPrefix[1] = 'outreach';
  f.jobs = [{ kind: 'startup', company: 'Example', role: 'Backend (speculative)', url: 'https://jobs.example/1', num: 'cabc123' }];
  const dry = await runBatch(f);
  assert.equal(dry.attempts[0].status, 'ready');
  assert.equal(existsSync(join(f.root, 'autoapply/attempts', dry.attempts[0].attempt_id, 'mcp.json')), false);
  assert.match(readFileSync(join(f.root, 'autoapply/attempts', dry.attempts[0].attempt_id, 'prompt.md'), 'utf8'), /Kind: startup/);
  assert.equal(existsSync(join(f.root, 'autoapply/outreach/cabc123.json')), false);
  const live = await runBatch({ ...f, options: optionsFrom(['--live']) });
  assert.equal(live.attempts[0].status, 'ready');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'autoapply/outreach/cabc123.json'), 'utf8')).status, 'ready');
  // An application to the same URL is not blocked by a cold email.
  assert.equal(eligibleAttempt(attemptRecords(f.root), { url: f.jobs[0].url, stage: 'fast', mode: 'live' }), true);
});
test('application cap counts live submissions, not launched workers', async t => {
  const f = fixture(t); f.options.mode = 'live'; f.workerPrefix[1] = 'missing';
  writeFileSync(join(f.root, 'config/apply-facts.yml'), 'max_applications_per_day: 1\nconsent:\n  auto_submit_since: "2026-01-01"\n  outreach_email_since: "2026-01-01"\n  cold_email_since: "2026-01-01"\n');
  f.jobs.push({ ...f.jobs[0], url: 'https://jobs.example/2' }, { ...f.jobs[0], url: 'https://jobs.example/3' });
  const b = await runBatch(f);
  assert.equal(b.attempts.length, 3); assert.equal(b.blocked, null);
});
test('a spam flag stops that site for the rest of the day', async t => {
  const f = fixture(t); f.options.mode = 'live'; f.workerPrefix[1] = 'spam';
  f.jobs.push({ ...f.jobs[0], url: 'https://jobs.example/2' }, { ...f.jobs[0], url: 'https://other.example/3' });
  const b = await runBatch(f);
  assert.equal(b.blocked, null);
  assert.deepEqual(b.attempts.map(a => a.url), ['https://jobs.example/1', 'https://other.example/3']);
  assert.equal(b.attempts[0].spam_flagged, true);
  f.jobs = [{ ...f.jobs[0], url: 'https://jobs.example/2' }];
  assert.equal((await runBatch(f)).attempts.length, 0);
});
test('live runs refuse without the owner consent; dry runs still work', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'config/apply-facts.yml'), 'max_applications_per_day: 100\nconsent:\n  auto_submit_since: ""\n');
  const live = await runBatch({ ...f, options: optionsFrom(['--live']) });
  assert.deepEqual([live.blocked, live.attempts.length], ['no_consent', 0]);
  const dry = await runBatch(f);
  assert.equal(dry.blocked, null);
});
test('live runs refuse while cv.md is empty', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'cv.md'), '\n');
  const live = await runBatch({ ...f, options: optionsFrom(['--live']) });
  assert.deepEqual([live.blocked, live.attempts.length], ['no_cv', 0]);
});

test('auto pre-score falls back to Claude Haiku when the free model is down and there is no DeepSeek key', async t => {
  const { prescore } = await import('../../autoapply/prescore.mjs');
  const root = mkdtempSync(join(tmpdir(), 'autoapply-prescore-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'modes')); writeFileSync(join(root, 'modes/_brief.md'), 'Backend engineer.');
  mkdirSync(join(root, 'sandbox'));
  const oc = join(root, 'opencode'), cl = join(root, 'claude'), log = join(root, 'claude.log');
  writeFileSync(oc, `#!/usr/bin/env node
const [cmd] = process.argv.slice(2);
if (cmd === 'run') console.log(JSON.stringify({ type: 'error', sessionID: 's1', error: { type: 'provider.quota' } }));
if (cmd === 'session') console.log(JSON.stringify({ info: {}, messages: [] }));
`, { mode: 0o755 });
  writeFileSync(cl, `#!/usr/bin/env node
require('fs').appendFileSync(${JSON.stringify(log)}, 'call\\n');
console.log(JSON.stringify({ type: 'result', result: '{"score":1,"skip_reason":"location","note":"US only"}' }));
`, { mode: 0o755 });
  const env = { AUTOAPPLY_OPENCODE_BIN: process.env.AUTOAPPLY_OPENCODE_BIN, AUTOAPPLY_CLAUDE_BIN: process.env.AUTOAPPLY_CLAUDE_BIN, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
  process.env.AUTOAPPLY_OPENCODE_BIN = oc; process.env.AUTOAPPLY_CLAUDE_BIN = cl; delete process.env.DEEPSEEK_API_KEY;
  t.after(() => { for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : process.env[k] = v; });
  const job = { company: 'Example', role: 'Engineer', url: 'https://jobs.example/1' };
  const opts = { jd: 'JD text', dir: join(root, 'sandbox'), model: 'auto' };
  // First call: free model fails, Claude answers. Second: free model is paused, Claude answers directly.
  for (let i = 0; i < 2; i++) {
    const r = await prescore(root, job, opts);
    assert.deepEqual([r.decision, r.reason, r.model], ['skip', 'location', 'claude-haiku-5-5']);
  }
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
});
test('browser hider only runs on macOS, hides Chrome for Testing only, and stops cleanly', async () => {
  const { startHider } = await import('../../autoapply/hide-browser.mjs');
  const calls = [];
  const run = (bin, args, opts, done) => { calls.push([bin, args.at(-1)]); setImmediate(done); };
  startHider({ platform: 'linux', run })();
  assert.equal(calls.length, 0);
  const stop = startHider({ platform: 'darwin', everyMs: 10, run });
  await new Promise(r => setTimeout(r, 55));
  stop();
  const n = calls.length;
  await new Promise(r => setTimeout(r, 30));
  assert.ok(n >= 3, `ticks: ${n}`); assert.equal(calls.length, n);
  assert.equal(calls[0][0], 'osascript'); assert.match(calls[0][1], /com\.google\.chrome\.for\.testing/);
});
