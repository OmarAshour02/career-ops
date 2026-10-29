import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const WATCH = join(import.meta.dirname, '../../autoapply/quota-watch.sh');

// A fake project: runner.mjs unblock removes the block, daily.sh leaves a marker, `claude` prints `reply`.
function run(t, { reason = 'quota_exhausted', reply = 'ok', exit = 0, running = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quota-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'autoapply'));
  copyFileSync(WATCH, join(root, 'autoapply/quota-watch.sh'));
  writeFileSync(join(root, 'autoapply/provider-block.json'), JSON.stringify({ reason, at: '2026-10-28T03:05:06Z' }, null, 2));
  writeFileSync(join(root, 'autoapply/runner.mjs'), "import { unlinkSync } from 'node:fs'; unlinkSync('autoapply/provider-block.json');\n");
  writeFileSync(join(root, 'autoapply/profile.mjs'), "console.log('test-model');\n");
  writeFileSync(join(root, 'autoapply/daily.sh'), 'touch autoapply/daily-started\n');
  if (running) mkdirSync(join(root, 'autoapply/.workflow.lock'));
  const bin = join(root, 'fake-claude');
  writeFileSync(bin, `#!/bin/sh\necho "$*" > "${root}/claude-args"\necho '${reply}'\nexit ${exit}\n`); chmodSync(bin, 0o755);
  spawnSync('/bin/bash', [join(root, 'autoapply/quota-watch.sh')], { env: { ...process.env, AUTOAPPLY_CLAUDE_BIN: bin, PATH: `${process.execPath.replace(/\/node$/, '')}:${process.env.PATH}` } });
  return { started: existsSync(join(root, 'autoapply/daily-started')), blocked: existsSync(join(root, 'autoapply/provider-block.json')), probed: existsSync(join(root, 'claude-args')), root };
}

test('limit back: clears the block and starts the daily run', t => {
  const r = run(t);
  assert.deepEqual([r.probed, r.blocked, r.started], [true, false, true]);
  assert.match(readFileSync(join(r.root, 'claude-args'), 'utf8'), /--model test-model/);
});

test('still limited: keeps the block, no run', t => {
  const r = run(t, { reply: "You've hit your usage limit", exit: 1 });
  assert.deepEqual([r.probed, r.blocked, r.started], [true, true, false]);
});

test('other blocks (login) are left for the owner', t => {
  const r = run(t, { reason: 'authentication' });
  assert.deepEqual([r.probed, r.blocked, r.started], [false, true, false]);
});

test('does nothing while a run is going', t => {
  const r = run(t, { running: true });
  assert.deepEqual([r.probed, r.started], [false, false]);
});
