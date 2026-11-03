'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const run = promisify(execFile);

// The path of the running .app, or null when this isn't a packaged Mac app.
function macAppPath(execPath) {
  const match = execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
  return match ? match[1] : null;
}

// Running from the disk image or macOS's temporary launch location can't be updated in place.
async function canReplaceMacApp(appPath) {
  if (!appPath || appPath.startsWith('/Volumes/') || appPath.includes('/AppTranslocation/')) return false;
  try {
    await fs.promises.access(path.dirname(appPath), fs.constants.W_OK);
    await fs.promises.access(appPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function bundleId(appPath) {
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist]);
  return stdout.trim();
}

// The previous version can't always be fully removed while it's still running, so each launch tidies up.
async function removeUpdateLeftovers(appPath) {
  if (!appPath) return;
  const parent = path.dirname(appPath);
  for (const name of await fs.promises.readdir(parent).catch(() => [])) {
    if (name.startsWith('.beacon-update-')) {
      await fs.promises.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

// Unpacks beside the app so the final swap is a same-disk rename. The old app is restored on failure.
async function installMacUpdate(zipPath, appPath) {
  const work = await fs.promises.mkdtemp(path.join(path.dirname(appPath), '.beacon-update-'));
  try {
    await run('/usr/bin/ditto', ['-xk', zipPath, work]);
    const incoming = path.join(work, path.basename(appPath));
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', incoming]);
    if ((await bundleId(incoming)) !== (await bundleId(appPath))) throw new Error('Update is for a different app');
    const previous = path.join(work, 'previous.app');
    await fs.promises.rename(appPath, previous);
    try {
      await fs.promises.rename(incoming, appPath);
    } catch (err) {
      await fs.promises.rename(previous, appPath);
      throw err;
    }
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// Paths travel in the environment so no file name is ever parsed as PowerShell.
// Declining the administrator prompt reopens the current version.
function startWindowsInstaller(setupPath, appExe) {
  const script = "Start-Sleep -Seconds 2; try { Start-Process -FilePath $env:BEACON_SETUP -ArgumentList '/S','/allusers','--updated','--force-run' -Verb RunAs -ErrorAction Stop } catch { Start-Process -FilePath $env:BEACON_APP }";
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BEACON_SETUP: setupPath, BEACON_APP: appExe },
  });
  child.unref();
}

module.exports = { macAppPath, canReplaceMacApp, installMacUpdate, removeUpdateLeftovers, startWindowsInstaller };
