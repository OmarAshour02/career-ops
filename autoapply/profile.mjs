// The owner's settings (config/apply-facts.yml) as prompt values, so prompts and scripts hold no personal data.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { isMainModule } from '../lib/is-main-module.mjs';

export function loadFacts(root) {
  const p = join(root, 'config/apply-facts.yml');
  return existsSync(p) ? loadYaml(readFileSync(p, 'utf8')) || {} : {};
}

export const resumePath = (facts) => facts.resume?.pdf || 'output/master/resume.pdf';

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const joinOr = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`);

// {{KEY}} values shared by every worker prompt (letters only: the runner's placeholder syntax).
export function promptValues(facts) {
  const c = facts.contact || {}, p = facts.profile || {}, o = facts.outreach || {}, consent = facts.consent || {};
  const auth = list(facts.work_authorization?.authorized_in);
  const points = list(o.proof_points).map((x) => `     - ${String(x.text || x).trim()}${x.use_for ? ` ${String(x.use_for).trim()}` : ''}`);
  const v = {
    ME: c.full_name || 'the candidate',
    FIRST: c.first_name || c.full_name || 'the candidate',
    TITLE: p.title || 'software engineer',
    CITY: p.home_city || String(c.location || '').split(',')[0].trim(),
    COUNTRY: p.home_country || String(c.location || '').split(',').at(-1).trim(),
    AUTHIN: joinOr(auth) || p.home_country || '',
    TARGET: p.target_work || 'software engineering work',
    OFFTARGET: p.off_target || 'roles far from your field',
    VOICE: p.voice || 'simple plain English, short sentences, first person, friendly, direct',
    MINSCORE: String(facts.limits?.min_score ?? 3),
    RESUME: resumePath(facts),
    SUBMITOK: consent.auto_submit_since || 'NOT GIVEN',
    EMAILOK: consent.outreach_email_since || 'NOT GIVEN',
    COLDOK: consent.cold_email_since || 'NOT GIVEN',
    SIGNOFF: JSON.stringify(String(o.signoff || `Thanks,\n${c.full_name || ''}`)).slice(1, -1),
    HEADLINE: o.headline
      ? `Lead proof point, one short line: "${o.headline}"\n     ${o.headline_rule || 'Say exactly that.'} Then one proof point from cv.md.`
      : 'One proof point from cv.md.',
    POINTS: points.length ? `     Pick the one that fits the company best:\n${points.join('\n')}` : '     Pick the strongest one with a real number.',
    RULES: list(o.rules).map((r) => `- ${r}`).join('\n'),
  };
  v.TITLECAP = v.TITLE.charAt(0).toUpperCase() + v.TITLE.slice(1);
  const sponsor = facts.work_authorization?.needs_sponsorship !== false;
  v.VISA = sponsor
    ? `remote is fine; if the work is on-site outside ${v.AUTHIN}, one honest line that ${v.FIRST} is in ${v.CITY} and would need visa sponsorship.`
    : 'mention location only if the posting makes it matter.';
  v.AUTHLINE = sponsor ? `${v.FIRST} is authorized only in ${v.AUTHIN} and needs sponsorship elsewhere.` : `${v.FIRST} is authorized to work in ${v.AUTHIN}.`;
  return v;
}

// AI model per job. prescore 'auto' = free DeepSeek through opencode when installed, else Claude Haiku.
export const MODEL_DEFAULTS = { apply: 'claude-haiku-5-5', outreach: 'claude-haiku-5-5', inbox: 'claude-haiku-5-5', cv: 'claude-sonnet-5-5', prescore: 'auto' };
export const modelFor = (facts, job) => facts.models?.[job] || MODEL_DEFAULTS[job];

// Which stages may act for real. A shared copy starts with no consent, so live runs refuse until the owner opts in.
export function consentFor(facts, stage) {
  const c = facts.consent || {};
  return Boolean({ fast: c.auto_submit_since, apply: c.auto_submit_since, outreach: c.outreach_email_since, cold: c.cold_email_since }[stage]);
}

// CLI for shell scripts: node autoapply/profile.mjs get schedule.cold_outreach | model apply
if (isMainModule(import.meta.url) && ['get', 'model'].includes(process.argv[2])) {
  const root = process.env.AUTOAPPLY_ROOT || join(import.meta.dirname, '..');
  const facts = loadFacts(root);
  const value = process.argv[2] === 'model' ? modelFor(facts, process.argv[3]) : process.argv[3].split('.').reduce((o, k) => o?.[k], facts);
  console.log(value ?? '');
}
