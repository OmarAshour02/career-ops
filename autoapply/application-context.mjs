// Per-attempt instructions and advisory form metadata. Never decides eligibility.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAtsApi } from '../liveness-api.mjs';

export const APPLICATION_TOOLS = 'Bash,Read,Write,Edit,WebFetch,WebSearch';
export const CONTEXT_VERSION = 'application-context-v1';
const render = (text, values) => text.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => String(values[key] ?? ''));

export function prepareApplicationRules(dir, values, payloadPath) {
  const rules = render(readFileSync(join(import.meta.dirname, 'apply-prompt.md'), 'utf8'), values)
    .replaceAll(`autoapply/results/${values.NUM}.json`, payloadPath);
  const path = join(dir, 'apply-instructions.md');
  writeFileSync(path, rules, { mode: 0o600 });
  return path;
}

export function candidateSourceIndex(root) {
  // Paths only; factual claims still come from the original user-authored files.
  return ['config/apply-facts.yml', 'config/profile.yml', 'cv.md', 'voice-dna.md']
    .filter(path => existsSync(join(root, path)));
}

export async function fetchFormPreview(url, { fetchImpl = fetch, signal, timeoutMs = 5000 } = {}) {
  const resolved = resolveAtsApi(url);
  if (resolved?.ats !== 'greenhouse') return { status: 'unsupported' };
  const api = new URL(resolved.apiUrl); api.searchParams.set('questions', 'true');
  try {
    const response = await fetchImpl(api.href, {
      method: 'GET', redirect: 'error', headers: { accept: 'application/json' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { status: 'unavailable' };
    const text = await response.text();
    if (text.length > 500_000) return { status: 'unavailable' };
    const body = JSON.parse(text);
    // A wrong or incomplete payload cannot become an application gate.
    if (String(body.id) !== String(resolved.parts.id) || !Array.isArray(body.questions)) return { status: 'unavailable' };
    const groups = ['questions', 'location_questions', 'compliance'];
    const questions = groups.flatMap(group => (Array.isArray(body[group]) ? body[group] : [])
      .map(q => ({ group, label: q.label, required: q.required, fields: q.fields })));
    if (body.demographic_questions?.questions) questions.push(...body.demographic_questions.questions.map(q => ({ group: 'demographic_questions', ...q })));
    return { status: 'available', source_url: api.href, advisory_only: true, questions };
  } catch { return { status: 'unavailable' }; }
}
