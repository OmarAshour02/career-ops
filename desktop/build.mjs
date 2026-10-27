// Builds the desktop launcher for this computer; with --install, puts it where the OS finds apps.
//   macOS: ~/Applications/Career Ops.app
//   Linux: ~/.local/opt/career-ops-desktop/ plus a menu entry in ~/.local/share/applications/
// Usage: node build.mjs [--install]
import { packager } from '@electron/packager';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HERE = import.meta.dirname;
const platform = process.platform;
if (!['darwin', 'linux'].includes(platform)) throw new Error(`No build for ${platform} yet: macOS and Linux only.`);

const [out] = await packager({
  dir: HERE, out: join(HERE, 'dist'), overwrite: true, platform, arch: process.arch,
  name: 'Career Ops', executableName: platform === 'linux' ? 'career-ops' : undefined,
  icon: join(HERE, platform === 'darwin' ? 'icon.icns' : 'icon.png'),
  appBundleId: 'com.careerops.desktop', ignore: [/^\/dist/],
});
console.log(`Built ${out}`);

if (process.argv.includes('--install')) {
  if (platform === 'darwin') {
    const dest = join(homedir(), 'Applications/Career Ops.app');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(join(homedir(), 'Applications'), { recursive: true });
    cpSync(join(out, 'Career Ops.app'), dest, { recursive: true, verbatimSymlinks: true });
    console.log(`Installed ${dest}`);
  } else {
    const dest = join(homedir(), '.local/opt/career-ops-desktop');
    rmSync(dest, { recursive: true, force: true });
    cpSync(out, dest, { recursive: true, verbatimSymlinks: true });
    cpSync(join(HERE, 'icon.png'), join(dest, 'icon.png'));
    const apps = join(process.env.XDG_DATA_HOME || join(homedir(), '.local/share'), 'applications');
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, 'career-ops.desktop'), `[Desktop Entry]
Type=Application
Name=Career Ops
Comment=Job applications, inbox status and outreach
Exec="${join(dest, 'career-ops')}" %U
Icon=${join(dest, 'icon.png')}
Terminal=false
Categories=Office;
StartupWMClass=Career Ops
`);
    console.log(`Installed ${dest} and a menu entry (Career Ops).`);
    // Electron's sandbox helper must be owned by root, unless the kernel allows unprivileged user namespaces.
    if (existsSync(join(dest, 'chrome-sandbox'))) {
      console.log(`If it doesn't open ("SUID sandbox helper" error), run once:
  sudo chown root:root "${join(dest, 'chrome-sandbox')}" && sudo chmod 4755 "${join(dest, 'chrome-sandbox')}"`);
    }
  }
}
