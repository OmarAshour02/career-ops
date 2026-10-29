// macOS: keep the workers' browser windows out of the owner's way while a batch runs.
// The browser stays a normal headed browser (headless trips bot checks); only its app is
// hidden, like Cmd+H. New windows and tabs bring it back, so it is hidden again every second.
// Only "Google Chrome for Testing" (Playwright's Chromium) is touched, never the owner's Chrome.
import { execFile } from 'node:child_process';

const BUNDLE = 'com.google.chrome.for.testing';
// NSRunningApplication.hide needs no Automation/Accessibility permission, unlike System Events.
const JXA = `ObjC.import('AppKit'); var n = 0; for (var a of $.NSWorkspace.sharedWorkspace.runningApplications.js) { if (a.bundleIdentifier.js === '${BUNDLE}' && !a.hidden) { a.hide; n++; } } n`;

export function startHider({ platform = process.platform, everyMs = 1000, run = execFile } = {}) {
  if (platform !== 'darwin') return () => {};
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    run('osascript', ['-l', 'JavaScript', '-e', JXA], { timeout: 5000 }, () => { busy = false; });
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  tick();
  return () => clearInterval(timer);
}
