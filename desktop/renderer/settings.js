// Settings view + first-run setup. Uses $, esc, toast, ui, render from app.js (shared global scope).
'use strict';

let S = null; // last settings snapshot from the main process

const DEDICATED = new Set(['contact', 'work_authorization', 'outreach', 'limits', 'profile', 'resume', 'consent', 'schedule', 'salary', 'answers_from_app', 'models']);
const SET_TABS = [['profile', 'Profile'], ['email', 'Email account'], ['resume', 'Resume & CV'], ['writing', 'Outreach writing'], ['answers', 'Answer bank'], ['run', 'Run controls'], ['folder', 'Folder']];

const get = (path, obj = S?.facts) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const human = (k) => String(k).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const today = () => new Date().toLocaleDateString('en-CA');

async function loadSettings() {
  const r = await window.co.settings();
  if (!r.ok) { toast(`Could not read settings: ${r.error}`, 0); return null; }
  S = r.value;
  return S;
}

// ---------- form fields ----------
// type: text | number | bool | list | multiline | consent | select
function field(label, key, { type = 'text', hint = '', placeholder = '', value, wide = false, options = [] } = {}) {
  const v = value !== undefined ? value : get(key);
  const id = `f-${key.replace(/[^\w]/g, '-')}`;
  let input;
  if (type === 'bool') input = `<label class="switch"><input type="checkbox" id="${id}" data-key="${esc(key)}" data-type="bool" ${v ? 'checked' : ''}><span></span></label>`;
  else if (type === 'consent') input = `<label class="check"><input type="checkbox" data-key="${esc(key)}" data-type="consent" data-was="${esc(v || '')}" ${v ? 'checked' : ''}> <span>${v ? `Allowed since ${esc(v)}` : 'Not allowed'}</span></label>`;
  else if (type === 'multiline') input = `<textarea id="${id}" data-key="${esc(key)}" data-type="text" rows="${Math.min(8, Math.max(2, String(v ?? '').split('\n').length + 1))}" placeholder="${esc(placeholder)}">${esc(v ?? '')}</textarea>`;
  else if (type === 'select') input = `<select id="${id}" data-key="${esc(key)}" data-type="text">${options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v ?? '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select>`;
  else if (type === 'list') input = `<input id="${id}" data-key="${esc(key)}" data-type="list" value="${esc(Array.isArray(v) ? v.join(', ') : v ?? '')}" placeholder="${esc(placeholder || 'comma separated')}">`;
  else input = `<input id="${id}" data-key="${esc(key)}" data-type="${type}" type="${type === 'number' ? 'number' : 'text'}" step="any" value="${esc(v ?? '')}" placeholder="${esc(placeholder)}">`;
  return `<div class="field ${type === 'multiline' || wide ? 'wide' : ''}"><label for="${id}">${esc(label)}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}

function collect(scope) {
  const patch = [];
  for (const el of scope.querySelectorAll('[data-key]')) {
    const keys = el.dataset.path ? JSON.parse(el.dataset.path) : el.dataset.key.split('.');
    const t = el.dataset.type;
    let v = el.value;
    if (t === 'bool') v = el.checked;
    else if (t === 'consent') v = el.checked ? el.dataset.was || today() : '';
    else if (t === 'number') { if (v === '') continue; v = Number(v); }
    else if (t === 'list') v = v.split(',').map((x) => x.trim()).filter(Boolean);
    else if (t === 'lines') v = v.split('\n').map((x) => x.trim()).filter(Boolean);
    patch.push([keys, v]);
  }
  return patch;
}

async function save(patch, msg = 'Saved.') {
  const r = await window.co.saveSettings(patch);
  if (!r.ok) return toast(`Could not save: ${r.error}`, 0);
  S = { ...S, ...r.value };
  toast(msg, 2500);
  renderSettingsInto();
}

const card = (title, body, { saveId, hint, actions = '' } = {}) => `<div class="card set-card" ${saveId ? `data-card="${saveId}"` : ''}>
  <h2>${title}${hint ? `<span class="hint">${hint}</span>` : ''}</h2><div class="fields">${body}</div>
  ${saveId || actions ? `<div class="set-actions">${actions}${saveId ? `<button class="btn primary small" data-s-save="${saveId}">Save</button>` : ''}</div>` : ''}</div>`;

// ---------- tabs ----------
function tabProfile() {
  return card('About you', [
    field('Full name', 'contact.full_name'), field('First name', 'contact.first_name'), field('Last name', 'contact.last_name'),
    field('Email on applications', 'contact.email'), field('Phone', 'contact.phone', { placeholder: '+44 ...' }), field('Location', 'contact.location', { placeholder: 'City, Country' }),
    field('LinkedIn', 'contact.linkedin'), field('GitHub', 'contact.github'), field('Website', 'contact.website'),
  ].join(''), { saveId: 'profile', hint: 'Used to fill forms and sign emails' })
  + card('How emails describe you', [
    field('Title', 'profile.title', { placeholder: 'backend engineer', hint: 'e.g. "backend engineer", "data engineer"' }),
    field('Home city', 'profile.home_city'), field('Home country', 'profile.home_country'),
    field('Work you want', 'profile.target_work', { type: 'multiline', hint: 'Jobs outside this are skipped.' }),
    field('Work you don\'t want', 'profile.off_target', { type: 'multiline' }),
    field('Writing voice', 'profile.voice', { type: 'multiline' }),
  ].join(''), { saveId: 'profile2' })
  + card('Work authorization', [
    field('Can work in (no visa)', 'work_authorization.authorized_in', { type: 'list', placeholder: 'Country, ...' }),
    field('Needs visa sponsorship elsewhere', 'work_authorization.needs_sponsorship', { type: 'bool' }),
    field('Willing to relocate', 'work_authorization.willing_to_relocate', { type: 'bool' }),
    field('Remote OK', 'work_authorization.remote_ok', { type: 'bool' }),
    field('Skip if posting says no sponsorship', 'work_authorization.skip_if_posting_says_no_sponsorship', { type: 'bool' }),
    field('Notice period (days)', 'availability.notice_period_days', { type: 'number' }),
    field('Earliest start', 'availability.earliest_start'),
  ].join(''), { saveId: 'auth', hint: 'Always answered truthfully' });
}

function tabEmail() {
  const e = S.email;
  return card('Gmail account', `
    <div class="field"><label>Gmail address</label><input id="env-user" value="${esc(e.user)}" placeholder="you@gmail.com"></div>
    <div class="field"><label>App password</label><input id="env-pass" type="password" placeholder="${e.hasPassword ? '•••• saved (leave empty to keep)' : '16 letters from Google'}"></div>
    <div class="field"><label>Hunter API key (optional)</label><input id="env-hunter" type="password" placeholder="${e.hunter ? '•••• saved' : 'helps find contact emails'}"></div>
    <div class="field wide"><div class="hint">Used to send outreach, read replies and rejections, and fetch verification codes. Make an app password at
      <a data-url="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</a> (needs 2-step verification). Saved in <code>.env</code> inside your career-ops folder.</div></div>`,
    { actions: '<button class="btn small" data-s-act="email-test">Test login</button><button class="btn primary small" data-s-act="email-save">Save</button>' });
}

function tabResume() {
  const r = S.resume;
  return card('Resume PDF', `
    <div class="field wide">${r.missing ? `<div class="note">${r.path ? `File not found: ${esc(r.path)}` : 'No resume chosen yet.'}</div>` : `<div class="hint">${esc(r.path)} · ${(r.size / 1024).toFixed(0)} KB · changed ${esc(fmtDate(r.modified))}</div>`}</div>
    ${field('File name companies see', 'resume.send_as', { placeholder: 'First_Last_Resume.pdf' })}
    <div class="field wide"><div style="display:flex;gap:8px"><button class="btn small" data-s-act="resume-pick">Choose PDF…</button>${r.missing ? '' : `<button class="btn small" data-path="${esc(r.path)}">Open</button>`}</div></div>
    ${r.missing ? '' : `<div class="field wide"><iframe class="pdf" style="height:520px" src="${fileUrl(r.path)}?v=${encodeURIComponent(r.modified)}"></iframe></div>`}`, { saveId: 'resume', hint: 'Uploaded to forms and attached to emails' })
  + card('CV text (cv.md)', `<div class="field wide"><textarea id="cv-text" rows="18" spellcheck="false" class="mono">${esc(S.cv)}</textarea>
      <div class="hint">The writers take facts and numbers only from here. Keep it in sync with the PDF. The old version is kept as cv.md.bak.</div></div>
      <div class="set-actions">${r.missing ? '' : '<button class="btn small" data-s-act="cv-fill">Fill from resume PDF</button>'}<button class="btn primary small" data-s-act="cv-save">Save cv.md</button></div>`);
}

function tabWriting() {
  const points = Array.isArray(get('outreach.proof_points')) ? get('outreach.proof_points') : [];
  return card('Email basics', [
    field('Sign-off', 'outreach.signoff', { type: 'multiline' }),
    field('Opening line (cold emails)', 'outreach.headline', { wide: true, hint: 'Optional. Your strongest one-line proof.' }),
    field('Rule for that line', 'outreach.headline_rule', { type: 'multiline' }),
    field('Extra rules (one per line)', 'outreach.rules', { type: 'multiline', value: (get('outreach.rules') || []).join('\n') }).replace('data-type="text"', 'data-type="lines"'),
  ].join(''), { saveId: 'writing' })
  + `<div class="card set-card" data-card="points"><h2>Proof points<span class="hint">The writer picks the best fit per company</span></h2>
    <div id="points">${points.map(pointRow).join('')}</div>
    <div class="set-actions"><button class="btn small" data-s-act="point-add">Add proof point</button><button class="btn primary small" data-s-act="points-save">Save</button></div></div>`;
}
const pointRow = (p = {}) => `<div class="point"><textarea rows="3" class="p-text" placeholder="What you did, with a real number">${esc(p.text || '')}</textarea>
  <input class="p-use" placeholder="Use for: e.g. database and storage companies" value="${esc(p.use_for || '')}"><button class="btn small" data-s-act="point-del" title="Remove">✕</button></div>`;

function flatten(obj, prefix = [], out = []) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = [...prefix, k];
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, path, out);
    else out.push([path, v]);
  }
  return out;
}

function tabAnswers() {
  const qs = S.questions = (S.questions || []).filter(Boolean);
  const saved = Object.entries(get('answers_from_app') || {});
  const cities = Object.entries(get('salary.cities') || {});
  const sections = Object.keys(S.facts || {}).filter((k) => !DEDICATED.has(k));
  const genericCard = (sec) => {
    const rows = flatten(S.facts[sec], [sec]);
    return card(human(sec), rows.map(([path, v]) => {
      const list = Array.isArray(v);
      const long = String(v ?? '').length > 70;
      const val = list ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(', ') : v ?? '';
      const tag = long ? `<textarea rows="3" data-key="${esc(path.join('.'))}" data-path='${esc(JSON.stringify(path))}' data-type="${typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'bool' : list ? 'list' : 'text'}">${esc(val)}</textarea>`
        : typeof v === 'boolean' ? `<label class="switch"><input type="checkbox" data-key="${esc(path.join('.'))}" data-path='${esc(JSON.stringify(path))}' data-type="bool" ${v ? 'checked' : ''}><span></span></label>`
          : `<input data-key="${esc(path.join('.'))}" data-path='${esc(JSON.stringify(path))}' data-type="${typeof v === 'number' ? 'number' : list ? 'list' : 'text'}" value="${esc(val)}">`;
      return `<div class="field ${long ? 'wide' : ''}"><label>${esc(path.slice(1).map(human).join(' › '))}</label>${tag}</div>`;
    }).join(''), { saveId: `sec:${sec}` });
  };
  return `<div class="card set-card" id="questions"><h2>Questions waiting<span class="hint"><span id="q-count">${qs.length}</span> open · answers are saved to the answer bank and used on the next run</span></h2>
      ${qs.length ? `<div class="set-actions top"><button class="btn primary small" data-s-act="q-save-all">Save all answers</button></div>` : ''}
      ${qs.length ? qs.slice(0, 60).map((q, i) => `<div class="qrow" data-i="${i}"><div><div>${esc(q.q)}</div><div class="hint">${esc(q.company)} · ${esc(q.role)} · ${esc(fmtDate(q.date))}</div></div>
        <input data-q="${i}" placeholder="Your answer"><button class="btn small" data-s-act="q-save" data-i="${i}">Save</button></div>`).join('') : '<div class="empty">No questions waiting.</div>'}</div>
    ${saved.length ? card('Answers you added here', saved.map(([q, a]) => `<div class="field wide"><label>${esc(q)}</label><input data-key="x" data-path='${esc(JSON.stringify(['answers_from_app', q]))}' data-type="text" value="${esc(a)}"></div>`).join(''), { saveId: 'saved' }) : ''}
    <div class="card set-card" data-card="salary"><h2>Salary by city<span class="hint">Annual gross. Ranges: upper-middle, never below floor</span></h2>
      <table class="table salary"><thead><tr><th>City</th><th>Amount</th><th>Currency</th><th>Floor</th><th></th></tr></thead><tbody id="cities">
      ${cities.map(([c, v]) => cityRow(c, v)).join('')}</tbody></table>
      <div class="fields">${field('Remote (amount)', 'salary.remote_usd.amount', { type: 'number' })}${field('Remote currency', 'salary.remote_usd.currency')}${field('Remote floor', 'salary.remote_usd.floor', { type: 'number' })}</div>
      <div class="set-actions"><button class="btn small" data-s-act="city-add">Add city</button><button class="btn primary small" data-s-act="salary-save">Save</button></div></div>
    ${sections.map(genericCard).join('')}
    ${card('Add an answer', `<div class="field wide"><label>Question (as forms ask it)</label><input id="new-q" placeholder="e.g. Are you open to on-call?"></div><div class="field wide"><label>Answer</label><input id="new-a"></div>`,
      { actions: '<button class="btn primary small" data-s-act="q-new">Add</button>' })}`;
}
const cityRow = (c = '', v = {}) => `<tr><td><input class="c-name" value="${esc(c)}"></td><td><input class="c-amount" type="number" value="${esc(v.amount ?? '')}"></td><td><input class="c-cur" value="${esc(v.currency ?? '')}" style="width:70px"></td><td><input class="c-floor" type="number" value="${esc(v.floor ?? '')}"></td><td><button class="btn small" data-s-act="city-del">✕</button></td></tr>`;

function tabRun() {
  const sc = S.schedule || {};
  return card('Auto-apply', `
    <div class="field"><label>Daily run</label><label class="switch"><input type="checkbox" data-s-toggle="pause" ${S.paused ? '' : 'checked'}><span></span></label><div class="hint">${S.paused ? 'Stopped: daily runs do nothing.' : 'Running.'}</div></div>
    <div class="field"><label>Run every day at</label><div style="display:flex;gap:6px"><input id="run-at" type="time" value="${esc(sc.time || get('schedule.run_at') || '10:00')}"><button class="btn small" data-s-act="schedule-save">${sc.installed ? 'Update' : 'Turn on'}</button>${sc.installed ? '<button class="btn small" data-s-act="schedule-off">Remove</button>' : ''}</div>
      <div class="hint">${sc.supported === false ? 'Scheduling works on macOS and Linux only.' : sc.installed ? `Scheduled at ${esc(sc.time)} (${esc(sc.label)}).` : 'Not scheduled.'} Your computer must be on (a missed day runs when it's back on).</div></div>
    ${field('Cold outreach', 'schedule.cold_outreach', { type: 'bool', hint: 'Emails companies you did not apply to.' })}
    <div class="field wide" id="run-now"><label>Run now</label><div class="hint">Checking…</div></div>`, { saveId: 'cold' })
  + card('AI models', `<div class="field wide" id="ai-status"><div class="hint">Checking Claude Code and opencode…</div></div>` + [
    field('Filling applications', 'models.apply', { type: 'select', options: CLAUDE_MODELS, value: S.models.apply }),
    field('Writing emails', 'models.outreach', { type: 'select', options: CLAUDE_MODELS, value: S.models.outreach }),
    field('Reading unclear inbox emails', 'models.inbox', { type: 'select', options: CLAUDE_MODELS, value: S.models.inbox }),
    field('Turning your resume PDF into cv.md', 'models.cv', { type: 'select', options: CLAUDE_MODELS, value: S.models.cv }),
    field('Job fit check before applying', 'models.prescore', { type: 'select', options: PRESCORE_MODELS, value: S.models.prescore }),
  ].join(''), { saveId: 'models', hint: 'Bigger models write better but use more of your Claude plan' })
  + card('Limits', [
    field('Applications per day', 'limits.max_applications_per_day', { type: 'number' }),
    field('Per company in 30 days', 'limits.max_per_company_per_30_days', { type: 'number' }),
    field('Min score to apply (1-5)', 'limits.min_score', { type: 'number' }),
    field('Emails per day', 'outreach.max_emails_per_day', { type: 'number' }),
    field('Seconds between emails', 'outreach.seconds_between_emails', { type: 'number' }),
    field('Follow up after (days)', 'outreach.follow_up_after_days', { type: 'number' }),
  ].join(''), { saveId: 'limits' })
  + card('Permissions', [
    field('Submit applications for me', 'consent.auto_submit_since', { type: 'consent' }),
    field('Email people about my applications', 'consent.outreach_email_since', { type: 'consent' }),
    field('Cold-email companies', 'consent.cold_email_since', { type: 'consent' }), field('Make job-site accounts for me', 'consent.create_accounts_since', { type: 'consent' }),
  ].join('') + '<div class="field wide"><div class="hint">Without these, live runs only prepare drafts and fill forms in dry-run. Nothing is sent or submitted.</div></div>', { saveId: 'consent', hint: 'What the system may do alone' });
}

function tabFolder() {
  return card('career-ops folder', `<div class="field wide"><label>Current folder</label><div class="mono">${esc(S.root)}</div>
    <div class="hint">All your data lives here: config/, cv.md, data/, autoapply/. The app reloads after you change it.</div></div>
    <div class="set-actions"><button class="btn small" data-reveal="config/apply-facts.yml">Show settings file</button><button class="btn small" data-s-act="root">Change folder…</button></div>`);
}

function renderSettingsInto() {
  const el = $('#settings-body');
  if (!el || !S) return;
  const t = ui.setTab || 'profile';
  el.innerHTML = ({ profile: tabProfile, email: tabEmail, resume: tabResume, writing: tabWriting, answers: tabAnswers, run: tabRun, folder: tabFolder }[t] || tabProfile)();
  showAi();
  showRun();
}

// ---------- answers ----------
// Saves the typed answers without redrawing the page, so answers still being typed are kept.
async function saveAnswers(rows) {
  const filled = rows.map((row) => ({ row, q: S.questions[Number(row.dataset.i)], a: row.querySelector('input').value.trim() })).filter((x) => x.q && x.a);
  if (!filled.length) return toast('Type an answer first.');
  const r = await window.co.saveSettings(filled.map(({ q, a }) => [['answers_from_app', q.q], a]));
  if (!r.ok) return toast(`Could not save: ${r.error}`, 0);
  S = { ...S, ...r.value };
  // The same question can wait at several companies: one answer clears them all.
  const done = new Set(filled.map(({ q }) => q.q));
  for (const row of document.querySelectorAll('#questions .qrow')) {
    if (done.has(S.questions[Number(row.dataset.i)]?.q)) { S.questions[Number(row.dataset.i)] = null; row.remove(); }
  }
  $('#q-count').textContent = S.questions.filter(Boolean).length;
  toast(`${filled.length === 1 ? 'Answer' : `${filled.length} answers`} saved. The next run can use ${filled.length === 1 ? 'it' : 'them'}.`, 3000);
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.matches('#questions .qrow input')) saveAnswers([ev.target.closest('.qrow')]);
});

// ---------- manual run ----------
let runTimer = null;
async function showRun(state) {
  const el = $('#run-now');
  clearTimeout(runTimer);
  if (!el) return;
  if (!state) { const r = await window.co.runState(); if (!r.ok) return; state = r.value; }
  if (!$('#run-now')) return;
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#run-now').innerHTML = state.running
    ? `<label>Run now</label><div style="display:flex;gap:8px"><button class="btn small" data-path="${esc(state.log)}">Open log</button><button class="btn small" data-s-act="run-stop">Stop</button></div>
      <div class="hint">Running since ${esc(time(state.since))}. Statuses update here as it goes.</div>`
    : `<label>Run now</label><div style="display:flex;gap:8px"><button class="btn primary small" data-s-act="run-start">Run now</button><button class="btn small" data-s-act="run-start" data-dry="1">Practice run</button></div>
      <div class="hint">Run now does what the daily run does. Practice run goes through the jobs without submitting or sending anything.</div>`;
  if (state.running) runTimer = setTimeout(() => showRun(), 10_000);
}

// ---------- AI tools check ----------
const CLAUDE_MODELS = [['claude-haiku-5-5', 'Claude Haiku 5.5 (fast, uses the least)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (better writing)'], ['claude-opus-5-5', 'Claude Opus 5.5 (best, uses the most)']];
const PRESCORE_MODELS = [['auto', 'Auto (free with opencode, else Haiku)'], ['opencode/deepseek-v4.1-flash-free', 'Free DeepSeek (needs opencode)'], ...CLAUDE_MODELS.slice(0, 2)];
let AI = null;

const aiRow = (ok, title, text) => `<div class="ai-row"><span class="ai-dot ${ok ? 'ok' : 'bad'}"></span><div><b>${title}</b><div class="hint">${text}</div></div></div>`;
function aiHtml(a) {
  const c = a.claude, o = a.opencode;
  return aiRow(c.installed && c.loggedIn, 'Claude Code', !c.installed
      ? 'Not installed. Everything uses it: get it at <a data-url="https://claude.com/claude-code">claude.com/claude-code</a>, then run <code>claude</code> in Terminal once to log in.'
      : c.loggedIn ? `Ready (${esc(c.version)}, logged in${c.method ? ` with ${esc(c.method)}` : ''}).` : 'Installed but not logged in. Open Terminal, run <code>claude</code>, and log in.')
    + aiRow(o.installed, 'opencode (optional)', o.installed
      ? `Ready (${esc(o.version)}). The job fit check uses free DeepSeek.`
      : 'Not installed. The job fit check uses Claude Haiku instead. To use free DeepSeek, get it at <a data-url="https://opencode.ai">opencode.ai</a>.')
    + `<div><button class="btn small" data-s-act="ai-check">Check again</button></div>`;
}
async function showAi(fresh = false) {
  const el = $('#ai-status');
  if (!el) return;
  if (fresh || !AI) { el.innerHTML = '<div class="hint">Checking Claude Code and opencode…</div>'; AI = await window.co.aiCheck(); }
  if ($('#ai-status')) $('#ai-status').innerHTML = aiHtml(AI);
}

function renderSettingsView() {
  const t = ui.setTab || 'profile';
  queueMicrotask(async () => { if (!S) await loadSettings(); renderSettingsInto(); });
  return `<div class="settings"><div class="set-nav">${SET_TABS.map(([k, l]) => `<button class="${t === k ? 'on' : ''}" data-s-tab="${k}">${l}</button>`).join('')}</div>
    <div class="set-body pad" id="settings-body"><div class="empty">Loading…</div></div></div>`;
}

// ---------- actions ----------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-s-tab],[data-s-save],[data-s-act]');
  if (!t) return;
  const d = t.dataset;
  if (d.sTab) { ui.setTab = d.sTab; await loadSettings(); return render(); }
  if (d.sSave) {
    return save(collect(t.closest('.card')));
  }
  const card_ = t.closest('.card');
  switch (d.sAct) {
    case 'email-save': {
      const r = await window.co.saveEnv({ user: $('#env-user').value, password: $('#env-pass').value, hunter: $('#env-hunter').value });
      if (!r.ok) return toast(r.error, 0);
      S = { ...S, ...r.value }; toast('Email account saved.', 2500); return renderSettingsInto();
    }
    case 'email-test': { t.disabled = true; t.textContent = 'Testing…'; const r = await window.co.testEmail(); t.disabled = false; t.textContent = 'Test login'; return toast(r.out.trim().split('\n').slice(-2).join('\n') || (r.ok ? 'ok' : 'failed'), r.ok ? 5000 : 0); }
    case 'resume-pick': { const r = await window.co.pickResume(); if (!r?.ok) { if (r?.error) toast(r.error, 0); return; } if (r.value) { S = { ...S, ...r.value }; toast('Resume updated.'); if ($('.wizard')) { showWizard(); if (!S.cv.trim()) fillCv(); } else renderSettingsInto(); } return; }
    case 'cv-fill': return fillCv();
    case 'ai-check': return showAi(true);
    case 'cv-save': { const r = await window.co.saveCv($('#cv-text').value); return r.ok ? (S = { ...S, ...r.value }, toast('cv.md saved.', 2500)) : toast(r.error, 0); }
    case 'point-add': return $('#points').insertAdjacentHTML('beforeend', pointRow());
    case 'point-del': return t.closest('.point').remove();
    case 'points-save': return save([[['outreach', 'proof_points'], [...card_.querySelectorAll('.point')].map((p) => ({ text: p.querySelector('.p-text').value.trim(), use_for: p.querySelector('.p-use').value.trim() })).filter((p) => p.text)]]);
    case 'city-add': return $('#cities').insertAdjacentHTML('beforeend', cityRow());
    case 'city-del': return t.closest('tr').remove();
    case 'salary-save': {
      const cities = {};
      for (const tr of card_.querySelectorAll('#cities tr')) {
        const name = tr.querySelector('.c-name').value.trim();
        if (name) cities[name] = { amount: Number(tr.querySelector('.c-amount').value) || 0, currency: tr.querySelector('.c-cur').value.trim(), floor: Number(tr.querySelector('.c-floor').value) || 0 };
      }
      return save([[['salary', 'cities'], cities], ...collect(card_.querySelector('.fields'))]);
    }
    case 'q-save': return saveAnswers([t.closest('.qrow')]);
    case 'q-save-all': return saveAnswers([...document.querySelectorAll('#questions .qrow')]);
    case 'run-start': {
      const dry = d.dry === '1';
      if (!dry && !confirm('Run now for real? It does everything the daily run does: applies to jobs, sends emails and checks your inbox.')) return;
      t.disabled = true;
      const r = await window.co.runStart(dry);
      if (!r.ok) { t.disabled = false; return toast(r.error, 0); }
      toast(dry ? 'Practice run started.' : 'Run started.', 3000);
      return showRun(r.value);
    }
    case 'run-stop': {
      if (!confirm('Stop the run? Jobs being filled right now are stopped too.')) return;
      t.disabled = true; t.textContent = 'Stopping…';
      const r = await window.co.runStop();
      return r.ok ? showRun(r.value) : toast(r.error, 0);
    }
    case 'q-new': { const q = $('#new-q').value.trim(), a = $('#new-a').value.trim(); if (!q || !a) return toast('Fill in both.'); return save([[['answers_from_app', q], a]], 'Answer added.'); }
    case 'schedule-save': { const r = await window.co.setSchedule($('#run-at').value); if (!r.ok) return toast(r.error, 0); S = { ...S, ...r.value }; toast(`Daily run set for ${$('#run-at')?.value || ''}.`); return renderSettingsInto(); }
    case 'schedule-off': { const r = await window.co.setSchedule(null); if (!r.ok) return toast(r.error, 0); S = { ...S, ...r.value }; toast('Daily run removed.'); return renderSettingsInto(); }
    case 'root': { const r = await window.co.chooseRoot(); if (r?.error) toast(r.error, 0); return; }
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.matches('[data-s-toggle="pause"]')) {
    const r = await window.co.setPaused(!t.checked);
    if (!r.ok) return toast(r.error, 0);
    S = { ...S, ...r.value }; toast(t.checked ? 'Auto-apply is running.' : 'Auto-apply stopped.', 2500); renderSettingsInto(); reload();
  }
  if (t.matches('[data-type="consent"]')) t.nextElementSibling.textContent = t.checked ? `Allowed since ${t.dataset.was || today()}` : 'Not allowed';
});

// ---------- first-run setup ----------
const STEPS = ['About you', 'Email', 'AI', 'Resume', 'Permissions'];
let step = 0;

function wizardStep() {
  if (step === 0) return `<h2>Welcome to Career Ops</h2><p class="lead">A few details so the system can fill forms and write emails as you. You can change all of it later in Settings.</p>
    <div class="fields">${[field('Full name', 'contact.full_name'), field('Email on applications', 'contact.email'), field('Phone', 'contact.phone', { placeholder: '+44 ...' }),
      field('Location', 'contact.location', { placeholder: 'City, Country' }), field('LinkedIn', 'contact.linkedin'), field('GitHub', 'contact.github'),
      field('Your title', 'profile.title', { placeholder: 'backend engineer' }), field('Can work in (no visa)', 'work_authorization.authorized_in', { type: 'list', placeholder: 'Country, ...' }),
      field('Need visa sponsorship elsewhere', 'work_authorization.needs_sponsorship', { type: 'bool' })].join('')}</div>`;
  if (step === 1) return `<h2>Email account</h2><p class="lead">A Gmail account sends outreach and reads replies, rejections and verification codes. You can skip this and add it later.</p>
    <div class="fields"><div class="field"><label>Gmail address</label><input id="env-user" value="${esc(S.email.user)}"></div><div class="field"><label>App password</label><input id="env-pass" type="password" placeholder="${S.email.hasPassword ? '•••• saved' : '16 letters'}"></div>
    <div class="field wide"><div class="hint">Make one at <a data-url="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</a>.</div></div></div>`;
  if (step === 2) return `<h2>AI tools</h2><p class="lead">Claude Code does the work: it fills forms, writes emails and reads your resume. It runs on your own Claude account.</p>
    <div class="fields"><div class="field wide" id="ai-status"><div class="hint">Checking…</div></div>
    <div class="field wide"><div class="hint">You can pick which model does each job later in Settings → Run controls.</div></div></div>`;
  if (step === 3) return `<h2>Your resume</h2><p class="lead">This PDF is uploaded to forms and attached to emails. The writers take facts and numbers only from the CV text below, so check it matches your resume.</p>
    <div class="fields">${S.resume.missing ? '<div class="field wide"><div class="note">No resume yet.</div></div>' : `<div class="field wide"><div class="hint">Current: ${esc(S.resume.path)}</div></div>`}
    <div class="field wide"><div style="display:flex;gap:8px"><button class="btn" data-s-act="resume-pick">Choose PDF…</button>${S.resume.missing ? '' : '<button class="btn" data-s-act="cv-fill">Fill from resume PDF</button>'}</div></div>
    <div class="field wide"><label>CV text (cv.md)</label><textarea id="cv-text" rows="14" spellcheck="false" class="mono" placeholder="Choose your PDF and the text is read from it. You can also paste it here.">${esc(S.cv)}</textarea></div></div>`;
  return `<h2>What may it do alone?</h2><p class="lead">Nothing is submitted or sent until you allow it. You can change these any time.</p>
    <div class="fields">${[field('Submit applications for me', 'consent.auto_submit_since', { type: 'consent' }), field('Email people about my applications', 'consent.outreach_email_since', { type: 'consent' }),
      field('Cold-email companies', 'consent.cold_email_since', { type: 'consent' }), field('Make job-site accounts for me', 'consent.create_accounts_since', { type: 'consent' }), field('Applications per day', 'limits.max_applications_per_day', { type: 'number' }),
      field('Min score to apply (1-5)', 'limits.min_score', { type: 'number' })].join('')}
      <div class="field"><label>Run every day at</label><input id="run-at" type="time" value="${esc(get('schedule.run_at') || '10:00')}"></div></div>`;
}

function showWizard() {
  let el = $('.wizard');
  if (!el) { el = document.createElement('div'); el.className = 'wizard'; document.body.appendChild(el); }
  el.innerHTML = `<div class="wizard-card"><div class="steps">${STEPS.map((s, i) => `<span class="${i === step ? 'on' : i < step ? 'done' : ''}">${i + 1}. ${s}</span>`).join('')}</div>
    <div class="wizard-body">${wizardStep()}</div>
    <div class="set-actions">${step ? '<button class="btn" data-w="back">Back</button>' : ''}<button class="btn primary" data-w="next">${step === STEPS.length - 1 ? 'Finish' : 'Next'}</button></div></div>`;
  showAi();
}

document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-w]');
  if (!b) return;
  const body = $('.wizard-body');
  if (b.dataset.w === 'back') { step--; return showWizard(); }
  b.disabled = true;
  if (step === 0) {
    const patch = collect(body);
    const full = (patch.find(([k]) => k.join('.') === 'contact.full_name') || [])[1] || '';
    if (!full.trim()) { b.disabled = false; return toast('Your name is needed.'); }
    const [first, ...rest] = full.trim().split(/\s+/);
    const loc = (patch.find(([k]) => k.join('.') === 'contact.location') || [])[1] || '';
    patch.push([['contact', 'first_name'], first], [['contact', 'last_name'], rest.join(' ')], [['profile', 'home_city'], loc.split(',')[0].trim()], [['profile', 'home_country'], loc.split(',').at(-1).trim()],
      [['outreach', 'signoff'], `Thanks,\n${full.trim()}`], [['resume', 'send_as'], `${full.trim().replace(/\s+/g, '_')}_Resume.pdf`]);
    const r = await window.co.saveSettings(patch); if (!r.ok) { b.disabled = false; return toast(r.error, 0); }
    S = { ...S, ...r.value };
  } else if (step === 1) {
    if ($('#env-user').value.trim() || $('#env-pass').value.trim()) {
      const r = await window.co.saveEnv({ user: $('#env-user').value, password: $('#env-pass').value }); if (!r.ok) { b.disabled = false; return toast(r.error, 0); }
      S = { ...S, ...r.value };
      const t = await window.co.testEmail(); toast(t.out.trim().split('\n').pop(), t.ok ? 4000 : 0);
    }
  } else if (step === 2) {
    if (!AI?.claude.installed || !AI?.claude.loggedIn) toast('Claude Code is not ready yet, so nothing can run. You can fix it later: Settings → Run controls.', 6000);
  } else if (step === 3) {
    const text = $('#cv-text').value;
    if (!text.trim()) toast('No CV text yet. Live runs stay off until you add it (Settings → Resume & CV).', 6000);
    else if (text !== S.cv) {
      const r = await window.co.saveCv(text); if (!r.ok) { b.disabled = false; return toast(r.error, 0); }
      S = { ...S, ...r.value };
    }
  } else if (step === 4) {
    const r = await window.co.saveSettings(collect(body)); if (!r.ok) { b.disabled = false; return toast(r.error, 0); }
    S = { ...S, ...r.value };
    const time = $('#run-at').value;
    if (time && S.schedule?.supported) { const s = await window.co.setSchedule(time); if (!s.ok) toast(s.error, 0); }
    $('.wizard').remove();
    toast('All set. Settings has more options (answer bank, outreach writing, salary).', 6000);
    return reload();
  }
  step++; showWizard();
});

// Reads the resume PDF with Claude into the CV box; the owner checks it, then saves.
async function fillCv() {
  const box = $('#cv-text'), b = $('[data-s-act="cv-fill"]');
  if (!box || (box.value.trim() && !confirm('Replace the CV text with the text from your resume PDF?'))) return;
  if (b) { b.disabled = true; b.textContent = 'Reading your PDF…'; }
  const r = await window.co.cvFromPdf();
  if (b) { b.disabled = false; b.textContent = 'Fill from resume PDF'; }
  if (!r.ok) return toast(r.error, 0);
  box.value = r.value.cv;
  toast(`Done. Check it against your PDF, then ${$('.wizard') ? 'click Next' : 'save'}.`, 6000);
}

async function maybeSetup() {
  if (!(await loadSettings())) return;
  if (S.firstRun) { step = 0; showWizard(); }
}
