#!/usr/bin/env node
/**
 * Rebrand the Electron binary used by `npm start`.
 *
 * THE PROBLEM THIS SOLVES
 * When you run `electron .`, the process that Windows sees is literally
 * `node_modules/electron/dist/electron.exe`. Windows reads the taskbar
 * icon, the alt-tab icon and the right-click jump-list icon out of that
 * executable's own resource table. `app.setName()`, `app.setAppUserModelId()`
 * and `BrowserWindow({ icon })` all fix the *text* and the window icon, but
 * none of them can reach the exe's resources — which is why the Electron
 * atom kept coming back no matter what was changed in main.js.
 *
 * The fix is to patch the executable itself: rewrite its icon and version
 * strings, then rename it to NebulaClient.exe and point Electron's CLI at
 * the new name. After this runs, plain `npm start` shows your icon and your
 * name everywhere, no packaging step required.
 *
 * Runs automatically after `npm install`, and can be re-run any time with
 * `npm run brand`. Safe to run repeatedly.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'SolarClient';
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const PATH_TXT = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
const ICON_ICO = path.join(ROOT, 'build', 'icon.ico');

function log(msg) { console.log(`[brand] ${msg}`); }

// Does the .ico's pixel data actually appear inside the .exe? Reads the
// icon directory, grabs a mid-sized entry's payload, and searches for a
// slice of it in the binary.
function iconBytesPresent(exePath, icoPath) {
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const size = ico.readUInt32LE(e + 8);
    const offset = ico.readUInt32LE(e + 12);
    // A middle-sized entry: big enough to be unique, small enough to be
    // stored verbatim rather than re-encoded.
    if (size > 2000 && size < 20000) { best = { offset, size }; break; }
  }
  if (!best) return false;
  // Skip the DIB header, which is not unique, and take a chunk of pixels.
  const needle = ico.subarray(best.offset + 64, best.offset + 64 + 256);
  const exe = fs.readFileSync(exePath);
  return exe.indexOf(needle) !== -1;
}

async function main() {
  // Never run in CI. This exists purely so `npm start` shows the right
  // taskbar icon during development; a packaged build gets its icon from
  // electron-builder instead. Renaming Electron's binary underneath a
  // build server is asking for trouble for no benefit.
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    log('CI detected — skipping (packaged builds get their icon from electron-builder).');
    return;
  }
  if (process.platform !== 'win32') {
    log('not Windows — nothing to patch (macOS/Linux take the icon from the packaged app).');
    return;
  }
  log(`branding Electron in ${DIST}`);
  if (!fs.existsSync(DIST)) {
    log('electron isn\'t installed yet, skipping.');
    return;
  }
  if (!fs.existsSync(ICON_ICO)) {
    log(`no icon at ${ICON_ICO}, skipping.`);
    return;
  }

  const targetName = `${APP_NAME}.exe`;
  const targetPath = path.join(DIST, targetName);
  const originalPath = path.join(DIST, 'electron.exe');

  if (!fs.existsSync(originalPath) && !fs.existsSync(targetPath)) {
    log('couldn\'t find the Electron executable, skipping.');
    return;
  }


  // rcedit.exe is committed to tools/ rather than pulled from npm. Depending
  // on a devDependency meant that unzipping a new build over an existing
  // node_modules and running `npm start` found no rcedit and silently
  // skipped — which is why the atom logo kept surviving.
  const RCEDIT = path.join(ROOT, 'tools', 'rcedit-x64.exe');
  if (!fs.existsSync(RCEDIT)) {
    log(`rcedit.exe is missing from ${RCEDIT} — cannot patch the icon.`);
    return;
  }

  // Already done? Patching is quick but not free, and this runs every start.
  const stamp = path.join(DIST, '.nebula-branded');
  // Key the stamp on the icon's CONTENT, not its timestamp — unzipping
  // preserves mtimes unreliably across tools, and a mismatched stamp either
  // re-patches needlessly or, worse, skips when it shouldn't.
  const iconMtime = require('crypto')
    .createHash('sha1').update(fs.readFileSync(ICON_ICO)).digest('hex');
  if (fs.existsSync(stamp) && fs.existsSync(targetPath)) {
    try {
      if (fs.readFileSync(stamp, 'utf8').trim() === iconMtime) {
        // Confirm the claim instead of taking the stamp's word for it.
        const ok = iconBytesPresent(targetPath, ICON_ICO);
        log(`already branded — ${targetName}, icon embedded: ${ok ? 'VERIFIED' : 'NOT FOUND'}`);
        if (ok) return;
        log('stamp says branded but the icon is missing — re-patching.');
      }
    } catch { /* re-brand */ }
  }


  // Copy, patch the copy, and only then move it into place.
  //
  // Order matters more than it looks. Previously the copy was created at
  // NebulaClient.exe and patched afterwards — which meant Windows saw that
  // path for the first time while it still carried Electron's atom icon,
  // cached it, and then never noticed the patch. Explorer's icon cache is
  // keyed on the path, so the fix is for the final path to never exist in
  // an unbranded state. Patch a .tmp, then rename over the top.
  //
  // The original electron.exe is left alone throughout, so this is safe to
  // run while the app is open; the new copy is picked up on next launch.
  // Earlier builds of this script RENAMED electron.exe, so an install that
  // has been upgraded in place may have no electron.exe left — fall back to
  // the branded copy as the source in that case.
  const sourceExe = fs.existsSync(originalPath) ? originalPath : targetPath;
  const tmpPath = `${targetPath}.tmp`;
  try {
    fs.rmSync(tmpPath, { force: true });
    fs.copyFileSync(sourceExe, tmpPath);
  } catch (err) {
    log(`couldn't copy ${path.basename(sourceExe)}: ${err.message}`);
    return;
  }
  const exeToPatch = tmpPath;

  log(`patching ${path.basename(exeToPatch)}…`);
  // Files extracted from a zip downloaded off the internet carry a
  // Mark-of-the-Web zone identifier, and Windows may refuse to execute
  // them. Strip it if present — this is our own bundled tool.
  try {
    const zone = `${RCEDIT}:Zone.Identifier`;
    if (fs.existsSync(zone)) fs.rmSync(zone, { force: true });
  } catch { /* not present, or not NTFS */ }

  const res = spawnSync(RCEDIT, [
    exeToPatch,
    '--set-icon', ICON_ICO,
    '--set-version-string', 'CompanyName', APP_NAME,
    '--set-version-string', 'FileDescription', APP_NAME,
    '--set-version-string', 'ProductName', APP_NAME,
    '--set-version-string', 'InternalName', APP_NAME,
    '--set-version-string', 'OriginalFilename', targetName,
    '--set-version-string', 'LegalCopyright', APP_NAME,
  ], { windowsHide: true, encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    const why = res.error ? res.error.message : ((res.stderr || '').trim() || `exit code ${res.status}`);
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
    log(`couldn't patch the executable: ${why}`);
    log('The app still runs; only the taskbar icon is affected.');
    log('If Windows is blocking the bundled tool, run this once in PowerShell:');
    log(`  Unblock-File "${RCEDIT}"`);
    log('Or build instead: npm run pack');
    return;
  }

  // Move the freshly-patched binary into place.
  try {
    fs.rmSync(targetPath, { force: true });
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    log(`couldn't replace ${targetName}: ${err.message}`);
    log('It is probably still running — close the launcher and try again.');
    return;
  }

  // Point the Electron CLI at the branded copy.
  fs.writeFileSync(PATH_TXT, targetName);

  // Flush Explorer's icon cache. Without this Windows can keep showing a
  // previously-cached icon for the taskbar and jump list even though the
  // executable on disk has the right one.
  // -ClearIconCache empties the store, -show forces a rebuild. Both are
  // stock Windows utilities and safe to call.
  for (const flag of ['-ClearIconCache', '-show']) {
    try { spawnSync('ie4uinit.exe', [flag], { windowsHide: true, timeout: 8000 }); } catch { /* best effort */ }
  }
  try { fs.writeFileSync(path.join(DIST, '.nebula-branded'), iconMtime); } catch { /* stamp optional */ }
  // Verify rather than trust. rcedit exits 0 on plenty of paths where the
  // resource did not actually change, and "it said it worked" has already
  // cost several rounds here. Pull a distinctive run of bytes out of one of
  // the icon's own bitmaps and confirm it is physically present inside the
  // patched executable.
  try {
    const verified = iconBytesPresent(targetPath, ICON_ICO);
    const size = fs.statSync(targetPath).size;
    log(`done — ${targetName} (${(size / 1048576).toFixed(1)} MB), icon embedded: ${verified ? 'VERIFIED' : 'NOT FOUND'}`);
    if (!verified) {
      log('rcedit reported success but the icon is not in the binary.');
      log('Use `npm run pack` instead — electron-builder does this a different way.');
    }
  } catch { log(`done — ${targetName} patched.`); }
  log('If it is already open, close it and start again to see the change.');
  log('If Windows still shows the old icon, it is the shell icon cache:');
  log('  ie4uinit.exe -show    (or just sign out and back in)');
}

main().catch((err) => {
  // Never fail an install over cosmetics.
  log(`skipped: ${err.message}`);
});
