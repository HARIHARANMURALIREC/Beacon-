'use strict';
// Builds the download site into site-dist, using facts read from the built installers.
// DOWNLOAD_BASE points at wherever the installers are hosted. Without it, they're copied in.
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'site-dist');
const { version } = require('../package.json');
const base = process.env.DOWNLOAD_BASE;

function describe(file) {
  const full = path.join(dist, file);
  const data = fs.readFileSync(full);
  return {
    file,
    full,
    size: `${Math.round(data.length / 1048576)} MB`,
    sha: crypto.createHash('sha256').update(data).digest('hex'),
    url: base ? `${base.replace(/\/$/, '')}/${file}` : `downloads/${file}`,
  };
}

const win = describe(`Beacon-Setup-${version}.exe`);
const arm = describe(`Beacon-${version}-arm64.dmg`);
const x64 = describe(`Beacon-${version}-x64.dmg`);

const plist = path.join(dist, 'mac-arm64', 'Beacon.app', 'Contents', 'Info.plist');
const macMin = execFileSync('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', plist]).toString().trim().split('.')[0];

const values = {
  VERSION: version,
  MAC_MIN: macMin,
  WIN_URL: win.url, WIN_SIZE: win.size, WIN_FILE: win.file, WIN_SHA: win.sha,
  ARM_URL: arm.url, ARM_SIZE: arm.size, ARM_FILE: arm.file, ARM_SHA: arm.sha,
  X64_URL: x64.url, X64_SIZE: x64.size, X64_FILE: x64.file, X64_SHA: x64.sha,
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const template = fs.readFileSync(path.join(root, 'website', 'index.html'), 'utf8');
const html = template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
  if (!(key in values)) throw new Error(`Unknown placeholder ${match}`);
  return values[key];
});
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const file of ['style.css', 'main.js']) fs.copyFileSync(path.join(root, 'website', file), path.join(out, file));
fs.copyFileSync(path.join(root, 'build', 'tray.png'), path.join(out, 'favicon.png'));
if (!base) {
  fs.mkdirSync(path.join(out, 'downloads'));
  for (const item of [win, arm, x64]) fs.copyFileSync(item.full, path.join(out, 'downloads', item.file));
}
console.log(`Site built in site-dist (macOS ${macMin}+, downloads from ${base || 'downloads/'})`);
