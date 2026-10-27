// Reads career-ops files into one model for the window: applications, inbox events, outreach.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { resumeSource } from '../autoapply/snapshot-resumes.mjs';

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const jsonFiles = (dir, re = /\.json$/) => (existsSync(dir) ? readdirSync(dir).filter((f) => re.test(f)).map((f) => readJson(join(dir, f))).filter(Boolean) : []);
const pad = (n) => String(n).padStart(3, '0');

// "soundcloud71" -> "Soundcloud", "the-exploration-company" -> "The Exploration Company"; real names stay as they are
export function prettyCompany(name) {
  const s = String(name || '').trim();
  if (/[A-Z ]/.test(s)) return s;
  return s.replace(/\d+$/, '').split(/[-_]+/).filter(Boolean).map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ');
}

function loadTracker(root) {
  const file = join(root, 'data/applications.md');
  const byReport = new Map();
  if (!existsSync(file)) return byReport;
  const lines = readFileSync(file, 'utf8').split('\n');
  const cols = resolveColumns(lines);
  for (const line of lines) {
    const row = parseTrackerRow(line, cols);
    const rep = row && String(row.report || '').match(/\[(\d+)\]/)?.[1];
    if (rep) byReport.set(pad(rep), row);
  }
  return byReport;
}

function stage(r) {
  if (r.status === 'submitted') return 'sent';
  if (r.status === 'needs_answer') return 'needs_answer';
  if (r.status === 'failed') return 'failed';
  if (/^captcha/i.test(String(r.reason || ''))) return 'captcha';
  return 'skipped';
}

function outreachState(d) {
  if (d.bounced) return 'bounced';
  if (d.replied_at) return 'replied';
  if (d.followup_at) return 'followed_up';
  if (d.sent_at) return 'sent';
  if (d.status === 'ready' && !d.skip) return 'draft';
  return 'no_contact';
}

export function loadAll(root) {
  const tracker = loadTracker(root);
  const events = readJson(join(root, 'autoapply/inbox/events.json'), []);
  const evBy = new Map();
  for (const e of events) if (e.num) evBy.set(e.num, [...(evBy.get(e.num) || []), e]);
  const outreachAll = jsonFiles(join(root, 'autoapply/outreach'));
  const outBy = new Map(outreachAll.filter((d) => /^\d+$/.test(String(d.num))).map((d) => [pad(d.num), d]));

  const results = jsonFiles(join(root, 'autoapply/results'), /^\d+\.json$/).filter((r) => r.num);
  // a needs-answer / CAPTCHA / failed attempt is done once a later attempt at the same job finished
  const later = new Map();
  for (const r of results) {
    if (!['submitted', 'skipped'].includes(r.status) || /^captcha/i.test(String(r.reason || ''))) continue;
    for (const k of [r.url, `${r.company}|${r.role}`.toLowerCase()]) if (k && String(r.finished_at) > String(later.get(k) || '')) later.set(k, r.finished_at);
  }
  const resolved = (r) => [r.url, `${r.company}|${r.role}`.toLowerCase()].some((k) => k && String(later.get(k) || '') > String(r.finished_at));
  const apps = results.map((r) => {
    const id = pad(r.num), row = tracker.get(id);
    let st = stage(r);
    if (['needs_answer', 'captcha', 'failed'].includes(st) && resolved(r)) st = 'resolved';
    const snap = join('autoapply/sent', `${id}-resume.pdf`);
    const src = resumeSource(r);
    const resume = existsSync(join(root, snap)) ? { path: snap, exact: true }
      : st === 'sent' && existsSync(join(root, src)) ? { path: src, exact: false } : null;
    const evs = (evBy.get(id) || []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const status = row?.status?.trim() || (st === 'sent' ? 'Applied' : st === 'skipped' ? 'SKIP' : 'Evaluated');
    const answers = (Array.isArray(r.answers) ? r.answers : []).filter((a) => a && typeof a === 'object' && a.question);
    return {
      id, row: row?.num ?? null, company: nameFromMail(r.company, evs) || prettyCompany(r.company), rawCompany: r.company, role: r.role, url: r.url,
      date: r.finished_at || row?.date || null, score: r.score ?? (row?.score ? parseFloat(row.score) : null),
      stage: st, status, reason: r.reason || '', detail: r.detail || r.reason_detail || '',
      report: r.report && existsSync(join(root, r.report)) ? r.report : null, notes: row?.notes || '',
      answers, questions: Array.isArray(r.questions_missing) ? r.questions_missing : [],
      screenshots: (r.screenshots || []).filter((p) => /\.(png|jpe?g)$/i.test(p) && existsSync(join(root, p))),
      confirmation: r.confirmation?.evidence || null, resume, events: evs,
      lastUpdate: evs.length ? evs[evs.length - 1].date : r.finished_at, outreach: outBy.get(id) ? summarizeOutreach(outBy.get(id)) : null,
    };
  });

  const outreach = outreachAll.map(summarizeOutreach);
  const unmatched = events.filter((e) => !e.num && e.kind !== 'other' && e.kind !== 'received');
  const state = readJson(join(root, 'autoapply/inbox/state.json'), {});
  const summaries = existsSync(join(root, 'autoapply')) ? readdirSync(join(root, 'autoapply')).filter((f) => /^summary-\d{4}-\d\d-\d\d\.md$/.test(f)).sort() : [];
  const lastSummary = summaries.length ? { day: summaries.at(-1).slice(8, 18), text: readFileSync(join(root, 'autoapply', summaries.at(-1)), 'utf8') } : null;
  const paused = existsSync(join(root, 'autoapply/.nonstop.stop'));
  return { apps, outreach, unmatched, events, inbox: state, lastSummary, paused, loadedAt: new Date().toISOString() };
}

// The company's own spelling, taken from its emails: "movableink" -> "Movable Ink", "platacard" -> "Plata"
export function nameFromMail(company, events) {
  const flat = String(company || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = new Set([flat, flat.replace(/\d+$/, ''), flat.replace(/^(use|get|try|join|the)/, ''), flat.replace(/(jobs|careers|hq|inc|app|ai|io|card)$/, '')].filter((x) => x.length >= 3));
  for (const e of events) {
    const words = `${String(e.from || '').replace(/<.*>/, '')} ${e.subject || ''}`.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.&]+$/gu, '')).filter((w) => /[\p{L}\p{N}]/u.test(w));
    for (let n = 4; n >= 1; n--) for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (want.has(phrase.toLowerCase().replace(/[^a-z0-9]/g, '')) && /[A-Z]/.test(phrase)) return phrase;
    }
  }
  return null;
}

function summarizeOutreach(d) {
  return {
    num: String(d.num), kind: d.kind === 'startup' ? 'cold' : 'role', company: prettyCompany(d.company), role: d.role, url: d.url || null,
    state: outreachState(d), toName: d.to_name, toTitle: d.to_title, toEmail: d.to_email, subject: d.subject, body: d.body,
    followupBody: d.followup_body, notes: d.notes || d.no_contact_reason || '', evidence: d.email_evidence || [], personEvidence: d.person_evidence || '',
    created: d.created_at || d.finished_at || null, sentAt: d.sent_at || null, followupAt: d.followup_at || null, repliedAt: d.replied_at || null, bounced: !!d.bounced,
    emailCheck: d.email_check || '',
  };
}

export function readText(root, rel) {
  const p = join(root, rel);
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).size > 2_000_000) return null;
  return readFileSync(p, 'utf8');
}
