import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export const TOKEN_KEYS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
// Mail stages draft emails only: no browser, no application side effects.
export const isMail = stage => stage === 'outreach' || stage === 'cold';
export const STOP_FAILURES = new Set(['quota_exhausted', 'authentication', 'worker_unavailable']);
export function normalizeUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Invalid job URL');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^utm_|^gh_src$/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  u.pathname = u.pathname.replace(/\/$/, '') || '/';
  return u.toString();
}
export const jobId = url => createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 24);
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function atomicJson(path, value) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export function attemptRecords(root) {
  const dir = join(root, 'autoapply/attempts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map(id => readJson(join(dir, id, 'record.json'))).filter(Boolean);
}
export function classifyFailure(text, { timedOut = false, cancelled = false, spawnError = false, exitCode = 0 } = {}) {
  if (timedOut) return 'timeout';
  if (cancelled) return 'cancelled';
  if (spawnError) return 'worker_unavailable';
  if (/hit your (session|usage|weekly|daily) limit|rate.?limit|quota.?exceeded|insufficient.*credit|credit balance|"status":429|rate_limit_error/i.test(text)) return 'quota_exhausted';
  if (/authentication_error|invalid api key|not logged in|please (log|sign) in|oauth.*expired|"status":401/i.test(text)) return 'authentication';
  if (/error_max_turns|max.turns.*(reached|exceeded)|error_max_budget_usd/i.test(text)) return 'budget_exhausted';
  return exitCode !== 0 ? 'worker_exit' : null;
}

// Stream records can repeat a message ID once per content block. Count each
// message once; prefer the authoritative aggregate on the terminal result.
export class UsageCollector {
  messages = new Map(); tools = new Map(); models = new Set(); terminal = null;
  firstInput = null; failure = null;
  ingest(event) {
    if (event.type === 'system' && event.model) this.models.add(event.model);
    if (event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') this.failure ||= 'quota_exhausted';
    if (event.type === 'result') {
      this.terminal = event;
      this.failure ||= classifyFailure(JSON.stringify({ subtype: event.subtype, errors: event.errors, result: event.is_error ? event.result : '' }));
    }
    if (event.type !== 'assistant') return;
    const m = event.message || {};
    if (m.model && m.model !== '<synthetic>') this.models.add(m.model);
    if (event.isApiErrorMessage || event.error || m.model === '<synthetic>') this.failure ||= classifyFailure(JSON.stringify(event));
    if (m.id && m.usage && m.model !== '<synthetic>') {
      const old = this.messages.get(m.id) || {};
      for (const key of TOKEN_KEYS) old[key] = Math.max(old[key] || 0, m.usage[key] || 0);
      this.messages.set(m.id, old);
      this.firstInput ??= TOKEN_KEYS.slice(0, 3).reduce((n, k) => n + (m.usage[k] || 0), 0);
    }
    for (const block of Array.isArray(m.content) ? m.content : []) {
      if (block.type === 'tool_use' && block.id) this.tools.set(block.id, block.name);
    }
  }
  summary() {
    const aggregate = this.terminal?.usage;
    const available = !!aggregate || this.messages.size > 0;
    const totals = Object.fromEntries(TOKEN_KEYS.map(key => [key, aggregate ? aggregate[key] || 0 : [...this.messages.values()].reduce((n, u) => n + (u[key] || 0), 0)]));
    return {
      available, source: aggregate ? 'terminal_result' : available ? 'assistant_messages_partial' : 'unavailable',
      tokens: available ? totals : null,
      model_calls: this.messages.size, first_input_tokens: this.firstInput,
      tool_calls: this.tools.size,
      tools: Object.fromEntries([...new Set(this.tools.values())].map(name => [name, [...this.tools.values()].filter(n => n === name).length])),
      models: [...this.models], session_id: this.terminal?.session_id || null,
      // CLI estimate, not a subscription bill or invoice.
      cli_cost_usd: Number.isFinite(this.terminal?.total_cost_usd) ? this.terminal.total_cost_usd : null,
    };
  }
}

export function runProcess(command, args, { cwd, timeoutMs = 600_000, logPath, env = process.env, onFailure = () => {}, signal, onSpawn = () => {}, captureOutput = false } = {}) {
  return new Promise(resolve => {
    const usage = new UsageCollector();
    let buffer = '', tail = '', errTail = '', output = '', timedOut = false, cancelled = false, spawnError = false, overflow = false;
    let timer, killer, done = false, blocked = null;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
    const terminate = () => { kill('SIGTERM'); killer ||= setTimeout(() => kill('SIGKILL'), 1500); };
    const cancel = () => { cancelled = true; terminate(); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.on('spawn', () => onSpawn(child.pid));
    const notify = failure => {
      if (STOP_FAILURES.has(failure) && !blocked) { blocked = failure; onFailure(failure); }
    };
    // Only error text is classified. Normal JSON events and captured command
    // output carry data (rate_limit_info status lines, JD text mentioning
    // "rate limits") that must not trip the provider breaker.
    const plain = text => { errTail = (errTail + text + '\n').slice(-8000); notify(classifyFailure(text)); };
    const line = value => {
      let event; try { event = JSON.parse(value); } catch { if (!captureOutput) plain(value); return; }
      usage.ingest(event); notify(usage.failure);
    };
    const capture = (chunk, stdout) => {
      const text = chunk.toString();
      if (logPath) appendFileSync(logPath, text, { mode: 0o600 });
      tail = (tail + text).slice(-32000);
      if (stdout) {
        if (captureOutput) {
          output += text;
          if (output.length > 2_000_000) { overflow = true; output = ''; terminate(); }
        }
        buffer += text;
        let pos;
        while ((pos = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); }
      } else plain(text);
    };
    child.stdout.on('data', c => capture(c, true));
    child.stderr.on('data', c => capture(c, false));
    child.on('error', () => { spawnError = true; notify('worker_unavailable'); });
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.on('close', (code, sig) => {
      if (done) return; done = true;
      if (timedOut || cancelled) kill('SIGKILL');
      clearTimeout(timer); clearTimeout(killer); signal?.removeEventListener('abort', cancel);
      if (buffer.trim()) line(buffer);
      const failure = blocked || usage.failure || (overflow ? 'output_limit' : null) || classifyFailure(errTail, { timedOut, cancelled, spawnError, exitCode: code ?? 1 }) || (usage.terminal?.is_error ? 'worker_error' : null);
      notify(failure);
      resolve({ exit_code: code, signal: sig, failure, usage: usage.summary(), output_tail: tail, output });
    });
  });
}

export function validateResult(result, expected) {
  if (!result || typeof result !== 'object') return 'missing_result';
  if (result.attempt_id !== expected.attempt_id || result.job_id !== expected.job_id || String(result.num) !== String(expected.num)) return 'result_identity_mismatch';
  try { if (normalizeUrl(result.url) !== normalizeUrl(expected.url)) return 'result_identity_mismatch'; }
  catch { return 'result_identity_mismatch'; }
  if (result.company !== expected.company || result.role !== expected.role) return 'result_identity_mismatch';
  const allowed = isMail(expected.stage) ? ['ready', 'no_contact'] : ['submitted', 'dry_run_ok', 'needs_answer', 'skipped', 'failed'];
  if (!allowed.includes(result.status)) return 'invalid_result_status';
  if (expected.mode === 'dry-run' && result.status === 'submitted') return 'unexpected_submission';
  if (expected.mode === 'live' && result.status === 'dry_run_ok') return 'invalid_result_status';
  if (result.status === 'submitted' && !result.confirmation?.evidence) return 'missing_confirmation';
  if (result.status === 'ready' && (!result.to_email || !result.subject || !result.body || !Array.isArray(result.email_evidence) || !result.email_evidence.length)) return 'invalid_outreach';
  return null;
}

export function eligibleAttempt(records, { url, stage, mode, maxAttempts = 2, factsUpdatedAt = 0 }) {
  const id = jobId(url);
  // Fast and apply are two entrypoints to the SAME application, not new jobs.
  const familyOf = s => isMail(s) ? s : 'application';
  const family = familyOf(stage);
  const matching = records.filter(r => r.job_id === id && familyOf(r.stage) === family);
  if (matching.some(r => r.mode === 'live' && (r.status === 'submitted' || r.status === 'ready'))) return false;
  const attempts = matching.filter(r => r.mode === mode && !(r.status === 'needs_answer' && Date.parse(r.finished_at) < factsUpdatedAt));
  if (attempts.some(r => r.status === 'started' || r.status === 'uncertain')) return false;
  if (attempts.some(r => ['submitted', 'ready', 'skipped', 'no_contact', 'needs_answer', 'dry_run_ok'].includes(r.status))) return false;
  return attempts.length < maxAttempts;
}
