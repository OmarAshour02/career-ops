// Career Ops window: overview, applications, needs-you, outreach, cold outreach, inbox.
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileUrl = (rel) => `co://local/${String(rel).split('/').map(encodeURIComponent).join('/')}`;

const ui = { view: 'overview', search: '', filter: {}, sel: {}, tab: 'timeline', sort: 'recent' };
let D = null;

// ---------- helpers ----------
const STATUS = {
  applied: { label: 'Applied', cls: 's-applied' },
  responded: { label: 'In process', cls: 's-responded' },
  interview: { label: 'Interview', cls: 's-interview' },
  offer: { label: 'Offer ★', cls: 's-offer' },
  rejected: { label: 'Rejected', cls: 's-rejected' },
  closed: { label: 'Closed', cls: 's-closed' },
  needs_answer: { label: 'Needs answer', cls: 's-needs' },
  captcha: { label: 'CAPTCHA', cls: 's-needs' },
  failed: { label: 'Failed', cls: 's-needs' },
  skipped: { label: 'Skipped', cls: 's-skip' },
};
const KIND = {
  received: { label: 'Received', cls: 's-applied' }, in_process: { label: 'In process', cls: 's-responded' },
  assessment: { label: 'Assessment', cls: 's-responded' }, interview: { label: 'Interview', cls: 's-interview' },
  offer: { label: 'Offer', cls: 's-offer' }, rejected: { label: 'Rejected', cls: 's-rejected' },
  closed: { label: 'Closed', cls: 's-closed' }, other: { label: 'Email', cls: 's-skip' },
};
const OUT_STATE = {
  replied: { label: 'Replied', cls: 's-interview' }, followed_up: { label: 'Followed up', cls: 's-responded' },
  sent: { label: 'Sent', cls: 's-applied' }, draft: { label: 'Draft', cls: 's-needs' },
  bounced: { label: 'Bounced', cls: 's-rejected' }, no_contact: { label: 'No contact', cls: 's-skip' },
};
const statusKey = (a) => {
  if (a.stage !== 'sent') return a.stage;
  const s = String(a.status).toLowerCase();
  return s === 'responded' ? 'responded' : s === 'interview' ? 'interview' : s === 'offer' ? 'offer' : s === 'rejected' ? 'rejected' : s === 'discarded' ? 'closed' : 'applied';
};
const pill = (map, key) => { const m = map[key] || { label: key, cls: 's-skip' }; return `<span class="pill ${m.cls}">${esc(m.label)}</span>`; };
const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const fmtDateTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
const ago = (iso) => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!iso || isNaN(ms)) return '';
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) { const h = Math.floor(ms / 3_600_000); return h <= 0 ? 'just now' : `${h}h ago`; }
  return d === 1 ? 'yesterday' : d < 30 ? `${d}d ago` : fmtDate(iso);
};
const matches = (q, ...fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));
const icon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  overview: icon('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  apps: icon('<rect x="2.5" y="4" width="11" height="9" rx="1.5"/><path d="M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/>'),
  needs: icon('<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5M8 11h.01"/>'),
  outreach: icon('<path d="M2 4h12v8H2z"/><path d="m2 4 6 5 6-5"/>'),
  cold: icon('<path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z"/>'),
  inbox: icon('<path d="M2 9h3l1 2h4l1-2h3"/><path d="M3.5 3h9L14 9v4H2V9z"/>'),
  skipped: icon('<path d="M3 3l10 10M13 3 3 13"/>'),
  settings: icon('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>'),
};

function toast(text, ms = 6000) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="x">✕</span>${esc(text)}`;
  t.querySelector('.x').onclick = () => t.remove();
  document.body.appendChild(t);
  if (ms) setTimeout(() => t.remove(), ms);
}

// Tiny safe markdown: escape first, then headings, bold, code, lists, rules, links.
function md(src) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a data-url="$2">$1</a>');
  const out = []; let list = false;
  for (const line of String(src).split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/);
    if (!li && list) { out.push('</ul>'); list = false; }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (/^-{3,}\s*$/.test(line)) out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}

// ---------- data ----------
const sent = () => D.apps.filter((a) => a.stage === 'sent');
const needs = () => D.apps.filter((a) => ['needs_answer', 'captcha', 'failed'].includes(a.stage));
const byId = (id) => D.apps.find((a) => a.id === id);

async function reload() {
  try { D = await window.co.load(); } catch (e) { toast(`Could not read career-ops files: ${e.message}`, 0); return; }
  render();
}

// ---------- sidebar ----------
function renderNav() {
  const roleOut = D.outreach.filter((o) => o.kind === 'role'), cold = D.outreach.filter((o) => o.kind === 'cold');
  const replies = D.outreach.filter((o) => o.state === 'replied').length;
  const items = [
    ['overview', 'Overview', ''],
    ['apps', 'Applications', sent().length],
    ['needs', 'Needs you', needs().filter((a) => Date.now() - new Date(a.date) < 7 * 86_400_000).length || needs().length, needs().some((a) => Date.now() - new Date(a.date) < 7 * 86_400_000)],
    ['inbox', 'Inbox', D.unmatched.length],
    null,
    ['outreach', 'Outreach', roleOut.filter((o) => o.sentAt).length, false],
    ['cold', 'Cold outreach', cold.filter((o) => o.sentAt).length],
    null,
    ['skipped', 'Skipped', D.apps.filter((a) => a.stage === 'skipped').length],
    null,
    ['settings', 'Settings', ''],
  ];
  $('#nav').innerHTML = items.map((it) => (it ? `<button data-nav="${it[0]}" class="${ui.view === it[0] ? 'on' : ''}">${ICONS[it[0]]}${it[1]}<span class="count ${it[3] ? 'hot' : ''}">${it[2]}</span></button>` : '<div class="nav-sep"></div>')).join('');
  const last = D.inbox?.synced_at;
  $('#foot').innerHTML = `Inbox checked ${last ? esc(ago(last)) : 'never'}${D.inbox?.last_ai_error ? '<br><span class="missing">Haiku step failed last time</span>' : ''}<br>${replies} outreach ${replies === 1 ? 'reply' : 'replies'}${D.paused ? '<br><span class="missing">Auto-apply is stopped</span>' : ''}`;
}

// ---------- overview ----------
function renderOverview() {
  const s = sent();
  const count = (k) => s.filter((a) => statusKey(a) === k).length;
  const heard = s.filter((a) => a.events.some((e) => !['received', 'other'].includes(e.kind))).length;
  const inProc = count('responded') + count('interview') + count('offer');
  const days = 21, today = new Date(); today.setHours(0, 0, 0, 0);
  const perDay = Array.from({ length: days }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - (days - 1 - i));
    const key = d.toLocaleDateString('en-CA');
    return { d, n: s.filter((a) => a.date && new Date(a.date).toLocaleDateString('en-CA') === key).length };
  });
  const max = Math.max(1, ...perDay.map((x) => x.n));
  const W = 600, H = 150, bw = W / days;
  const bars = perDay.map((x, i) => {
    const h = Math.round((x.n / max) * (H - 34));
    return `<rect x="${i * bw + 3}" y="${H - 18 - h}" width="${bw - 6}" height="${Math.max(h, x.n ? 2 : 0)}" rx="3" fill="var(--accent)"><title>${fmtDate(x.d)}: ${x.n} sent</title></rect>`
      + (x.n ? `<text x="${i * bw + bw / 2}" y="${H - 22 - h}" text-anchor="middle" class="axis">${x.n}</text>` : '')
      + (i % 3 === 0 || i === days - 1 ? `<text x="${i * bw + bw / 2}" y="${H - 4}" text-anchor="middle" class="axis">${fmtDate(x.d)}</text>` : '');
  }).join('');
  const funnel = [['applied', 'Waiting', 'var(--silver)'], ['responded', 'In process', 'var(--almond)'], ['interview', 'Interview', 'var(--salmon)'], ['offer', 'Offer', 'var(--almond)'], ['rejected', 'Rejected', '#8E83A0'], ['closed', 'Closed', 'var(--grape)']]
    .map(([k, label, color]) => { const n = count(k); return `<div class="funnel-row"><span>${label}</span><div class="bar"><i style="width:${s.length ? (n / s.length) * 100 : 0}%;background:${color}"></i></div><span class="num" style="text-align:right">${n}</span></div>`; }).join('');
  const feed = D.events.filter((e) => !['received', 'other'].includes(e.kind)).slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 9);
  const roleOut = D.outreach.filter((o) => o.kind === 'role'), cold = D.outreach.filter((o) => o.kind === 'cold');
  const outLine = (list) => { const sentN = list.filter((o) => o.sentAt).length; return `${sentN} sent · ${list.filter((o) => o.state === 'replied').length} replied · ${list.filter((o) => o.bounced).length} bounced · ${list.filter((o) => o.state === 'draft').length} drafts`; };
  const nq = needs();
  return `<div class="pad">
    <div class="kpis">
      <div class="kpi"><div class="label">Applications sent</div><div class="value">${s.length}</div><div class="sub">${s.filter((a) => Date.now() - new Date(a.date) < 7 * 86_400_000).length} in the last 7 days</div></div>
      <div class="kpi"><div class="label">Waiting for answer</div><div class="value">${count('applied')}</div><div class="sub">no reply yet</div></div>
      <div class="kpi accent"><div class="label">In process</div><div class="value">${inProc}</div><div class="sub">${count('interview')} interview${count('interview') === 1 ? '' : 's'}</div></div>
      <div class="kpi"><div class="label">Rejected / closed</div><div class="value">${count('rejected') + count('closed')}</div><div class="sub">${count('closed')} closed by company</div></div>
      <div class="kpi"><div class="label">Heard back</div><div class="value">${s.length ? Math.round((heard / s.length) * 100) : 0}%</div><div class="sub">${heard} of ${s.length} replied</div></div>
    </div>
    <div class="grid-2">
      <div class="card chart"><h2>Applications per day<span class="hint">last ${days} days</span></h2><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg></div>
      <div class="card"><h2>Where they are</h2><div class="funnel">${funnel}</div></div>
    </div>
    <div class="grid-2">
      <div class="card"><h2>Latest from your inbox<span class="hint"><a data-nav="inbox">See all</a></span></h2>
        <div class="feed">${feed.length ? feed.map((e) => `<div class="feed-item" ${e.num ? `data-open-app="${e.num}"` : 'data-nav="inbox"'}>
          <div>${pill(KIND, e.kind)}</div>
          <div><div class="feed-title">${esc(e.company ? byId(e.num)?.company || e.company : senderName(e.from))}${e.role ? ` <span style="color:var(--muted);font-weight:400">· ${esc(e.role)}</span>` : ''}</div><div class="feed-reason">${esc(e.reason)}</div></div>
          <div class="feed-date">${esc(ago(e.date))}</div></div>`).join('') : '<div class="empty">No status emails yet.</div>'}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card"><h2>Needs you<span class="hint"><a data-nav="needs">Open</a></span></h2>
          <div>${nq.filter((a) => a.stage === 'needs_answer').length} applications wait for an answer · ${nq.filter((a) => a.stage === 'captcha').length} need a CAPTCHA by hand · ${nq.filter((a) => a.stage === 'failed').length} failed</div></div>
        <div class="card"><h2>Outreach<span class="hint"><a data-nav="outreach">Open</a></span></h2><div>${outLine(roleOut)}</div></div>
        <div class="card"><h2>Cold outreach<span class="hint"><a data-nav="cold">Open</a></span></h2><div>${outLine(cold)}</div></div>
        ${D.lastSummary ? `<div class="card"><h2>Last daily run<span class="hint">${esc(D.lastSummary.day)}</span></h2><div style="color:var(--muted)">${esc(D.lastSummary.text.split('\n').find((l) => l.startsWith('**Applied')) || '').replace(/\*\*/g, '')}</div></div>` : ''}
      </div>
    </div>
  </div>`;
}
const senderName = (from) => String(from || '').replace(/<.*>/, '').replace(/"/g, '').trim() || from;

// ---------- applications ----------
const APP_FILTERS = [['all', 'All'], ['applied', 'Waiting'], ['responded', 'In process'], ['interview', 'Interview'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['closed', 'Closed']];

function appList(list, filters, filterKey) {
  const q = ui.search.toLowerCase();
  const f = ui.filter[filterKey] || 'all';
  const counts = Object.fromEntries(filters.map(([k]) => [k, k === 'all' ? list.length : list.filter((a) => statusKey(a) === k).length]));
  let rows = list.filter((a) => (f === 'all' || statusKey(a) === f) && matches(q, a.company, a.role, a.rawCompany));
  const sorters = { recent: (a, b) => String(b.date).localeCompare(String(a.date)), update: (a, b) => String(b.lastUpdate).localeCompare(String(a.lastUpdate)), score: (a, b) => (b.score ?? 0) - (a.score ?? 0), company: (a, b) => a.company.localeCompare(b.company) };
  rows = rows.sort(sorters[ui.sort] || sorters.recent);
  return { rows, html: `<div class="filters">${filters.map(([k, label]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter="${filterKey}:${k}">${label}<b>${counts[k] ?? 0}</b></button>`).join('')}
    <select data-sort><option value="recent">Newest</option><option value="update">Last update</option><option value="score">Score</option><option value="company">Company</option></select></div>` };
}

function appRow(a) {
  const last = a.events.filter((e) => e.kind !== 'other').at(-1);
  return `<div class="row ${ui.sel.app === a.id ? 'on' : ''}" data-app="${a.id}">
    <div class="row-title">${esc(a.company)}</div><div>${pill(STATUS, statusKey(a))}</div>
    <div class="row-sub">${esc(a.role)}</div>
    <div class="row-meta">${fmtDate(a.date)}${a.score != null ? ` · ${esc(a.score)}` : ''}</div>
    ${last && last.kind !== 'received' ? `<div class="row-sub" style="grid-column:1/-1;color:var(--faint)">${esc(KIND[last.kind]?.label || last.kind)} ${esc(ago(last.date))}: ${esc(last.reason)}</div>` : ''}
  </div>`;
}

function renderApps(list, filters, filterKey) {
  const { rows, html } = appList(list, filters, filterKey);
  if (!rows.find((a) => a.id === ui.sel.app)) ui.sel.app = rows[0]?.id;
  const a = byId(ui.sel.app);
  return `<div class="split"><div class="list-pane">${html}<div class="rows">${rows.map(appRow).join('') || '<div class="empty">Nothing here.</div>'}</div></div>
    <div class="detail" id="detail">${a ? appDetail(a) : '<div class="empty">Pick an application.</div>'}</div></div>`;
}

function timeline(a) {
  const items = [{ date: a.date, html: `<div class="tl-item k-applied"><div class="tl-head">${pill(STATUS, a.stage === 'sent' ? 'applied' : a.stage)}<span class="tl-date">${fmtDateTime(a.date)}</span></div>
    <div class="tl-reason">${a.stage === 'sent' ? 'Auto-applied' : esc(a.reason || a.stage)}${a.score != null ? ` · score ${esc(a.score)}` : ''}${a.confirmation ? ` · <a data-shot="${esc(a.confirmation)}">confirmation screenshot</a>` : ''}</div>
    ${a.detail ? `<div class="tl-mail">${esc(a.detail)}</div>` : ''}</div>` }];
  for (const e of a.events) {
    items.push({ date: e.date, html: `<div class="tl-item k-${esc(e.kind)}"><div class="tl-head">${pill(KIND, e.kind)}<span class="tl-date">${fmtDateTime(e.date)}</span>
      ${e.status_to ? `<span class="tag">status ${esc(e.status_from)} → ${esc(e.status_to)}</span>` : ''}${e.match === 'guess' ? '<span class="tag" title="The email did not name the role; picked the closest application at this company">guessed match</span>' : ''}${e.by === 'ai' ? '<span class="tag">read by Haiku</span>' : ''}</div>
      <div class="tl-reason">${esc(e.reason)}</div>
      ${e.quote ? `<div class="tl-quote">${esc(e.quote)}</div>` : ''}
      <div class="tl-mail">${esc(senderName(e.from))} — “${esc(e.subject)}”</div>
      ${e.snippet ? `<details class="mail-body"><summary>Show email</summary><div>${esc(e.snippet)}</div></details>` : ''}</div>` });
  }
  const o = a.outreach;
  if (o?.sentAt) items.push({ date: o.sentAt, html: `<div class="tl-item"><div class="tl-head">${pill(OUT_STATE, 'sent')}<span class="tl-date">${fmtDateTime(o.sentAt)}</span></div><div class="tl-reason">Outreach email to ${esc(o.toName)} (${esc(o.toTitle)})</div></div>` });
  if (o?.followupAt) items.push({ date: o.followupAt, html: `<div class="tl-item"><div class="tl-head">${pill(OUT_STATE, 'followed_up')}<span class="tl-date">${fmtDateTime(o.followupAt)}</span></div><div class="tl-reason">Follow-up sent to ${esc(o.toName)}</div></div>` });
  if (o?.repliedAt) items.push({ date: o.repliedAt, html: `<div class="tl-item k-interview"><div class="tl-head">${pill(OUT_STATE, 'replied')}<span class="tl-date">${fmtDateTime(o.repliedAt)}</span></div><div class="tl-reason">${esc(o.toName)} replied to your outreach</div></div>` });
  const [first, ...rest] = items; // "Applied" always opens the story; mails can land seconds before the worker finishes
  rest.sort((x, y) => new Date(x.date) - new Date(y.date));
  return `<div class="timeline">${[first, ...rest].map((i) => i.html).join('')}</div>`;
}

function appDetail(a) {
  const tabs = [['timeline', 'Timeline'], ['answers', `Answers ${a.answers.length + a.questions.length}`], ['resume', 'Resume'], ['shots', `Screenshots ${a.screenshots.length}`], ['report', 'Report'], ['outreach', 'Outreach']]
    .filter(([k]) => (k === 'report' ? a.report : k === 'outreach' ? a.outreach : k === 'resume' ? a.resume : true));
  if (!tabs.find(([k]) => k === ui.tab)) ui.tab = 'timeline';
  const states = ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded'];
  const cur = String(a.status);
  return `<div class="detail-head">
      <h2>${esc(a.company)}</h2><div class="role">${esc(a.role)}</div>
      <div class="actions">${pill(STATUS, statusKey(a))}
        ${a.stage === 'sent' ? `<select class="status-select" data-set-status="${a.id}" title="Change status by hand">${states.map((s) => `<option ${s.toLowerCase() === cur.toLowerCase() ? 'selected' : ''} value="${s}">${s === 'Responded' ? 'In process' : s === 'Discarded' ? 'Closed' : s}</option>`).join('')}</select>` : ''}
        ${a.url ? `<button class="btn small" data-url="${esc(a.url)}">Open job post ↗</button>` : ''}
        ${a.resume ? `<button class="btn small" data-path="${esc(a.resume.path)}">Resume PDF</button>` : ''}
      </div>
      <div class="facts"><span><b>Applied</b> ${fmtDate(a.date)}</span><span><b>Report</b> #${esc(a.id)}</span>${a.row ? `<span><b>Tracker row</b> ${esc(a.row)}</span>` : ''}<span><b>Last update</b> ${esc(ago(a.lastUpdate))}</span></div>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${ui.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="tab-body" id="tab">${tabBody(a)}</div>`;
}

function tabBody(a) {
  switch (ui.tab) {
    case 'answers':
      return `${a.questions.length ? `<div class="section-title">Waiting for your answer</div><div class="qa">${a.questions.map((q) => `<div class="qa-item"><div class="qa-a missing">${esc(q)}</div></div>`).join('')}</div>` : ''}
        <div class="section-title">Answers sent (${a.answers.length})</div>
        <div class="qa">${a.answers.map((x) => `<div class="qa-item"><div class="qa-q">${esc(x.question)}</div><div class="qa-a">${esc(typeof x.answer === 'string' ? x.answer : JSON.stringify(x.answer))}</div>${x.source ? `<div class="qa-src">from ${esc(x.source)}</div>` : ''}</div>`).join('') || '<div class="empty">No answers recorded.</div>'}</div>`;
    case 'resume':
      return `${a.resume.exact ? '' : '<div class="note">This is your current resume. It changed after this application went out, so the sent version may be a bit different. New applications keep an exact copy.</div>'}
        <div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn small" data-path="${esc(a.resume.path)}">Open in Preview</button><button class="btn small" data-reveal="${esc(a.resume.path)}">Show in Finder</button><span style="color:var(--faint);align-self:center;font-size:12px">${esc(a.resume.path)}</span></div>
        <iframe class="pdf" src="${fileUrl(a.resume.path)}"></iframe>`;
    case 'shots':
      return a.screenshots.length ? `<div class="shots">${a.screenshots.map((p) => `<figure data-shot="${esc(p)}"><img src="${fileUrl(p)}" loading="lazy"><figcaption>${esc(p.split('/').pop())}</figcaption></figure>`).join('')}</div>` : '<div class="empty">No screenshots.</div>';
    case 'report':
      queueMicrotask(async () => { const t = await window.co.text(a.report); const el = $('#report-md'); if (el) el.innerHTML = t ? md(t) : 'Report not found.'; });
      return `<div class="md" id="report-md">Loading…</div>`;
    case 'outreach':
      return outreachMail(a.outreach);
    default:
      return timeline(a);
  }
}

// ---------- needs you ----------
function renderNeeds() {
  const list = needs();
  const filters = [['all', 'All'], ['needs_answer', 'Needs answer'], ['captcha', 'CAPTCHA'], ['failed', 'Failed']];
  return renderApps(list, filters, 'needs');
}

// ---------- skipped ----------
function renderSkipped() {
  const q = ui.search.toLowerCase();
  const list = D.apps.filter((a) => a.stage === 'skipped');
  const reasons = {};
  for (const a of list) { const k = String(a.reason || '?').split(/[:(]/)[0].trim(); reasons[k] = (reasons[k] || 0) + 1; }
  const f = ui.filter.skip || 'all';
  const rows = list.filter((a) => (f === 'all' || String(a.reason).split(/[:(]/)[0].trim() === f) && matches(q, a.company, a.role, a.reason)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return `<div class="pad"><div class="filters" style="padding:0 0 12px;border:0"><button class="chip ${f === 'all' ? 'on' : ''}" data-filter="skip:all">All<b>${list.length}</b></button>
    ${Object.entries(reasons).sort((x, y) => y[1] - x[1]).map(([k, n]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter="skip:${esc(k)}">${esc(k.replace(/_/g, ' '))}<b>${n}</b></button>`).join('')}</div>
    <table class="table"><thead><tr><th>Date</th><th>Company</th><th>Role</th><th>Score</th><th>Why skipped</th></tr></thead><tbody>
    ${rows.slice(0, 400).map((a) => `<tr class="click" ${a.url ? `data-url="${esc(a.url)}"` : ''}><td class="num">${fmtDate(a.date)}</td><td>${esc(a.company)}</td><td>${esc(a.role)}</td><td class="num">${esc(a.score ?? '')}</td><td style="color:var(--muted)">${esc(a.reason)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------- outreach ----------
function outreachMail(o) {
  if (!o) return '<div class="empty">No outreach for this one.</div>';
  return `${o.state === 'no_contact' ? `<div class="note">No email address found. ${esc(o.notes)}</div>` : ''}
    <div class="mail"><div class="mail-meta"><span>To</span><span>${esc(o.toName || '—')}${o.toEmail ? ` &lt;${esc(o.toEmail)}&gt;` : ''}</span>
      <span>Title</span><span>${esc(o.toTitle || '—')}</span><span>Subject</span><span>${esc(o.subject)}</span>
      <span>Status</span><span>${pill(OUT_STATE, o.state)} ${o.sentAt ? `sent ${fmtDateTime(o.sentAt)}` : ''}${o.emailCheck ? ` · ${esc(o.emailCheck)}` : ''}</span></div>
      <div class="mail-text">${esc(o.body)}</div></div>
    ${o.followupBody ? `<div class="section-title">Follow-up ${o.followupAt ? `(sent ${fmtDateTime(o.followupAt)})` : '(not sent yet)'}</div><div class="mail"><div class="mail-text">${esc(o.followupBody)}</div></div>` : ''}
    ${o.state !== 'no_contact' && o.notes ? `<div class="section-title">How the contact was found</div><div style="color:var(--muted)">${esc(o.notes)}</div>` : ''}
    ${(Array.isArray(o.evidence) ? o.evidence : []).length || o.personEvidence ? `<div class="section-title">Evidence</div>${[...(Array.isArray(o.evidence) ? o.evidence : []), o.personEvidence].filter(Boolean).map((u) => (/^https?:\/\/\S+$/.test(u) ? `<div><a data-url="${esc(u)}">${esc(u)}</a></div>` : `<div style="color:var(--muted)">${esc(u)}</div>`)).join('')}` : ''}`;
}

function renderOutreach(kind) {
  const q = ui.search.toLowerCase(), key = `out-${kind}`;
  const list = D.outreach.filter((o) => o.kind === kind);
  const f = ui.filter[key] || (list.some((o) => o.sentAt) ? 'contacted' : 'all');
  const states = [['contacted', 'Contacted'], ['replied', 'Replied'], ['followed_up', 'Followed up'], ['sent', 'Sent'], ['draft', 'Drafts'], ['bounced', 'Bounced'], ['no_contact', 'No contact'], ['all', 'All']];
  const ok = (o) => f === 'all' || (f === 'contacted' ? !!o.sentAt : o.state === f);
  const rows = list.filter((o) => ok(o) && matches(q, o.company, o.role, o.toName, o.toEmail)).sort((a, b) => String(b.sentAt || b.created).localeCompare(String(a.sentAt || a.created)));
  if (!rows.find((o) => o.num === ui.sel[key])) ui.sel[key] = rows[0]?.num;
  const sel = list.find((o) => o.num === ui.sel[key]);
  const n = (s) => list.filter((o) => (s === 'all' ? true : s === 'contacted' ? !!o.sentAt : o.state === s)).length;
  return `<div class="split"><div class="list-pane"><div class="filters">${states.map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-filter="${key}:${k}">${l}<b>${n(k)}</b></button>`).join('')}</div>
    <div class="rows">${rows.map((o) => `<div class="row ${o.num === ui.sel[key] ? 'on' : ''}" data-out="${key}:${esc(o.num)}"><div class="row-title">${esc(o.company)}</div><div>${pill(OUT_STATE, o.state)}</div>
      <div class="row-sub">${esc(o.toName ? `${o.toName} · ${o.toTitle}` : o.role)}</div><div class="row-meta">${fmtDate(o.sentAt || o.created)}</div></div>`).join('') || '<div class="empty">Nothing here.</div>'}</div></div>
    <div class="detail">${sel ? `<div class="detail-head"><h2>${esc(sel.company)}</h2><div class="role">${esc(sel.role)}</div>
      <div class="actions">${pill(OUT_STATE, sel.state)}${sel.url ? `<button class="btn small" data-url="${esc(sel.url)}">Open ${kind === 'cold' ? 'site' : 'job post'} ↗</button>` : ''}${/^\d+$/.test(sel.num) && byId(sel.num.padStart(3, '0')) ? `<button class="btn small" data-open-app="${sel.num.padStart(3, '0')}">Open application</button>` : ''}</div>
      <div class="facts"><span><b>Drafted</b> ${fmtDate(sel.created)}</span>${sel.sentAt ? `<span><b>Sent</b> ${fmtDate(sel.sentAt)}</span>` : ''}${sel.followupAt ? `<span><b>Follow-up</b> ${fmtDate(sel.followupAt)}</span>` : ''}${sel.repliedAt ? `<span><b>Replied</b> ${fmtDate(sel.repliedAt)}</span>` : ''}</div></div>
      <div class="tab-body">${outreachMail(sel)}</div>` : '<div class="empty">Pick an email.</div>'}</div></div>`;
}

// ---------- inbox ----------
function renderInbox() {
  const q = ui.search.toLowerCase();
  const options = sent().slice().sort((a, b) => a.company.localeCompare(b.company)).map((a) => `<option value="${a.id}">${esc(a.company)} — ${esc(a.role)} (${fmtDate(a.date)})</option>`).join('');
  const un = D.unmatched.filter((e) => matches(q, e.from, e.subject, e.reason)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const recent = D.events.filter((e) => e.num && e.kind !== 'other' && matches(q, e.company, e.subject, e.reason)).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 80);
  const st = D.inbox || {};
  return `<div class="pad">
    <div class="card" style="margin-bottom:14px"><h2>How this works</h2><div style="color:var(--muted)">Each daily run (and the <b>Check inbox</b> button) reads new mail. Keyword rules spot rejections, interviews and receipts; Haiku reads only the unclear ones. Clear matches move the status by themselves. Last check: ${st.synced_at ? esc(fmtDateTime(st.synced_at)) : 'never'}${st.last_ai_cost_usd ? ` · Haiku cost $${Number(st.last_ai_cost_usd).toFixed(3)}` : ''}.</div></div>
    <div class="section-title">Not matched to an application (${un.length})</div>
    ${un.length ? un.map((e) => `<div class="card" style="margin-bottom:10px"><div class="tl-head">${pill(KIND, e.kind)}<b>${esc(senderName(e.from))}</b><span class="tl-date">${fmtDateTime(e.date)}</span></div>
      <div class="tl-reason">${esc(e.reason)}</div><div class="tl-mail">“${esc(e.subject)}”</div>${e.quote ? `<div class="tl-quote">${esc(e.quote)}</div>` : ''}
      <div class="assign"><select data-assign-sel="${e.uid}"><option value="">Assign to an application…</option>${options}</select><button class="btn small" data-assign="${e.uid}">Assign</button></div></div>`).join('') : '<div class="empty">All status emails matched an application.</div>'}
    <div class="section-title">Recent status emails</div>
    <table class="table"><thead><tr><th>Date</th><th>Kind</th><th>Application</th><th>What it means</th></tr></thead><tbody>
    ${recent.map((e) => `<tr class="click" data-open-app="${e.num}"><td class="num" style="white-space:nowrap">${fmtDate(e.date)}</td><td>${pill(KIND, e.kind)}</td><td><b>${esc(byId(e.num)?.company || e.company)}</b><div style="color:var(--muted);font-size:12px">${esc(e.role)}</div></td><td style="color:var(--muted)">${esc(e.reason)}${e.status_to ? ` <span class="tag">→ ${esc(e.status_to)}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ---------- render ----------
const TITLES = { overview: 'Overview', apps: 'Applications', needs: 'Needs you', inbox: 'Inbox', outreach: 'Outreach', cold: 'Cold outreach', skipped: 'Skipped', settings: 'Settings' };
function render() {
  if (!D) return;
  renderNav();
  $('#title').textContent = TITLES[ui.view];
  $('#search').style.visibility = ['overview', 'settings'].includes(ui.view) ? 'hidden' : 'visible';
  const view = $('#view');
  const keep = [...view.querySelectorAll('.rows, .detail, .content')].map((el) => el.scrollTop);
  view.innerHTML = ui.view === 'apps' ? renderApps(sent(), APP_FILTERS, 'apps')
    : ui.view === 'needs' ? renderNeeds()
      : ui.view === 'outreach' ? renderOutreach('role')
        : ui.view === 'cold' ? renderOutreach('cold')
          : ui.view === 'inbox' ? renderInbox()
            : ui.view === 'skipped' ? renderSkipped()
              : ui.view === 'settings' ? renderSettingsView() : renderOverview();
  const sort = view.querySelector('[data-sort]'); if (sort) sort.value = ui.sort;
  view.querySelectorAll('.rows, .detail').forEach((el, i) => { if (keep[i]) el.scrollTop = keep[i]; });
}

function go(viewName) { ui.view = viewName; ui.tab = 'timeline'; $('#view').scrollTop = 0; render(); }

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-nav],[data-app],[data-out],[data-tab],[data-filter],[data-url],[data-path],[data-reveal],[data-shot],[data-open-app],[data-assign],.lightbox');
  if (!t) return;
  if (t.classList.contains('lightbox')) return t.remove();
  const d = t.dataset;
  if (d.nav) return go(d.nav);
  if (d.openApp) { const a = byId(d.openApp); if (!a) return; ui.view = a.stage === 'sent' ? 'apps' : 'needs'; ui.sel.app = a.id; ui.filter[ui.view] = 'all'; ui.tab = 'timeline'; ui.search = ''; $('#search').value = ''; return render(); }
  if (d.app) { ui.sel.app = d.app; return render(); }
  if (d.out) { const [key, num] = d.out.split(/:(.+)/); ui.sel[key] = num; return render(); }
  if (d.tab) { ui.tab = d.tab; return render(); }
  if (d.filter) { const [key, val] = d.filter.split(/:(.+)/); ui.filter[key] = val; return render(); }
  if (d.url) return window.co.openUrl(d.url);
  if (d.path) { const err = await window.co.openPath(d.path); if (err) toast(err); return; }
  if (d.reveal) return window.co.reveal(d.reveal);
  if (d.shot) { const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${fileUrl(d.shot)}">`; return document.body.appendChild(lb); }
  if (d.assign) {
    const sel = document.querySelector(`[data-assign-sel="${d.assign}"]`);
    if (!sel?.value) return toast('Pick an application first.');
    t.disabled = true;
    const r = await window.co.assign(d.assign, sel.value);
    toast(r.out.trim() || (r.ok ? 'Assigned.' : 'Failed.'));
    return reload();
  }
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.matches('[data-sort]')) { ui.sort = t.value; return render(); }
  if (t.matches('[data-set-status]')) {
    t.disabled = true;
    const r = await window.co.setStatus(t.dataset.setStatus, t.value);
    let msg = r.out;
    try { const j = JSON.parse(r.out); msg = j.error ? `Could not change status: ${j.error}` : `Status changed to ${t.value === 'Responded' ? 'In process' : t.value === 'Discarded' ? 'Closed' : t.value}.`; } catch { /* plain text */ }
    toast(msg, 4000);
    return reload();
  }
});

let searchTimer;
$('#search').addEventListener('input', (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { ui.search = e.target.value.trim(); render(); }, 120); });

$('#sync').addEventListener('click', async () => {
  const b = $('#sync');
  b.disabled = true; b.querySelector('svg').classList.add('spin'); b.querySelector('span').textContent = 'Checking…';
  const r = await window.co.syncInbox();
  b.disabled = false; b.querySelector('svg').classList.remove('spin'); b.querySelector('span').textContent = 'Check inbox';
  const lines = r.out.trim().split('\n');
  toast(r.ok ? lines.filter((l) => !/^received/.test(l)).slice(-12).join('\n') : `Inbox check failed:\n${lines.slice(-6).join('\n')}`, r.ok ? 9000 : 0);
  reload();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('.lightbox, .toast')?.remove();
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#search').focus(); }
  if ((e.metaKey || e.ctrlKey) && /^[1-7]$/.test(e.key)) go(['overview', 'apps', 'needs', 'inbox', 'outreach', 'cold', 'skipped'][Number(e.key) - 1]);
  if ((e.metaKey || e.ctrlKey) && e.key === ',') go('settings');
});

// Live file changes redraw lists, but never under a half-filled settings form.
window.co.onChange(() => { if (ui.view !== 'settings') reload(); });
// settings.js loads after this file: start once every script has run.
window.addEventListener('DOMContentLoaded', () => reload().then(() => maybeSetup()));
