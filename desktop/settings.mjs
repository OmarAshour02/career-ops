// Settings for the window: read and write config/apply-facts.yml (comments kept), .env, the resume PDF,
// the pause file and the daily launchd job.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { MODEL_DEFAULTS } from '../autoapply/profile.mjs';

const FACTS = 'config/apply-facts.yml', EXAMPLE = 'config/apply-facts.example.yml';
const LABEL = 'com.careerops.daily', OLD_LABELS = ['com.omar.autoapply'];
const agentPath = (label) => join(homedir(), 'Library/LaunchAgents', `${label}.plist`);

function atomicWrite(p, text) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(`${p}.tmp`, text);
  renameSync(`${p}.tmp`, p);
}

function doc(root) {
  const p = join(root, FACTS);
  const src = existsSync(p) ? p : join(root, EXAMPLE);
  return parseDocument(existsSync(src) ? readFileSync(src, 'utf8') : '{}');
}

function readEnv(root) {
  const p = join(root, '.env');
  const vals = {};
  if (existsSync(p)) for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) vals[m[1]] = m[2].trim();
  }
  return vals;
}

export function readSettings(root) {
  const facts = doc(root).toJS() || {};
  const env = readEnv(root);
  const resumeRel = facts.resume?.pdf || '';
  const resumeAbs = resumeRel && join(root, resumeRel);
  return {
    root,
    facts,
    firstRun: !existsSync(join(root, FACTS)) || !facts.contact?.full_name,
    email: { user: env.GMAIL_USER || '', hasPassword: Boolean(env.GMAIL_APP_PASSWORD), hunter: Boolean(env.HUNTER_API_KEY) },
    resume: resumeAbs && existsSync(resumeAbs) ? { path: resumeRel, size: statSync(resumeAbs).size, modified: statSync(resumeAbs).mtime.toISOString() } : { path: resumeRel, missing: true },
    paused: existsSync(join(root, 'autoapply/.nonstop.stop')),
    cv: existsSync(join(root, 'cv.md')) ? readFileSync(join(root, 'cv.md'), 'utf8') : '',
    schedule: scheduleState(),
    models: { ...MODEL_DEFAULTS, ...facts.models },
  };
}

// patch: { "contact.email": "x", "answers_from_app": null (delete) } or [[["answers_from_app", "Question with. dots?"], "Yes"]]
export function saveFacts(root, patch) {
  const d = doc(root);
  for (const [path, value] of Array.isArray(patch) ? patch : Object.entries(patch)) {
    const keys = Array.isArray(path) ? path : path.split('.');
    if (value === null) d.deleteIn(keys);
    else d.setIn(keys, value);
  }
  atomicWrite(join(root, FACTS), d.toString({ lineWidth: 0 }));
  return readSettings(root);
}

// Keep every other .env line; only touch the keys given. An empty password means "keep the old one".
export function saveEnv(root, { user, password, hunter }) {
  const p = join(root, '.env');
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : [];
  const set = (key, val) => {
    if (val === undefined || val === '') return;
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = `${key}=${val}`; else lines.splice(lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, `${key}=${val}`);
  };
  set('GMAIL_USER', user?.trim());
  set('GMAIL_APP_PASSWORD', password?.replace(/\s+/g, ''));
  set('HUNTER_API_KEY', hunter?.trim());
  atomicWrite(p, `${lines.join('\n').replace(/\n*$/, '')}\n`);
  return readSettings(root);
}

// Copy the chosen PDF into output/master and point resume.pdf at it.
export function importResume(root, src) {
  if (!/\.pdf$/i.test(src) || !existsSync(src)) throw new Error('Pick a PDF file.');
  const facts = doc(root).toJS() || {};
  const name = facts.resume?.send_as || basename(src);
  const rel = `output/master/${name.replace(/[^\w.() -]+/g, '_')}`;
  mkdirSync(join(root, 'output/master'), { recursive: true });
  if (join(root, rel) !== src) copyFileSync(src, join(root, rel));
  return saveFacts(root, { 'resume.pdf': rel, 'resume.send_as': name });
}

// cv.md holds the facts writers may use (numbers, projects); keep a .bak of the last version.
export function saveCv(root, text) {
  const p = join(root, 'cv.md');
  if (existsSync(p)) copyFileSync(p, `${p}.bak`);
  atomicWrite(p, String(text).replace(/\r\n/g, '\n'));
  return readSettings(root);
}

export function setPaused(root, paused) {
  const p = join(root, 'autoapply/.nonstop.stop');
  if (paused) writeFileSync(p, `stopped from the desktop app ${new Date().toISOString()}\n`);
  else if (existsSync(p)) unlinkSync(p);
  return readSettings(root);
}

function scheduleState() {
  if (process.platform !== 'darwin') return { supported: false };
  for (const label of [LABEL, ...OLD_LABELS]) {
    const p = agentPath(label);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const h = text.match(/<key>Hour<\/key>\s*<integer>(\d+)/)?.[1], m = text.match(/<key>Minute<\/key>\s*<integer>(\d+)/)?.[1];
    return { supported: true, installed: true, label, time: h != null ? `${h.padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}` : null };
  }
  return { supported: true, installed: false };
}

// Write the daily launchd job (and retire the old hand-made one) so daily.sh runs at `time` (HH:MM), or remove it.
export function applySchedule(root, time) {
  if (process.platform !== 'darwin') throw new Error('Scheduling works on macOS only.');
  const uid = process.getuid();
  const unload = (label) => { try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ } };
  for (const label of [LABEL, ...OLD_LABELS]) { unload(label); if (existsSync(agentPath(label))) unlinkSync(agentPath(label)); }
  if (!time) return readSettings(root);
  const [h, m] = time.split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error('Use a time like 10:00.');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  atomicWrite(agentPath(LABEL), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${esc(join(root, 'autoapply/daily.sh'))}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>
  <key>StandardOutPath</key><string>${esc(join(root, 'autoapply/logs/launchd.out'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(root, 'autoapply/logs/launchd.err'))}</string>
</dict>
</plist>
`);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, agentPath(LABEL)]);
  saveFacts(root, { 'schedule.run_at': time });
  return readSettings(root);
}

// Questions workers could not answer, still open: no later attempt at the job finished, not ticked [x] in
// data/apply-questions.md, and not answered in the app.
export function openQuestions(apps, root) {
  const norm = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Set();
  const qfile = root && join(root, 'data/apply-questions.md');
  if (qfile && existsSync(qfile)) for (const line of readFileSync(qfile, 'utf8').split('\n')) {
    const m = line.match(/^- \[x\] #\S+ [^:]+: (.*?)(?: — .*)?$/i);
    if (m) seen.add(norm(m[1]));
  }
  for (const q of Object.keys(doc(root).toJS()?.answers_from_app || {})) seen.add(norm(q));
  const out = [];
  for (const a of apps) if (a.stage === 'needs_answer') for (const q of a.questions) out.push({ q, company: a.company, role: a.role, id: a.id, date: a.date });
  return out.sort((x, y) => String(y.date).localeCompare(String(x.date))).filter((x) => !seen.has(norm(x.q)) && seen.add(norm(x.q)));
}
