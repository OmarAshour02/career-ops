// Career Ops desktop: a window over the career-ops files. Code and UI load live from ROOT/desktop,
// so the packaged .app is only a launcher and edits show up on the next reload.
import { app, BrowserWindow, ipcMain, shell, protocol, net, nativeTheme, dialog } from 'electron';
import { spawn, execFileSync } from 'node:child_process';
import { watch, existsSync, writeFileSync, readFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

// career-ops folder: env, then the folder picked in the app, then ~/career-ops.
const PREFS = join(app.getPath('userData'), 'prefs.json');
const prefs = (() => { try { return JSON.parse(readFileSync(PREFS, 'utf8')); } catch { return {}; } })();
const isRoot = (dir) => existsSync(join(dir, 'autoapply/runner.mjs')) && existsSync(join(dir, 'desktop/renderer/index.html'));
const ROOT = resolve(process.env.CAREER_OPS_ROOT || prefs.root || join(homedir(), 'career-ops'));
const ROOT_OK = isRoot(ROOT);
const PATH = [join(homedir(), '.local/bin'), join(homedir(), '.opencode/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const STATES = ['Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded'];

protocol.registerSchemesAsPrivileged([{ scheme: 'co', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const inRoot = (rel) => {
  const p = resolve(ROOT, String(rel || ''));
  return p.startsWith(ROOT + sep) ? p : null;
};
const data = () => import(pathToFileURL(join(ROOT, 'desktop/data.mjs')).href);
const settings = () => import(pathToFileURL(join(ROOT, 'desktop/settings.mjs')).href);
const guard = (fn) => async (...args) => { try { return { ok: true, value: await fn(...args) } } catch (e) { return { ok: false, error: e.message } } };

function run(cmd, args) {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => done({ ok: code === 0, code, out: out.slice(-4000) }));
    child.on('error', (e) => done({ ok: false, code: -1, out: e.message }));
  });
}

function runNode(script, args, keep = 20000) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, script), ...args], {
      cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    child.on('close', (code) => done({ ok: code === 0, code, out: out.slice(-keep) }));
    child.on('error', (e) => done({ ok: false, code: -1, out: e.message }));
  });
}

let win;
let syncing = false;

// ---------- manual run of daily.sh (the same script the schedule runs) ----------
const runLock = () => join(ROOT, 'autoapply/.workflow.lock');
const dailyPids = () => {
  try { return execFileSync('pgrep', ['-f', join(ROOT, 'autoapply/daily.sh')], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean); } catch { return []; }
};
function runState() {
  const running = existsSync(runLock());
  return { running, since: running ? statSync(runLock()).mtime.toISOString() : null, log: `autoapply/logs/daily-${new Date().toISOString().slice(0, 10)}.log` };
}
function startRun(dry) {
  if (existsSync(runLock())) throw new Error('A run is already going.');
  if (existsSync(join(ROOT, 'autoapply/.nonstop.stop'))) throw new Error('Auto-apply is turned off. Turn on "Daily run" first.');
  const child = spawn('/bin/bash', [join(ROOT, 'autoapply/daily.sh'), ...(dry ? ['--dry-run'] : [])], { cwd: ROOT, env: { ...process.env, PATH }, detached: true, stdio: 'ignore' });
  child.unref();
  return new Promise((done) => setTimeout(() => done(runState()), 1500));
}
// Stops the whole daily.sh process group; the runner aborts its workers on SIGTERM.
async function stopRun() {
  for (const pid of dailyPids()) { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } }
  await new Promise((r) => setTimeout(r, 3000));
  if (!dailyPids().length && existsSync(runLock())) rmSync(runLock(), { recursive: true, force: true });
  return runState();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620, title: 'Career Ops',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2F243A' : '#F5F2F1',
    webPreferences: { preload: ROOT_OK ? join(ROOT, 'desktop/preload.cjs') : join(app.getAppPath(), 'preload.cjs'), contextIsolation: true, sandbox: true, plugins: true },
  });
  if (ROOT_OK) win.loadURL('co://local/desktop/renderer/index.html');
  else win.loadFile(join(app.getAppPath(), 'choose-root.html'), { query: { tried: ROOT } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('co://local/')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}

function watchFiles() {
  let timer;
  const ping = () => { clearTimeout(timer); timer = setTimeout(() => win?.webContents.send('data:changed'), 600); };
  for (const rel of ['autoapply/results', 'autoapply/outreach', 'autoapply/inbox', 'data']) {
    const p = join(ROOT, rel);
    if (existsSync(p)) try { watch(p, ping); } catch { /* dir vanished */ }
  }
}

app.whenReady().then(() => {
  protocol.handle('co', (req) => {
    const p = inRoot(decodeURIComponent(new URL(req.url).pathname).slice(1));
    return p && existsSync(p) ? net.fetch(pathToFileURL(p).href) : new Response('not found', { status: 404 });
  });

  ipcMain.handle('data:load', async () => (await data()).loadAll(ROOT));
  ipcMain.handle('file:text', async (_e, rel) => (inRoot(rel) ? (await data()).readText(ROOT, rel) : null));
  ipcMain.handle('open:path', (_e, rel) => { const p = inRoot(rel); return p ? shell.openPath(p) : 'outside career-ops'; });
  ipcMain.handle('open:reveal', (_e, rel) => { const p = inRoot(rel); if (p) shell.showItemInFolder(p); });
  ipcMain.handle('open:url', (_e, url) => { if (/^(https?:|mailto:)/.test(String(url))) shell.openExternal(url); });
  ipcMain.handle('status:set', (_e, id, state) => {
    if (!/^\d+$/.test(String(id)) || !STATES.includes(state)) return { ok: false, out: 'bad input' };
    return runNode('set-status.mjs', ['--report', String(Number(id)), state, '--note', `set by hand in desktop app ${new Date().toISOString().slice(0, 10)}`, '--json']);
  });
  ipcMain.handle('inbox:sync', async () => {
    if (syncing) return { ok: false, out: 'A sync is already running.' };
    syncing = true;
    try { return await runNode('autoapply/inbox-sync.mjs', []); } finally { syncing = false; }
  });
  ipcMain.handle('inbox:assign', (_e, uid, id) => {
    if (!/^\d+$/.test(String(uid)) || !/^\d+$/.test(String(id))) return { ok: false, out: 'bad input' };
    return runNode('autoapply/inbox-sync.mjs', ['assign', String(uid), String(id)]);
  });

  ipcMain.handle('root:choose', async () => {
    const pick = await dialog.showOpenDialog(win, { title: 'Choose your career-ops folder', properties: ['openDirectory'] });
    if (pick.canceled) return { ok: false };
    const dir = pick.filePaths[0];
    if (!isRoot(dir)) return { ok: false, error: `${dir} is not a career-ops folder with autoapply/ and desktop/ in it.` };
    mkdirSync(dirname(PREFS), { recursive: true });
    writeFileSync(PREFS, JSON.stringify({ ...prefs, root: dir }, null, 1));
    app.relaunch(); app.exit(0);
    return { ok: true };
  });
  ipcMain.handle('root:get', () => ({ root: ROOT, ok: ROOT_OK }));
  ipcMain.handle('settings:get', guard(async () => {
    const s = await settings(), d = await data();
    return { ...s.readSettings(ROOT), questions: s.openQuestions(d.loadAll(ROOT).apps, ROOT) };
  }));
  ipcMain.handle('settings:save', guard(async (_e, patch) => (await settings()).saveFacts(ROOT, patch)));
  ipcMain.handle('settings:env', guard(async (_e, vals) => (await settings()).saveEnv(ROOT, vals)));
  ipcMain.handle('settings:cv', guard(async (_e, text) => (await settings()).saveCv(ROOT, text)));
  ipcMain.handle('settings:pause', guard(async (_e, on) => (await settings()).setPaused(ROOT, Boolean(on))));
  ipcMain.handle('settings:schedule', guard(async (_e, time) => (await settings()).applySchedule(ROOT, time || null)));
  ipcMain.handle('settings:resume', guard(async () => {
    const pick = await dialog.showOpenDialog(win, { title: 'Choose your resume PDF', properties: ['openFile'], filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (pick.canceled) return null;
    return (await settings()).importResume(ROOT, pick.filePaths[0]);
  }));
  ipcMain.handle('settings:cv-from-pdf', async () => {
    const s = (await settings()).readSettings(ROOT);
    if (s.resume.missing) return { ok: false, error: 'Choose a resume PDF first.' };
    const r = await runNode('autoapply/cv-from-pdf.mjs', [join(ROOT, s.resume.path)], 1e6);
    if (!r.ok) return { ok: false, error: r.out.trim().split('\n').pop() || 'Could not read the PDF.' };
    return { ok: true, value: JSON.parse(r.out) };
  });
  ipcMain.handle('settings:ai-check', async () => {
    const [cl, auth, oc] = await Promise.all([run('claude', ['--version']), run('claude', ['auth', 'status']), run('opencode', ['--version'])]);
    let login = null;
    try { login = JSON.parse(auth.out); } catch {}
    return {
      claude: { installed: cl.ok, version: cl.out.trim().split('\n')[0].replace(/\s*\(Claude Code\)$/, ''), loggedIn: Boolean(login?.loggedIn), method: login?.authMethod || null },
      opencode: { installed: oc.ok, version: oc.out.trim().split('\n')[0] },
    };
  });
  ipcMain.handle('run:state', guard(async () => runState()));
  ipcMain.handle('run:start', guard(async (_e, dry) => startRun(Boolean(dry))));
  ipcMain.handle('run:stop', guard(async () => stopRun()));
  ipcMain.handle('settings:email-test', () => run('python3', ['-I', join(ROOT, 'autoapply/mail.py'), 'login']));

  createWindow();
  if (process.env.CO_SNAPSHOT) snapshots(process.env.CO_SNAPSHOT);
  if (!ROOT_OK) return;
  watchFiles();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

// Dev check: CO_SNAPSHOT=dir saves a PNG of each view, then quits.
async function snapshots(dir) {
  mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (e) => console.log('[page]', e.message ?? e));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(1500);
  const steps = (process.env.CO_SNAPSHOT_STEPS || 'overview').split(',');
  for (const step of steps) {
    const [view, extra] = step.split(':');
    // wiz:N shows first-run setup step N.
    if (view === 'wiz') await win.webContents.executeJavaScript(`step = ${Number(extra)}; showWizard()`);
    // eval:N runs the code in CO_SNAPSHOT_EVALN (e.g. type into fields and click Save).
    else if (view === 'eval') await win.webContents.executeJavaScript(process.env[`CO_SNAPSHOT_EVAL${extra}`] || '');
    else await win.webContents.executeJavaScript(`(() => { const b = document.querySelector('[data-nav="${view}"]'); b && b.click(); ${extra ? `const t = document.querySelector('[data-tab="${extra}"],[data-s-tab="${extra}"]'); t && t.click();` : ''} })()`);
    await wait(1200);
    writeFileSync(join(dir, `${step.replace(':', '-')}.png`), (await win.webContents.capturePage()).toPNG());
  }
  app.quit();
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
