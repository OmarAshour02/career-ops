import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promptValues, consentFor } from '../../autoapply/profile.mjs';

const facts = {
  contact: { full_name: 'Sam Lee', first_name: 'Sam', location: 'Lisbon, Portugal' },
  work_authorization: { authorized_in: ['Portugal', 'EU'], needs_sponsorship: true },
  profile: { title: 'frontend engineer' },
  outreach: { signoff: 'Thanks,\nSam', proof_points: [{ text: 'Cut page load 40%.', use_for: 'For web companies.' }], rules: ['Keep it short.'] },
  limits: { min_score: 3.2 },
  consent: { auto_submit_since: '2026-01-01' },
};

test('promptValues: fills prompt fields from settings', () => {
  const v = promptValues(facts);
  assert.equal(v.ME, 'Sam Lee');
  assert.equal(v.CITY, 'Lisbon');
  assert.equal(v.AUTHIN, 'Portugal or EU');
  assert.equal(v.TITLECAP, 'Frontend engineer');
  assert.equal(v.SIGNOFF, 'Thanks,\\nSam');
  assert.equal(v.MINSCORE, '3.2');
  assert.match(v.POINTS, /Cut page load 40%\. For web companies\./);
  assert.equal(v.RULES, '- Keep it short.');
  assert.match(v.VISA, /outside Portugal or EU.*Sam is in Lisbon/);
  assert.match(v.HEADLINE, /^One proof point/);
});

test('promptValues: an empty config still renders (no undefined in prompts)', () => {
  for (const [k, val] of Object.entries(promptValues({}))) assert.equal(typeof val, 'string', k);
});

test('consentFor: each stage needs its own recorded OK', () => {
  assert.equal(consentFor(facts, 'fast'), true);
  assert.equal(consentFor(facts, 'apply'), true);
  assert.equal(consentFor(facts, 'outreach'), false);
  assert.equal(consentFor(facts, 'cold'), false);
});
