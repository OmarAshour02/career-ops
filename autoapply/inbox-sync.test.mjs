import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, matchApp, nextStatus, nameVariants, isJobMail } from './inbox-sync.mjs';

const mail = (subject, text, from = 'no-reply@us.greenhouse-mail.io', date = '2026-10-26T10:00:00+00:00') => ({ uid: 1, subject, text, from, date });
const app = (id, company, role, date = '2026-10-20', status = 'Applied') => ({ id, company, role, date, status });

test('classify: real rejection wording from ATS mails', () => {
  for (const text of [
    "We've reviewed your application for the Graduate Software Engineer role and won't be moving forward this time.",
    'Unfortunately, on this occasion, we will not be progressing your application as other applicants are a closer fit.',
    'We have read it properly, and I am afraid we are not taking it forward to interview.',
    'We received applications from many qualified candidates and unfortunately are going in a direction that better fits our needs at this time.',
  ]) assert.equal(classify(mail('Update on your application', text)).kind, 'rejected', text);
});

test('classify: a receipt that says "if you are not selected" stays a receipt', () => {
  const r = classify(mail('Thank you for your application to Figma', 'Thanks for applying! If you are not selected for this position, keep an eye on our jobs page.'));
  assert.equal(r.kind, 'received');
});

test('classify: closed, noise, conditional invite, and invite-in-receipt goes to Haiku', () => {
  assert.equal(classify(mail('Amazon application: Status update', 'Unfortunately, this position is no longer available.')).kind, 'closed');
  assert.equal(classify(mail('Security code for your application to Stripe', 'Your code is 123456')).kind, 'noise');
  const invite = classify(mail('Interview', 'We would like to schedule an interview with you next week.'));
  assert.deepEqual([invite.kind, invite.sure], ['interview', true]);
  assert.equal(classify(mail('Thanks for applying', 'Thank you for applying. If your profile fits, we will schedule an interview.')).kind, 'received');
  const mixed = classify(mail('Thanks for applying', 'Thank you for applying. We would like to schedule an interview.'));
  assert.deepEqual([mixed.kind, mixed.sure], ['interview', false]);
});

test('nameVariants: board slugs map to the real name', () => {
  assert.ok(nameVariants('soundcloud71').includes('soundcloud'));
  assert.ok(nameVariants('usenourish').includes('nourish'));
  assert.ok(nameVariants('eqvilentjobs').includes('eqvilent'));
});

test('matchApp: slug company via subject, sender domain, and role picks between apps', () => {
  const apps = [app('480', 'soundcloud71', 'Backend Engineer - Media Streaming'), app('675', 'platacard', 'Platform Engineer'),
    app('520', 'toast', 'Senior Software Engineer, IQ Grow'), app('521', 'toast', 'Senior Software Engineer - Product-Led Growth')];
  assert.equal(matchApp(mail('Your application for Backend Engineer - Media Streaming at SoundCloud', 'Hi Jane'), apps).app.id, '480');
  assert.equal(matchApp(mail('Your application', 'Hi Jane', 'no-reply@plata.careers'), apps).app.id, '675');
  const m = matchApp(mail('Update on your Senior Software Engineer, IQ Grow application with Toast', 'Hi Jane'), apps);
  assert.deepEqual([m.app.id, m.how], ['520', 'role']);
});

test('matchApp: an older mail never lands on a newer application', () => {
  const apps = [app('746', 'N26', 'Senior Site Reliability Engineer', '2026-10-25')];
  assert.equal(matchApp(mail('N26: Your Application for Backend Engineer', 'Hi Jane', 'no-reply@n26.com', '2026-09-17T10:00:00Z'), apps), null);
});

test('isJobMail: LinkedIn and shop mail are ignored', () => {
  assert.equal(isJobMail(mail('Your application was viewed', 'x', 'jobs-noreply@linkedin.com'), null), false);
  assert.equal(isJobMail(mail('Delivered: Kitchen strainer', 'x', 'order-update@amazon.eg'), null), false);
});

test('nextStatus: only forward, terminal stays, offer always wins', () => {
  assert.equal(nextStatus('Applied', 'rejected'), 'Rejected');
  assert.equal(nextStatus('Interview', 'in_process'), null);
  assert.equal(nextStatus('Applied', 'interview'), 'Interview');
  assert.equal(nextStatus('Rejected', 'interview'), null);
  assert.equal(nextStatus('Rejected', 'offer'), 'Offer');
  assert.equal(nextStatus('Applied', 'received'), null);
});
