// Makes a demo career-ops folder with made-up applications, inbox events and outreach, so the app can be
// tried (or screenshotted) without anyone's real data. Every company, person and email here is fictional.
//   node desktop/demo.mjs /tmp/career-ops-demo
//   cd desktop && CAREER_OPS_ROOT=/tmp/career-ops-demo npx electron .
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const DIR = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node desktop/demo.mjs <empty folder>');
// Only ever clears a folder this script made before (it carries a .demo marker).
if (existsSync(DIR) && readdirSync(DIR).length && !existsSync(join(DIR, '.demo'))) throw new Error(`${DIR} is not empty; pick an empty or new folder.`);
rmSync(DIR, { recursive: true, force: true });

const w = (rel, text) => { mkdirSync(join(DIR, rel, '..'), { recursive: true }); writeFileSync(join(DIR, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 1)); };
// The app runs code from the real repo and data from here.
mkdirSync(join(DIR, 'autoapply'), { recursive: true });
symlinkSync(join(REPO, 'desktop'), join(DIR, 'desktop'));
symlinkSync(join(REPO, 'autoapply/runner.mjs'), join(DIR, 'autoapply/runner.mjs'));
w('.demo', 'made by desktop/demo.mjs\n');

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const now = Date.now(), DAY = 86_400_000;
const iso = (daysAgo, hour = 10) => new Date(now - daysAgo * DAY - (now % DAY) + hour * 3_600_000 + Math.floor(rnd() * 3_000_000)).toISOString();
const pad = (n) => String(n).padStart(3, '0');
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const COMPANIES = ['Northwind Labs', 'Bluefin Data', 'Orbit Robotics', 'Kestrel Security', 'Quillstack', 'Harbor Freight Tech', 'Fernway', 'Tidepool Analytics',
  'Copperline', 'Brightloop', 'Nimbus Cloud', 'Saffron AI', 'Granite Payments', 'Pinecrest Games', 'Atlas Mobility', 'Verdant Energy', 'Juniper Health',
  'Cobalt Systems', 'Lumen Health', 'Maple Ledger', 'Driftwood', 'Helix Bio', 'Paperplane', 'Sundial', 'Waypoint Maps', 'Ironbark', 'Glasshouse',
  'Starling Freight', 'Mosaic Learning', 'Riverbank', 'Tessellate', 'Halcyon Travel', 'Beacon Insurance', 'Lattice Works', 'Foxglove', 'Meridian Ads'];
const ROLES = ['Backend Engineer', 'Platform Engineer', 'Site Reliability Engineer', 'Software Engineer, Infrastructure', 'Backend Engineer (Go)',
  'Software Engineer, Payments', 'Data Platform Engineer', 'Backend Engineer (Python)', 'SRE II', 'Software Engineer, Developer Tools'];
const CITIES = ['London', 'Berlin', 'Amsterdam', 'Remote (EU)', 'Dublin'];
const SALARY = { London: '£62,000', Berlin: '€64,000', Amsterdam: '€62,000', 'Remote (EU)': '€60,000', Dublin: '€63,000' };

// status of each sent application, newest first: a few moved by email, most still waiting
const FATE = ['Interview', 'Applied', 'Rejected', 'Applied', 'Responded', 'Applied', 'Applied', 'Rejected', 'Interview', 'Applied', 'Applied', 'Rejected',
  'Applied', 'Offer', 'Applied', 'Rejected', 'Applied', 'Applied', 'Responded', 'Rejected', 'Applied', 'Applied', 'Rejected', 'Applied', 'Applied', 'Rejected',
  'Interview', 'Applied', 'Rejected', 'Applied'];
const SKIPS = [['too_senior', 'Asks for 8+ years and staff-level scope.'], ['low_score', 'Mostly frontend (React); little backend work.'],
  ['location', 'On-site in San Francisco only.'], ['no_sponsorship', 'Posting says no visa sponsorship.'], ['closed', 'The posting is no longer open.'],
  ['off_target', 'Sales engineering role.']];
const MISSING = ['Do you hold an active UK security clearance?', 'Which office would you prefer: London or Manchester?', 'How many years of Kotlin do you have?'];

const tracker = ['# Applications Tracker', '', '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |', '|---|------|---------|------|-------|--------|-----|--------|-------|'];
const events = [], outreach = [];
let uid = 5100, num = 0, row = 0;
const result = (r) => w(`autoapply/results/${r.num}.json`, r);

FATE.forEach((fate, i) => {
  const n = pad(++num), company = COMPANIES[i], role = pick(ROLES), city = pick(CITIES), days = Math.floor(i * 0.7) + 1;
  const at = iso(days), score = Math.round((3.4 + rnd() * 1.4) * 10) / 10, url = `https://jobs.example.com/${slug(company)}/${slug(role)}`;
  const report = `reports/${n}-${slug(company)}.md`;
  w(report, `# ${company} — ${role}\n\n**Score:** ${score}/5 · **Location:** ${city}\n\n## Why it fits\n\n- Backend services in Go and Python, the same stack as your last role.\n- The team runs its own on-call; your SRE work maps well.\n\n## Gaps\n\n- They mention Kafka; you have used it only briefly.\n`);
  result({ attempt_id: `demo-${n}`, num: n, url, company, role, status: 'submitted', reason: '', score, report, city, finished_at: at,
    answers: [
      { question: 'Are you legally authorized to work in the country of this job?', answer: 'No', source: 'apply-facts.yml' },
      { question: 'Will you now or in the future require visa sponsorship?', answer: 'Yes', source: 'apply-facts.yml' },
      { question: 'What is your notice period?', answer: '30 days', source: 'apply-facts.yml' },
      { question: 'Expected annual salary', answer: SALARY[city], source: 'apply-facts.yml (salary)' },
      { question: 'LinkedIn profile', answer: 'linkedin.com/in/janesmith-demo', source: 'apply-facts.yml' },
      { question: `Why do you want to work at ${company}?`, answer: `I like that the ${role.toLowerCase()} team owns its services end to end. At my last job I cut deploy downtime to about 6 seconds, and I would like to do that kind of work here.`, source: 'cv.md' },
    ],
    confirmation: { evidence: 'Thank-you page: "Your application has been received."' }, questions_missing: [], screenshots: [] });
  tracker.push(`| ${++row} | ${at.slice(0, 10)} | ${company} | ${role} | ${score}/5 | ${fate} | ✅ | [${n}](${report}) | |`);
  const from = `${company} Recruiting <no-reply@${slug(company)}.example>`;
  const ev = (kind, d, subject, reason, quote, to) => events.push({ uid: ++uid, date: iso(d, 15), from, subject, kind, by: kind === 'received' ? 'rules' : pick(['rules', 'rules', 'ai']),
    reason, quote, snippet: quote, num: n, company, role, match: 'company', status_from: 'Applied', status_to: to, error: null });
  ev('received', days, `Thanks for applying to ${company}`, 'Confirms they got your application.', `We have received your application for ${role}.`, null);
  const later = Math.max(0, days - 2);
  if (fate === 'Rejected') ev('rejected', later, `Your application to ${company}`, 'They chose other candidates.', 'we have decided to move forward with other candidates', 'Rejected');
  if (fate === 'Responded') ev('in_process', later, `${role} at ${company}: next steps`, 'The team is reviewing your application.', 'your application is now with the hiring team', 'Responded');
  if (fate === 'Interview') ev('interview', later, `Interview invitation: ${role}`, 'They want to book a first call with you.', "we'd love to schedule a 30-minute call with you", 'Interview');
  if (fate === 'Offer') { ev('interview', days - 1, `Interview invitation: ${role}`, 'They want to book a first call with you.', "we'd love to schedule a 30-minute call with you", 'Interview');
    ev('offer', 0, `Offer: ${role} at ${company}`, 'They sent you an offer.', 'we are delighted to offer you the position', 'Offer'); }
  if (i < 16) {
    const first = pick(['Maya', 'Tom', 'Priya', 'Lukas', 'Sara', 'Daniel', 'Ines', 'Omid']), last = pick(['Hart', 'Novak', 'Reyes', 'Brandt', 'Okafor', 'Lind']);
    const sent = i % 5 !== 4;
    outreach.push({ num: n, company, role, url, status: 'ready', to_name: `${first} ${last}`, to_title: pick(['Engineering Manager', 'Technical Recruiter', 'Head of Platform']),
      to_email: `${first.toLowerCase()}@${slug(company)}.example`, email_evidence: [`https://${slug(company)}.example/team`], person_evidence: 'Team page lists them as the hiring manager.',
      subject: `${role} role at ${company} - applied, quick note`,
      body: `Hi ${first},\n\nI just applied for the ${role} role. I cut deploy downtime to about 6 seconds at my last job, and I'd like to bring that care to your platform team.\n\nHappy to share more if useful.\n\nThanks,\nJane Smith`,
      created_at: at, ...(sent ? { sent_at: iso(days - 0.2, 12) } : {}), ...(i === 2 || i === 8 ? { replied_at: iso(Math.max(0, days - 3), 16) } : {}),
      ...(i === 5 || i === 11 ? { followup_at: iso(Math.max(0, days - 5), 11) } : {}), ...(i === 13 ? { bounced: true } : {}) });
  }
});

SKIPS.concat(SKIPS, SKIPS.slice(0, 3)).forEach(([reason, detail], i) => {
  const n = pad(++num), company = COMPANIES[(i + 7) % COMPANIES.length] + (i > 5 ? ' Labs' : ''), role = pick(ROLES);
  result({ attempt_id: `demo-${n}`, num: n, url: `https://jobs.example.com/${slug(company)}/${n}`, company, role, status: 'skipped', reason, detail, score: reason === 'low_score' ? 2.1 : null, finished_at: iso(i % 9 + 1, 9) });
});
MISSING.forEach((q, i) => {
  const n = pad(++num), company = ['Beacon Insurance', 'Lattice Works', 'Foxglove'][i], role = pick(ROLES);
  result({ attempt_id: `demo-${n}`, num: n, url: `https://jobs.example.com/${slug(company)}/${n}`, company, role, status: 'needs_answer', reason: 'A required question has no answer in your files. Nothing was submitted.', questions_missing: [q], score: 4.1, finished_at: iso(i + 1, 11) });
});
result({ attempt_id: 'demo-cap', num: pad(++num), url: 'https://jobs.example.com/meridian-ads/1', company: 'Meridian Ads', role: 'Backend Engineer', status: 'skipped', reason: 'captcha: hCaptcha on the submit button', score: 3.9, finished_at: iso(1, 13) });

['Ploughshare', 'Kitebird', 'Umbra Audio', 'Seedling Finance', 'Larkspur', 'Cinder Studio'].forEach((company, i) => outreach.push({
  num: `s-${slug(company)}`, kind: 'startup', company, role: 'Backend / platform', url: `https://${slug(company)}.example`, status: 'ready', to_name: pick(['Alex', 'Noor', 'Jonas', 'Chloe']) + ' ' + pick(['Weber', 'Haddad', 'Moreau']),
  to_title: 'CTO', to_email: `cto@${slug(company)}.example`, email_evidence: [`https://${slug(company)}.example/about`], subject: `Backend engineer for ${company}?`,
  body: `Hi,\n\nI saw ${company} is growing its platform. I build reliable backend services and would love to help.\n\nThanks,\nJane Smith`,
  created_at: iso(i + 1), ...(i < 4 ? { sent_at: iso(i + 0.8) } : {}), ...(i === 1 ? { replied_at: iso(0.5) } : {}),
}));
outreach.forEach((d) => w(`autoapply/outreach/${d.num}.json`, d));

events.push({ uid: ++uid, date: iso(0, 9), from: 'Talent Team <talent@riverbank.example>', subject: 'Coding exercise for your application', kind: 'assessment', by: 'ai',
  reason: 'They sent a take-home task; this job was applied to by hand, so it is not linked yet.', quote: 'please complete the attached exercise within 5 days', snippet: '', num: null, company: null, role: null, match: '', status_from: null, status_to: null, error: null });
w('autoapply/inbox/events.json', events);
w('autoapply/inbox/state.json', { last_uid: uid, synced_at: new Date(now - 2 * 3_600_000).toISOString(), last_ai_cost_usd: 0.004, last_ai_error: null });
w('data/applications.md', `${tracker.join('\n')}\n`);
const today = new Date(now).toISOString().slice(0, 10);
w(`autoapply/summary-${today}.md`, `# Daily run ${today}\n\n**Applied: 6 · Skipped: 14 · Need your answer: 2 · Failed: 0**\n`);
w('cv.md', '# Jane Smith\n\nLondon, UK · jane@example.com\n\n## Work Experience\n\n### Backend Engineer — Example Corp\n*2023 - Present · London*\n\n- Cut deploy downtime to about 6 seconds with readiness checks and automatic rollback.\n');
const facts = readFileSync(join(REPO, 'config/apply-facts.example.yml'), 'utf8')
  .replace('full_name: ""', 'full_name: "Jane Smith"').replace('first_name: ""', 'first_name: "Jane"').replace('last_name: ""', 'last_name: "Smith"')
  .replace('email: ""', 'email: "jane@example.com"').replace('location: ""', 'location: "London, UK"')
  .replace('auto_submit_since: ""', 'auto_submit_since: "2026-10-01"').replace('outreach_email_since: ""', 'outreach_email_since: "2026-10-01"');
w('config/apply-facts.yml', facts);
console.log(`Demo folder ready: ${DIR}\nOpen it: cd "${join(REPO, 'desktop')}" && CAREER_OPS_ROOT="${DIR}" npx electron .`);
