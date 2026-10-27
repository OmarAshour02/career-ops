#!/usr/bin/env node
// Keep a copy of the resume each submitted application used: autoapply/sent/NNN-resume.pdf.
// Copies only when the source PDF is unchanged since the submit time, so the copy is the version that was sent.
import { readFileSync, readdirSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../lib/is-main-module.mjs';
import { loadFacts, resumePath } from './profile.mjs';

const ROOT = process.env.AUTOAPPLY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

export function resumeSource(result, master = resumePath(loadFacts(ROOT))) {
  for (const a of result.answers || []) {
    const src = String(a?.source || '').match(/output\/[^\s"']+\.pdf/)?.[0];
    if (src && /resume|cv/i.test(`${a.question} ${src}`)) return src;
  }
  return master;
}

export function snapshotResumes(root = ROOT) {
  const dir = join(root, 'autoapply/sent'), resDir = join(root, 'autoapply/results');
  mkdirSync(dir, { recursive: true });
  let saved = 0, stale = 0;
  for (const f of readdirSync(resDir).filter((f) => /^\d+\.json$/.test(f))) {
    let r; try { r = JSON.parse(readFileSync(join(resDir, f), 'utf8')); } catch { continue; }
    if (r.status !== 'submitted' || !r.num) continue;
    const out = join(dir, `${String(r.num).padStart(3, '0')}-resume.pdf`);
    if (existsSync(out)) continue;
    const src = join(root, resumeSource(r));
    if (!existsSync(src)) continue;
    if (statSync(src).mtimeMs > Date.parse(r.finished_at)) { stale++; continue; }
    copyFileSync(src, out); saved++;
  }
  console.log(`resume snapshots: ${saved} saved, ${stale} skipped (resume changed after submit)`);
}

if (isMainModule(import.meta.url)) snapshotResumes();
