// Settings for the window: read and write config/apply-facts.yml (comments kept), .env, the resume PDF,
// the pause file and the daily job (launchd on macOS; a systemd user timer, or crontab, on Linux).
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { MODEL_DEFAULTS } from '../autoapply/profile.mjs';

const FACTS = 'config/apply-facts.yml', EXAMPLE = 'config/apply-facts.example.yml';
const LABEL = 'com.careerops.daily', OLD_LABELS = ['com.omar.autoapply'];
const agentPath = (label) => join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const UNIT = 'careerops-daily', CRON_TAG = '# careerops-daily';
const unitDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd/user');

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
  if (process.platform === 'linux') return linuxScheduleState();
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
  if (process.platform === 'linux') return applyLinuxSchedule(root, time);
  if (process.platform !== 'darwin') throw new Error('Scheduling works on macOS and Linux only.');
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

// ---------- Linux: systemd user timer, or crontab where systemd --user isn't running ----------
const hasSystemdUser = () => { try { execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' }); return true; } catch { return false; } };
const crontabLines = () => { try { return execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean); } catch { return []; } };
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// The unit files and cron line for `time` (HH:MM). Persistent=true runs a missed day once the computer is back on.
export function linuxSchedule(root, time) {
  const [h, m] = time.split(':').map(Number);
  const hh = String(h).padStart(2, '0'), mm = String(m).padStart(2, '0');
  const script = join(root, 'autoapply/daily.sh');
  return {
    service: `[Unit]\nDescription=Career Ops daily auto-apply run\n\n[Service]\nType=oneshot\nWorkingDirectory=${root}\nExecStart=/bin/bash "${script}"\n`,
    timer: `[Unit]\nDescription=Career Ops daily run at ${hh}:${mm}\n\n[Timer]\nOnCalendar=*-*-* ${hh}:${mm}:00\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
    cron: `${m} ${h} * * * /bin/bash ${shq(script)} >> ${shq(join(root, 'autoapply/logs/cron.out'))} 2>&1 ${CRON_TAG}`,
  };
}

function linuxScheduleState() {
  const timer = join(unitDir(), `${UNIT}.timer`);
  if (existsSync(timer)) {
    const t = readFileSync(timer, 'utf8').match(/OnCalendar=\*-\*-\* (\d\d):(\d\d)/);
    return { supported: true, installed: true, label: `${UNIT}.timer`, time: t ? `${t[1]}:${t[2]}` : null };
  }
  const line = crontabLines().find((l) => l.endsWith(CRON_TAG));
  if (line) {
    const [m, h] = line.split(/\s+/);
    return { supported: true, installed: true, label: 'crontab', time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}` };
  }
  return { supported: true, installed: false };
}

function applyLinuxSchedule(root, time) {
  const systemd = hasSystemdUser();
  const timer = join(unitDir(), `${UNIT}.timer`), service = join(unitDir(), `${UNIT}.service`);
  if (existsSync(timer) || existsSync(service)) {
    if (systemd) try { execFileSync('systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`], { stdio: 'ignore' }); } catch { /* not enabled */ }
    for (const p of [timer, service]) if (existsSync(p)) unlinkSync(p);
    if (systemd) execFileSync('systemctl', ['--user', 'daemon-reload']);
  }
  const cron = crontabLines();
  const setCron = (lines) => execFileSync('crontab', ['-'], { input: lines.length ? `${lines.join('\n')}\n` : '' });
  if (cron.some((l) => l.endsWith(CRON_TAG))) setCron(cron.filter((l) => !l.endsWith(CRON_TAG)));
  if (!time) return readSettings(root);
  const [h, m] = time.split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new Error('Use a time like 10:00.');
  const s = linuxSchedule(root, time);
  if (systemd) {
    atomicWrite(service, s.service);
    atomicWrite(timer, s.timer);
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]);
  } else {
    try { execFileSync('crontab', ['-l'], { stdio: 'ignore' }); } catch (e) {
      if (e.code === 'ENOENT') throw new Error('No systemd user session and no crontab. Install cron (cronie) to schedule the daily run.');
    }
    setCron([...crontabLines().filter((l) => !l.endsWith(CRON_TAG)), s.cron]);
  }
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
