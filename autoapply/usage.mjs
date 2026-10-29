#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attemptRecords, TOKEN_KEYS } from './runtime.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

export function usageSummary(root, { day = new Date().toISOString().slice(0, 10), mode = 'live' } = {}) {
  const records = attemptRecords(root).filter(r => r.started_at?.startsWith(day) && r.mode === mode);
  const stages = {}, configurations = {};
  for (const r of records) {
    const key = `${r.stage}:${r.context_version || 'legacy'}:effort=${r.effort || 'inherited'}`;
    const group = configurations[key] ||= { attempts: 0, outcomes: {}, tokens: Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])), usage_unavailable: 0, model_calls: 0, tool_calls: 0, initial_input_total: 0, initial_input_samples: 0 };
    group.attempts++; group.outcomes[r.status] = (group.outcomes[r.status] || 0) + 1;
    if (r.usage?.available) for (const k of TOKEN_KEYS) group.tokens[k] += r.usage.tokens?.[k] || 0;
    else group.usage_unavailable++;
    group.model_calls += r.usage?.model_calls || 0; group.tool_calls += r.usage?.tool_calls || 0;
    if (Number.isFinite(r.usage?.first_input_tokens)) { group.initial_input_total += r.usage.first_input_tokens; group.initial_input_samples++; }
    const s = stages[r.stage] ||= { attempts: 0, outcomes: {}, failures: {}, usage_available: 0, usage_unavailable: 0, tokens: Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])), model_calls: 0, tool_calls: 0, duration_ms: 0, cli_cost_usd_known: 0, cost_unavailable: 0, models: [], first_input_samples: [] };
    s.attempts++; s.outcomes[r.status] = (s.outcomes[r.status] || 0) + 1;
    if (r.failure) s.failures[r.failure] = (s.failures[r.failure] || 0) + 1;
    if (r.reconciliation_error) s.failures.reconciliation = (s.failures.reconciliation || 0) + 1;
    if (r.usage?.available) { s.usage_available++; for (const k of TOKEN_KEYS) s.tokens[k] += r.usage.tokens?.[k] || 0; }
    else s.usage_unavailable++;
    s.model_calls += r.usage?.model_calls || 0; s.tool_calls += r.usage?.tool_calls || 0; s.duration_ms += r.duration_ms || 0;
    if (Number.isFinite(r.usage?.cli_cost_usd)) s.cli_cost_usd_known += r.usage.cli_cost_usd; else s.cost_unavailable++;
    s.models = [...new Set([...s.models, ...(r.usage?.models || [])])];
    if (Number.isFinite(r.usage?.first_input_tokens)) s.first_input_samples.push(r.usage.first_input_tokens);
  }
  for (const s of Object.values(stages)) {
    s.first_input_samples.sort((a, b) => a - b); const n = s.first_input_samples.length;
    s.median_first_input_tokens = n ? (s.first_input_samples[Math.floor((n - 1) / 2)] + s.first_input_samples[Math.floor(n / 2)]) / 2 : null;
    delete s.first_input_samples;
    s.confirmed_submissions = s.outcomes.submitted || 0;
    s.cli_cost_per_submission = s.confirmed_submissions && !s.cost_unavailable ? s.cli_cost_usd_known / s.confirmed_submissions : null;
  }
  for (const group of Object.values(configurations)) {
    group.mean_initial_input_tokens = group.initial_input_samples ? group.initial_input_total / group.initial_input_samples : null;
    delete group.initial_input_total;
    group.confirmed_submissions = group.outcomes.submitted || 0;
  }
  return { day, mode, attempts: records.length, stages, configurations };
}

export function formatUsage(summary) {
  const lines = [`Usage (${summary.day} UTC, ${summary.mode}): ${summary.attempts} attempts.`, 'Fast = evaluation + application combined; token categories include cached reads. CLI dollar estimates are not subscription charges.'];
  for (const [name, s] of Object.entries(summary.stages)) {
    lines.push(`${name}: ${s.attempts} attempts; outcomes ${JSON.stringify(s.outcomes)}; failures ${JSON.stringify(s.failures)}`);
    lines.push(`  Tokens: fresh ${s.tokens.input_tokens}, cache creation ${s.tokens.cache_creation_input_tokens}, cache reads ${s.tokens.cache_read_input_tokens}, output ${s.tokens.output_tokens}; usage missing for ${s.usage_unavailable} attempts.`);
    lines.push(`  Model calls ${s.model_calls}; tool calls ${s.tool_calls}; summed worker time ${(s.duration_ms / 1000).toFixed(1)}s; median first input ${s.median_first_input_tokens ?? 'unknown'}; models ${s.models.join(', ') || 'unknown'}.`);
    lines.push(`  Known CLI estimate $${s.cli_cost_usd_known.toFixed(4)}; cost missing for ${s.cost_unavailable} attempts; per confirmed submission ${s.cli_cost_per_submission === null ? 'unavailable' : '$' + s.cli_cost_per_submission.toFixed(4)}.`);
  }
  for (const [name, group] of Object.entries(summary.configurations || {})) {
    lines.push(`Configuration ${name}: ${group.attempts} attempts; ${group.confirmed_submissions} confirmed submissions; ${group.outcomes.needs_answer || 0} need answers; ${group.outcomes.uncertain || 0} uncertain; mean first input ${group.mean_initial_input_tokens ?? 'unknown'} tokens. Usage missing for ${group.usage_unavailable} attempts.`);
  }
  return lines.join('\n');
}
if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const dateIndex = args.indexOf('--day');
  const summary = usageSummary(process.env.AUTOAPPLY_ROOT || dirname(dirname(fileURLToPath(import.meta.url))), { day: dateIndex < 0 ? undefined : args[dateIndex + 1], mode: args.includes('--dry-run') ? 'dry-run' : 'live' });
  console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : formatUsage(summary));
}
