#!/usr/bin/env node
// Hunter.io lookups for the outreach worker. Plain API calls, zero model tokens.
// Prints compact JSON. Exit 3 when HUNTER_API_KEY is missing so the worker
// falls back to public-web search. Free plan: ~50 credits/month.
//   node autoapply/hunter.mjs domain <domain> [department]
//   node autoapply/hunter.mjs find <domain> <first> <last>
//   node autoapply/hunter.mjs verify <email>
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || dirname(dirname(fileURLToPath(import.meta.url)));
const API = 'https://api.hunter.io/v2';

export function apiKey(root = ROOT) {
  if (process.env.HUNTER_API_KEY) return process.env.HUNTER_API_KEY;
  const env = join(root, '.env');
  if (!existsSync(env)) return null;
  return readFileSync(env, 'utf8').match(/^HUNTER_API_KEY=(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '') || null;
}

const sources = s => (s || []).map(x => x.uri).filter(Boolean).slice(0, 3);

export function compact(kind, data) {
  if (kind === 'domain') return {
    domain: data.domain, organization: data.organization, pattern: data.pattern || null,
    people: (data.emails || []).map(e => ({ name: [e.first_name, e.last_name].filter(Boolean).join(' ') || null, position: e.position, department: e.department, email: e.value, type: e.type, confidence: e.confidence, verification: e.verification?.status || null, sources: sources(e.sources) })),
  };
  if (kind === 'find') return { email: data.email, score: data.score, position: data.position, verification: data.verification?.status || null, sources: sources(data.sources) };
  return { email: data.email, status: data.status, score: data.score };
}

export async function hunter(kind, args, { key = apiKey(), fetchFn = fetch } = {}) {
  if (!key) return { exit: 3, out: { error: 'HUNTER_API_KEY not set' } };
  const params = kind === 'domain' ? { domain: args[0], limit: '10', ...(args[1] && { department: args[1] }) }
    : kind === 'find' ? { domain: args[0], first_name: args[1], last_name: args[2] }
    : kind === 'verify' ? { email: args[0] } : null;
  if (!params || Object.values(params).some(v => !v)) return { exit: 2, out: { error: 'usage: domain <domain> [department] | find <domain> <first> <last> | verify <email>' } };
  const url = `${API}/${{ domain: 'domain-search', find: 'email-finder', verify: 'email-verifier' }[kind]}?${new URLSearchParams({ ...params, api_key: key })}`;
  for (let i = 0; i < 4; i++) {
    const res = await fetchFn(url);
    const body = await res.json().catch(() => ({}));
    if (res.status === 202) { await new Promise(r => setTimeout(r, 3000)); continue; } // verifier still running
    if (!res.ok) return { exit: 1, out: { error: body.errors?.[0]?.details || `HTTP ${res.status}`, status: res.status } };
    return { exit: 0, out: compact(kind, body.data || {}) };
  }
  return { exit: 1, out: { error: 'verification still pending' } };
}

if (isMainModule(import.meta.url)) {
  const [kind, ...args] = process.argv.slice(2);
  const { exit, out } = await hunter(kind, args);
  console.log(JSON.stringify(out)); process.exitCode = exit;
}
