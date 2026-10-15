'use strict';
/**
 * Protected build: obfuscate the launcher source, run electron-builder over
 * the scrambled copy, then restore the readable source no matter what.
 *
 * Wired in as `npm run dist` so the existing publish pipeline
 * (publish-update.js -> npm run dist) ships protected builds automatically.
 * Dev (`npm start`) still runs the plain readable source.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { obfuscateFile } = require('./obfuscate');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const rel0 = (f) => path.relative(ROOT, f);

// Every shipped app JS file, skipping third-party vendor bundles (already
// minified, and re-obfuscating them only risks breakage for no gain).
function collect(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === 'vendor' || name === 'node_modules') continue;
      collect(p, out);
    } else if (name.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

(function main() {
  // Ship every app JS file scrambled + string-encrypted (RC4). Vendor
  // bundles under src/**/vendor are skipped by collect(). Dev still runs
  // the plain readable tree; only the packaged asar is protected.
  const files = collect(SRC);
  // An interrupted build leaves src obfuscated; building again would scramble
  // it twice and back up the scrambled copy as the "original".
  const scrambled = files.filter((f) => /^(?:const|var) _0x[0-9a-f]+=/.test(fs.readFileSync(f, 'utf8').slice(0, 200)));
  if (scrambled.length) {
    console.error(`[protect] REFUSING TO BUILD: src is already obfuscated (${scrambled.map(rel0).join(', ')}).`);
    console.error('[protect] Restore the readable source from the newest %TEMP%\\solar-src-backup-* folder first.');
    process.exit(1);
  }
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'solar-src-backup-'));
  const rel = (f) => path.relative(ROOT, f);

  for (const f of files) {
    const dest = path.join(backupRoot, rel(f));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f, dest);
  }

  // Beta builds ship the beta icon set; stable keeps build/icon.*.
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const icons = /-beta/i.test(version)
    ? ['icon.ico', 'icon.png'].filter((n) => fs.existsSync(path.join(ROOT, 'build', 'beta', n)))
    : [];
  for (const n of icons) {
    fs.copyFileSync(path.join(ROOT, 'build', n), path.join(backupRoot, `stable-${n}`));
    fs.copyFileSync(path.join(ROOT, 'build', 'beta', n), path.join(ROOT, 'build', n));
  }
  if (icons.length) console.log(`[protect] beta build: using build/beta icons (${icons.join(', ')})`);

  console.log(`[protect] obfuscating ${files.length} source files`);
  let code = 1;
  try {
    for (const f of files) {
      const target = /(?:^|[\\/])renderer[\\/]/.test(rel(f)) ? 'browser' : 'node';
      obfuscateFile(f, target);
    }
    const extra = process.argv.slice(2);
    const r = spawnSync('npm', ['run', 'dist:raw', ...(extra.length ? ['--', ...extra] : [])], { cwd: ROOT, stdio: 'inherit', shell: true });
    code = r.status == null ? 1 : r.status;
  } finally {
    for (const f of files) {
      const b = path.join(backupRoot, rel(f));
      if (fs.existsSync(b)) fs.copyFileSync(b, f);
    }
    for (const n of icons) fs.copyFileSync(path.join(backupRoot, `stable-${n}`), path.join(ROOT, 'build', n));
    fs.rmSync(backupRoot, { recursive: true, force: true });
    console.log('[protect] readable source restored');
  }
  if (code === 0) code = verifyUpdateHelper();
  process.exit(code);
})();

// A build without these files can never install its own next update
// (that is how 3.22.74 shipped), so refuse to hand it to the publisher.
function verifyUpdateHelper() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const linux = process.platform === 'linux';
  const args = process.argv.slice(2);
  const flag = '--config.directories.output';
  let override = null;
  args.forEach((a, i) => {
    if (a.startsWith(`${flag}=`)) override = a.slice(flag.length + 1);
    else if (a === flag && args[i + 1]) override = args[i + 1];
  });
  const outDir = path.resolve(ROOT, override || pkg.build.directories.output);
  const asarPath = path.join(outDir, linux ? 'linux-unpacked' : 'win-unpacked', 'resources', 'app.asar');
  const need = linux
    ? ['/src/main/autoUpdater.js', '/src/main/endpoints.js', '/build/icon.png']
    : ['solar-update-helper.ps1', 'solar-update-helper.cmd', 'solar-update-window.ps1'].map((n) => `/scripts/${n}`);
  try {
    const listed = new Set(require('@electron/asar').listPackage(asarPath).map((p) => p.replace(/\\/g, '/')));
    const missing = need.filter((n) => !listed.has(n));
    if (missing.length) {
      console.error(`[protect] BUILD REJECTED: app.asar is missing ${missing.join(', ')}`);
      return 1;
    }
    console.log('[protect] update helper present in app.asar');
    return 0;
  } catch (err) {
    console.error(`[protect] BUILD REJECTED: could not inspect ${asarPath}: ${err.message}`);
    return 1;
  }
}
