'use strict';
/**
 * SolarClient launcher updates — VPS-mediated (not GitHub Latest polling).
 *
 * Manifest:  GET  {UPDATE_BASE}/update/manifest
 * Download:  GET  {UPDATE_BASE}/update/download/{stable|beta}
 *
 * Channels:
 *   beta      — optional; top-bar Update chip only until opened
 *   optional  — stable optional; chip + panel (Update / Not now)
 *   mandatory — full lock until installed
 *
 * After installing a beta build, local channel is "beta" and the Beta chip
 * offers switching back to the newest stable.
 */
const { app, ipcMain } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { apiBase } = require('./endpoints');

const CHECK_INTERVAL_MS = 2 * 60 * 1000;
const USER_AGENT = 'SolarClient-Updater/2';
const IS_LINUX = process.platform === 'linux';
const LINUX_EXT = { appimage: '.AppImage', deb: '.deb', rpm: '.rpm' };

let linuxKindCache;
/** How this Linux copy was installed: 'appimage' | 'deb' | 'rpm' | null (unpacked/dev). */
function linuxPackageKind() {
  if (linuxKindCache !== undefined) return linuxKindCache;
  let kind = null;
  if (process.env.APPIMAGE) {
    kind = 'appimage';
  } else {
    const owns = (cmd, args) => {
      try { return spawnSync(cmd, args, { stdio: 'ignore', timeout: 8000 }).status === 0; } catch { return false; }
    };
    if (owns('dpkg', ['-S', process.execPath])) kind = 'deb';
    else if (owns('rpm', ['-qf', process.execPath])) kind = 'rpm';
  }
  linuxKindCache = kind;
  return kind;
}

function installerExt() {
  if (!IS_LINUX) return '.exe';
  return LINUX_EXT[linuxPackageKind()] || null;
}

function channelFile() {
  return path.join(app.getPath('userData'), 'update-channel.json');
}

/** The running build's version. An unpackaged dev run reports Electron's own version. */
function localVersion() {
  if (app.isPackaged) return app.getVersion();
  try { return require('../../package.json').version || app.getVersion(); } catch { return app.getVersion(); }
}

/** A -beta.N build is on the beta line however it got installed (site download, setup exe, updater). */
function localChannel() {
  return /-beta\.\d+$/.test(localVersion()) ? 'beta' : 'stable';
}

function loadChannelMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(channelFile(), 'utf8'));
    return {
      channel: j.channel === 'beta' ? 'beta' : 'stable',
      dismissed: typeof j.dismissed === 'string' ? j.dismissed : null,
    };
  } catch {
    return { channel: 'stable', dismissed: null };
  }
}

function saveChannelMeta(meta) {
  try {
    fs.writeFileSync(channelFile(), JSON.stringify({
      channel: meta.channel === 'beta' ? 'beta' : 'stable',
      dismissed: meta.dismissed || null,
    }));
  } catch { /* ignore */ }
}

let channelMeta = { channel: 'stable', dismissed: null };

let updateState = {
  checking: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: 0,
  localVersion: null,
  localChannel: 'stable',
  available: null,       // preferred offer (stable first) — used for auto-popup
  stableOffer: null,     // newer stable if any
  betaOffer: null,       // newer beta if any
  stableLatest: null,    // newest stable on feed (for switch-to-stable)
  betaLatest: null,
  target: null,          // downloading / ready to install
  source: null,          // 'vps' | 'github'
  mandatoryLock: false,
  popupStable: false,    // renderer should auto-open modal for stable only
  dlBytes: 0,
  dlTotal: 0,
  dlSpeed: 0,            // bytes/sec (smoothed)
  dlEta: 0,              // seconds remaining
};

let updateExePath = null;
let expectedSha256 = null;
let mainWin = null;

function getUpdateState() {
  return {
    ...updateState,
    localVersion: updateState.localVersion || localVersion(),
    localChannel: localChannel(),
  };
}

function pushState() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('update:state', getUpdateState());
  }
}

let lastProgressSent = -1;
let lastProgressAt = 0;

function pushProgress(pct, { force = false } = {}) {
  const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  const now = Date.now();
  // Throttle: only send when % changes, or every 100ms, or forced/100%.
  // Unthrottled IPC was flooding the renderer so the bar looked stuck at 0%.
  if (!force && n < 100 && n === lastProgressSent && (now - lastProgressAt) < 100) return;
  if (!force && n < 100 && n === lastProgressSent) return;
  if (!force && n < 100 && (now - lastProgressAt) < 80 && n === updateState.progress) return;
  lastProgressSent = n;
  lastProgressAt = now;
  updateState.progress = n;
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('update:progress', n);
  }
}

function downloadFileSingle(urlStr, destPath, onProgress, expectedSize = 0, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      timeout: 600000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFileSingle(res.headers.location, destPath, onProgress, expectedSize, headers));
      }
      const ok = res.statusCode === 200 || res.statusCode === 206;
      if (!ok) {
        res.resume();
        return reject(new Error(`download HTTP ${res.statusCode}`));
      }
      const headerTotal = parseInt(res.headers['content-length'] || '0', 10);
      const total = headerTotal > 0 ? headerTotal : (Number(expectedSize) || 0);
      let got = 0;
      let lastAt = 0;
      const file = fs.createWriteStream(destPath, { highWaterMark: 1024 * 1024 });
      res.on('data', (chunk) => {
        got += chunk.length;
        try { req.setTimeout(600000); } catch { /* ok */ }
        if (onProgress) {
          const now = Date.now();
          if (now - lastAt < 120) return;
          lastAt = now;
          const pct = total > 0
            ? Math.min(99, Math.round((got / total) * 100))
            : Math.min(99, Math.round(got / (1024 * 1024)));
          onProgress(pct, got, total);
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          // Never claim 100% here — SHA check + install still remain.
          if (onProgress) onProgress(99, got, total || got);
          resolve({ bytes: got, total: total || got });
        });
      });
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

function httpHeadOrGetSize(urlStr) {
  return new Promise((resolve) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.request(urlStr, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT },
      timeout: 5000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpHeadOrGetSize(res.headers.location));
      }
      const len = parseInt(res.headers['content-length'] || '0', 10) || 0;
      const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
      res.resume();
      resolve({ url: urlStr, size: len, acceptRanges });
    });
    req.on('error', () => resolve({ url: urlStr, size: 0, acceptRanges: false }));
    req.on('timeout', () => { req.destroy(); resolve({ url: urlStr, size: 0, acceptRanges: false }); });
    req.setTimeout(5000);
    req.end();
  });
}

function downloadRange(urlStr, start, end, partPath, onBytes) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, {
      headers: {
        'User-Agent': USER_AGENT,
        Range: `bytes=${start}-${end}`,
      },
      timeout: 600000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadRange(res.headers.location, start, end, partPath, onBytes));
      }
      if (res.statusCode !== 206 && res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`range HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(partPath, { highWaterMark: 1024 * 1024 });
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (onBytes) onBytes(c.length);
        try { req.setTimeout(600000); } catch { /* ok */ }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(got)));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('range timeout')); });
  });
}

/** Fast Setup download: 6 parallel HTTPS range parts when the CDN supports it. */
async function downloadFile(urlStr, destPath, onProgress, expectedSize = 0) {
  const meta = await httpHeadOrGetSize(urlStr);
  const total = meta.size > 0 ? meta.size : (Number(expectedSize) || 0);
  const parts = 6;
  const minPart = 2 * 1024 * 1024; // only parallelize if each slice is meaningful

  if (!meta.acceptRanges || total < parts * minPart) {
    return downloadFileSingle(meta.url || urlStr, destPath, onProgress, total || expectedSize);
  }

  const chunk = Math.ceil(total / parts);
  const partPaths = [];
  let downloaded = 0;
  let lastAt = 0;
  const bump = (n) => {
    downloaded += n;
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastAt < 120) return;
    lastAt = now;
    onProgress(Math.min(99, Math.round((downloaded / total) * 100)), downloaded, total);
  };

  try {
    const jobs = [];
    for (let i = 0; i < parts; i++) {
      const start = i * chunk;
      if (start >= total) break;
      const end = Math.min(total - 1, start + chunk - 1);
      const partPath = `${destPath}.part${i}`;
      partPaths.push(partPath);
      try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* ok */ }
      jobs.push(
        downloadRange(meta.url || urlStr, start, end, partPath, bump)
      );
    }
    await Promise.all(jobs);

    // Assemble parts into the final Setup.exe
    try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch { /* ok */ }
    const fd = fs.openSync(destPath, 'w');
    try {
      for (const p of partPaths) {
        const buf = fs.readFileSync(p);
        fs.writeSync(fd, buf);
      }
    } finally {
      fs.closeSync(fd);
    }
    for (const p of partPaths) {
      try { fs.unlinkSync(p); } catch { /* ok */ }
    }
    if (onProgress) onProgress(99, total, total);
    return { bytes: total, total };
  } catch (err) {
    for (const p of partPaths) {
      try { fs.unlinkSync(p); } catch { /* ok */ }
    }
    // Fall back to single-stream download
    return downloadFileSingle(meta.url || urlStr, destPath, onProgress, total || expectedSize);
  }
}

function parseVer(v) {
  const raw = String(v || '').replace(/^v/i, '');
  const [core, pre] = raw.split('-');
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  // beta.N → treat as pre-release rank under the same core
  let preRank = 0;
  if (pre) {
    const m = pre.match(/(\d+)/);
    preRank = m ? parseInt(m[1], 10) : 1;
  } else {
    preRank = 100000; // stable sorts above any beta of same core
  }
  return { nums, preRank, hasPre: Boolean(pre) };
}

/** true if remote is newer than local (semver-ish, beta < stable of same core). */
function isNewerVersion(remote, local) {
  const a = parseVer(remote);
  const b = parseVer(local);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] > b.nums[i]) return true;
    if (a.nums[i] < b.nums[i]) return false;
  }
  return a.preRank > b.preRank;
}

function httpGetJson(urlStr) {
  return new Promise((resolve, reject) => {
    const lib = urlStr.startsWith('https') ? https : http;
    const req = lib.get(urlStr, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGetJson(res.headers.location));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`manifest HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('manifest timeout')); });
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function githubSetupUrl(version) {
  const v = String(version || '').replace(/^v/i, '');
  if (!v) return null;
  return `https://github.com/sharktoothgaming56-maker/solarclientsite/releases/download/v${v}/SolarClient-Setup-${v}.exe`;
}

function githubAssetUrl(version, name) {
  return `https://github.com/sharktoothgaming56-maker/solarclientsite/releases/download/v${version}/${encodeURIComponent(name)}`;
}

function normalizeEntry(entry, channel, base) {
  if (!entry || !entry.version) return null;
  const version = String(entry.version).replace(/^v/i, '');
  if (IS_LINUX) {
    const kind = linuxPackageKind();
    const file = kind && entry.linux && entry.linux[kind];
    if (!file || !file.name) return null;
    return {
      version,
      channel: channel === 'beta' ? 'beta' : 'stable',
      policy: entry.policy === 'mandatory' ? 'mandatory' : 'optional',
      notes: entry.notes || '',
      sha256: String(file.sha256 || '').toLowerCase(),
      size: Number(file.size) || 0,
      url: githubAssetUrl(version, file.name),
      kind,
    };
  }
  const gh = githubSetupUrl(version);
  // Prefer GitHub CDN for the actual bytes (fast + HTTPS). VPS URL only as fallback.
  let url = null;
  if (entry.url && /^https:\/\/github\.com\//i.test(entry.url)) {
    url = entry.url;
  } else if (gh) {
    url = gh;
  } else if (entry.url) {
    url = entry.url.startsWith('http') ? entry.url : `${base}${entry.url}`;
  } else {
    url = `${base}/update/download/${channel === 'beta' ? 'beta' : 'stable'}`;
  }
  return {
    version,
    channel: channel === 'beta' ? 'beta' : 'stable',
    policy: entry.policy === 'mandatory' ? 'mandatory' : 'optional',
    notes: entry.notes || '',
    sha256: (entry.sha256 || '').toLowerCase(),
    size: Number(entry.size) || 0,
    url,
  };
}

function pickGithubSetupAsset(assets) {
  if (!Array.isArray(assets)) return null;
  if (IS_LINUX) {
    const ext = installerExt();
    if (!ext) return null;
    return assets.find((a) => String(a.name || '').toLowerCase().endsWith(ext.toLowerCase())) || null;
  }
  const setup = assets.find((a) => /Setup-.*\.exe$/i.test(a.name) || /Setup\.exe$/i.test(a.name));
  if (setup) return setup;
  return assets.find((a) => /\.exe$/i.test(a.name) && !/portable/i.test(a.name) && (a.size || 0) < 250 * 1024 * 1024) || null;
}

async function fetchGithubStableFallback() {
  const release = await httpGetJson(
    'https://api.github.com/repos/sharktoothgaming56-maker/solarclientsite/releases/latest'
  );
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const asset = pickGithubSetupAsset(release.assets);
  if (!version || !asset?.browser_download_url) return null;
  return normalizeEntry({
    version,
    policy: 'optional',
    notes: 'From GitHub Latest (VPS feed unavailable).',
    sha256: '',
    size: asset.size || 0,
    url: asset.browser_download_url,
    linux: IS_LINUX ? { [linuxPackageKind()]: { name: asset.name, size: asset.size || 0 } } : undefined,
  }, 'stable');
}

async function loadManifestFeeds() {
  // Prefer VPS; fall back to GitHub Latest for stable so updates never hard-depend on SSH deploy.
  try {
    const base = await apiBase();
    const manifest = await httpGetJson(`${base}/update/manifest`);
    return {
      source: 'vps',
      stable: normalizeEntry(manifest.stable, 'stable', base),
      beta: normalizeEntry(manifest.beta, 'beta', base),
    };
  } catch {
    const stable = await fetchGithubStableFallback();
    return { source: 'github', stable, beta: null };
  }
}

async function checkForUpdates({ force = false } = {}) {
  // Force (user clicked Check) clears a stuck "downloaded" lock so a failed
  // install can be retried. Never interrupt an in-flight download.
  if (updateState.downloading) {
    pushState();
    return getUpdateState();
  }
  if (updateState.downloaded && !force) {
    pushState();
    return getUpdateState();
  }
  if (force && updateState.downloaded && !updateState.installing) {
    updateState.downloaded = false;
    updateState.target = null;
    updateExePath = null;
  }

  updateState.checking = true;
  updateState.error = null;
  updateState.localVersion = localVersion();
  updateState.popupStable = false;
  pushState();

  try {
    const feeds = await loadManifestFeeds();
    const stable = feeds.stable;
    const beta = feeds.beta;
    updateState.source = feeds.source;
    updateState.stableLatest = stable;
    updateState.betaLatest = beta;

    const local = localVersion();
    const stableOffer = (stable && isNewerVersion(stable.version, local)) ? stable : null;
    const betaOffer = (beta && isNewerVersion(beta.version, local)) ? beta : null;

    updateState.stableOffer = stableOffer;
    updateState.betaOffer = betaOffer;

    // Channel isolation: a beta-channel user follows the beta line and is NOT
    // force-pulled onto a mandatory stable, as long as a current beta build
    // exists for them. Beta sits one patch ahead of stable, so when beta is
    // current there is no newer stable to pull them back. Only if beta has
    // fallen behind (no betaOffer) does a mandatory stable apply to them.
    const followBeta = localChannel() === 'beta' && Boolean(betaOffer);

    // Preferred "available" for download default.
    updateState.available = followBeta ? betaOffer : (stableOffer || betaOffer || null);
    updateState.mandatoryLock = Boolean(!followBeta && stableOffer && stableOffer.policy === 'mandatory');

    // Auto-popup ONLY for stable updates (never for beta-only, never for beta users).
    if (!followBeta && stableOffer) {
      const dismissed = channelMeta.dismissed === `stable:${stableOffer.version}`;
      updateState.popupStable = stableOffer.policy === 'mandatory' || !dismissed;
    }

    updateState.checking = false;

    if (!followBeta && stableOffer && stableOffer.policy === 'mandatory' && !updateState.downloaded) {
      pushState();
      await startDownload(stableOffer);
      return getUpdateState();
    }

    pushState();
    return getUpdateState();
  } catch (err) {
    updateState.checking = false;
    updateState.error = err.message || String(err);
    pushState();
    return getUpdateState();
  }
}

/** PID parent map — PowerShell only (WMIC removed on modern Windows). */
function getPidParentMap() {
  const { execSync } = require('child_process');
  const map = new Map();
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'SolarClient.exe\' OR Name=\'NebulaClient.exe\'\\" | ForEach-Object { Write-Output ($_.ProcessId.ToString() + \',\' + $_.ParentProcessId.ToString()) }"',
      { encoding: 'utf8', windowsHide: true, timeout: 8000 }
    );
    for (const line of out.split(/\r?\n/)) {
      const m = String(line).trim().match(/^(\d+),(\d+)$/);
      if (m) map.set(Number(m[1]), Number(m[2]));
    }
  } catch { /* empty */ }
  return map;
}

/** Self + every Electron child (GPU/renderer/utility). Killing these = black screen. */
function getOwnProcessTreePids() {
  const self = process.pid;
  const protectedPids = new Set([self]);
  const map = getPidParentMap();
  const kids = new Map();
  for (const [pid, ppid] of map) {
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const stack = [self];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of (kids.get(cur) || [])) {
      if (!protectedPids.has(c)) {
        protectedPids.add(c);
        stack.push(c);
      }
    }
  }
  return protectedPids;
}

/**
 * During download: only clear hung Setup / Update stubs.
 * Never touch SolarClient.exe — Electron uses several of those for one window;
 * killing them blacks out the UI and crashes the app.
 */
function killHungSetupProcessesOnly() {
  if (process.platform !== 'win32') return Promise.resolve();
  const { execSync } = require('child_process');
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true, timeout: 6000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m) continue;
      const name = m[1];
      const pid = Number(m[2]);
      if (!pid) continue;
      if (
        /^SolarClient-Setup-/i.test(name) ||
        /^SolarClient-Update\.exe$/i.test(name) ||
        /^Uninstall SolarClient\.exe$/i.test(name)
      ) {
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 3000 }); }
        catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  return Promise.resolve();
}

/** Kill OTHER SolarClient instances only (not our Electron tree). Startup / install mop-up. */
function killOtherSolarProcessesHard() {
  if (process.platform !== 'win32') return Promise.resolve();
  const { exec, execSync } = require('child_process');
  const protectedPids = getOwnProcessTreePids();
  try {
    const out = execSync('tasklist /FO CSV /NH', { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (!m) continue;
      const name = m[1];
      const pid = Number(m[2]);
      if (!pid || protectedPids.has(pid)) continue;
      if (
        /^SolarClient\.exe$/i.test(name) ||
        /^Solar Client\.exe$/i.test(name) ||
        /^NebulaClient\.exe$/i.test(name) ||
        /^SolarClient-Setup-/i.test(name) ||
        /^Uninstall SolarClient\.exe$/i.test(name)
      ) {
        // No /T — never cascade into unrelated trees; kill leaf PIDs only.
        try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 4000 }); }
        catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  exec('cmd /c for /f "tokens=2 delims=," %p in (\'tasklist /fo csv /nh ^| findstr /i SolarClient-Setup\') do taskkill /F /PID %p /T >nul 2>&1', { windowsHide: true });
  return Promise.resolve();
}

async function startDownload(entry) {
  if (!entry || updateState.downloading) return getUpdateState();

  const url = String(entry.url || '');
  const ext = installerExt();
  if (!ext) {
    updateState.error = 'This copy of SolarClient was not installed from a package, so it cannot update itself.';
    pushState();
    return getUpdateState();
  }
  const urlFile = decodeURIComponent(url.split(/[?#]/)[0]).toLowerCase();
  if (!urlFile.endsWith(ext.toLowerCase()) && !(!IS_LINUX && /\/update\/download\//i.test(url))) {
    updateState.error = IS_LINUX ? 'Update feed did not provide a Linux package.' : 'Update feed did not provide a Setup .exe.';
    pushState();
    return getUpdateState();
  }

  // Mark downloading + push 0% FIRST so the UI never looks frozen.
  updateState.downloading = true;
  updateState.downloaded = false;
  updateState.installing = false;
  updateState.error = null;
  updateState.target = { ...entry, url };
  updateState.progress = 0;
  expectedSha256 = entry.sha256 || null;
  const safeVer = String(entry.version || 'update').replace(/[^\w.\-]+/g, '_');
  updateExePath = path.join(app.getPath('temp'), IS_LINUX ? `SolarClient-Update-${safeVer}${ext}` : `SolarClient-Setup-${safeVer}.exe`);
  lastProgressSent = -1;
  lastProgressAt = 0;
  pushState();
  pushProgress(0, { force: true });

  // Yield so the renderer can paint the progress bar before we download.
  await new Promise((r) => setImmediate(r));

  // Only clear hung Setup stubs — never SolarClient.exe (that kills GPU/renderer → black screen).
  try { await killHungSetupProcessesOnly(); } catch { /* ok */ }
  pushProgress(1, { force: true });
  pushState();
  await new Promise((r) => setImmediate(r));

  try {
    cleanTempUpdateExes(updateExePath);
    try { if (fs.existsSync(updateExePath)) fs.unlinkSync(updateExePath); } catch { /* ok */ }

    const knownSize = Number(entry.size) || 0;
    let lastStatePush = 0;
    let sampleAt = Date.now();
    let sampleBytes = 0;
    updateState.dlBytes = 0;
    updateState.dlTotal = knownSize;
    updateState.dlSpeed = 0;
    updateState.dlEta = 0;
    await downloadFile(url, updateExePath, (pct, got, total) => {
      // Map 1–100 onto visible bar (1 was "killing tasks")
      const shown = Math.max(1, pct);
      pushProgress(shown);
      const now = Date.now();
      if (Number.isFinite(got)) {
        updateState.dlBytes = got;
        if (total > 0) updateState.dlTotal = total;
        const dt = (now - sampleAt) / 1000;
        if (dt >= 0.4) {
          const inst = Math.max(0, (got - sampleBytes) / dt);
          updateState.dlSpeed = updateState.dlSpeed > 0 ? updateState.dlSpeed * 0.6 + inst * 0.4 : inst;
          sampleAt = now;
          sampleBytes = got;
        }
        const left = Math.max(0, (updateState.dlTotal || 0) - got);
        updateState.dlEta = updateState.dlSpeed > 0 ? Math.ceil(left / updateState.dlSpeed) : 0;
      }
      if (pct >= 99 || now - lastStatePush > 250) {
        lastStatePush = now;
        pushState();
      }
    }, knownSize);

    const st = fs.statSync(updateExePath);
    if (st.size < 1024 * 1024) throw new Error('Downloaded update is too small — try again.');
    if (!updateExePath.toLowerCase().endsWith(ext.toLowerCase())) {
      throw new Error(IS_LINUX ? 'Downloaded file is not a Linux package.' : 'Downloaded file is not a Setup .exe.');
    }

    if (expectedSha256) {
      const got = await sha256File(updateExePath);
      if (got !== expectedSha256) {
        try { fs.unlinkSync(updateExePath); } catch { /* ok */ }
        throw new Error('Update failed integrity check (SHA-256 mismatch).');
      }
    }

    updateState.downloading = false;
    updateState.downloaded = true;
    updateState.installing = true;
    // Download finished; install still pending — keep bar under 100.
    updateState.progress = 92;
    pushProgress(92, { force: true });
    pushState();

    // Auto-continue after download: kill old copies, wipe old versions, run EXE, relaunch.
    setTimeout(() => {
      try {
        updateState.progress = 96;
        pushProgress(96, { force: true });
        pushState();
        runInstallAndRelaunch();
      } catch (e) {
        updateState.error = e.message || String(e);
        updateState.installing = false;
        pushState();
      }
    }, 700);
  } catch (err) {
    updateState.downloading = false;
    updateState.downloaded = false;
    updateState.error = err.message || String(err);
    pushState();
  }
  return getUpdateState();
}

function cleanTempUpdateExes(keepPath) {
  const dir = app.getPath('temp');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!/^SolarClient-(Setup|Update)-.*\.(exe|AppImage|deb|rpm)$/i.test(name)) continue;
    const full = path.join(dir, name);
    if (keepPath && path.resolve(full) === path.resolve(keepPath)) continue;
    try { fs.unlinkSync(full); } catch { /* locked */ }
  }
}

function resolveLaunchExe() {
  const local = process.env.LOCALAPPDATA || '';
  // Prefer the currently running packaged exe when it lives under Programs —
  // that is the folder the helper must wipe and replace in place.
  try {
    const running = process.execPath;
    if (
      running &&
      /\.exe$/i.test(running) &&
      /[\\/]Programs[\\/]/i.test(running) &&
      /SolarClient\.exe$/i.test(running) &&
      fs.existsSync(running)
    ) {
      return running;
    }
  } catch { /* fall through */ }
  const candidates = [
    path.join(local, 'Programs', 'SolarClient', 'SolarClient.exe'),
    path.join(local, 'Programs', 'solarclient', 'SolarClient.exe'),
    path.join(local, 'SolarClient', 'SolarClient.exe'),
    process.execPath,
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* next */ }
  }
  return path.join(local, 'Programs', 'SolarClient', 'SolarClient.exe');
}

function helperScriptSourcePath(names = ['solar-update-helper.ps1', 'solar-update-helper.cmd']) {
  const bases = [
    path.join(__dirname, '..', '..', 'scripts'),
    path.join(app.getAppPath(), 'scripts'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'scripts'),
  ];
  for (const name of names) {
    for (const base of bases) {
      const c = path.join(base, name);
      try { if (c && fs.existsSync(c)) return c; } catch { /* next */ }
    }
  }
  return null;
}

function quitApp() {
  try {
    app.removeAllListeners('window-all-closed');
    app.removeAllListeners('before-quit');
    app.removeAllListeners('will-quit');
  } catch { /* ok */ }
  try { app.exit(0); } catch { process.exit(0); }
}

/** Start `target` a moment after we exit (the single-instance lock would refuse it while we run). */
function relaunchLinux(target) {
  const env = { ...process.env };
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD']) delete env[k];
  const p = spawn('/bin/sh', ['-c', 'sleep 2; exec "$0" >/dev/null 2>&1', target], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  p.on('error', () => {});
  try { p.unref(); } catch { /* ok */ }
}

function failLinuxInstall(message) {
  updateState.error = message;
  updateState.installing = false;
  updateState.downloaded = true;
  pushState();
  return false;
}

/**
 * AppImage: swap the file in place (rename over a running AppImage is safe on Linux).
 * deb/rpm: install through pkexec (graphical password prompt). If that is unavailable
 * or refused, hand the package to the desktop's software installer instead.
 */
function runLinuxInstall() {
  const kind = linuxPackageKind();
  const file = updateExePath;
  if (!file || !fs.existsSync(file) || !kind) {
    updateState.downloaded = false;
    return failLinuxInstall('The downloaded update could not be found. Please download it again.');
  }
  if (updateState.target) {
    channelMeta.channel = updateState.target.channel === 'beta' ? 'beta' : 'stable';
    channelMeta.dismissed = null;
    saveChannelMeta(channelMeta);
  }
  updateState.installing = true;
  pushState();

  if (kind === 'appimage') {
    const target = process.env.APPIMAGE;
    const staged = `${target}.update`;
    try {
      fs.copyFileSync(file, staged);
      fs.chmodSync(staged, 0o755);
      fs.renameSync(staged, target);
    } catch (e) {
      try { fs.unlinkSync(staged); } catch { /* ok */ }
      return failLinuxInstall(`Could not replace the AppImage (${e.code || e.message}). Download the new version from the website.`);
    }
    try { fs.unlinkSync(file); } catch { /* ok */ }
    pushProgress(100, { force: true });
    relaunchLinux(target);
    setTimeout(quitApp, 300);
    return true;
  }

  const openInSoftwareCenter = () => {
    try {
      const p = spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
      p.on('error', () => {});
      p.unref();
    } catch { /* ok */ }
    failLinuxInstall('Finish installing the update in the window that opened, then reopen SolarClient.');
  };

  const cmd = kind === 'deb'
    ? ['dpkg', '-i', file]
    : ['rpm', '-U', '--oldpackage', '--replacepkgs', '--replacefiles', file];
  let proc;
  try {
    proc = spawn('pkexec', cmd, { stdio: 'ignore' });
  } catch {
    openInSoftwareCenter();
    return false;
  }
  proc.on('error', openInSoftwareCenter);
  proc.on('exit', (code) => {
    if (code === 0) {
      try { fs.unlinkSync(file); } catch { /* ok */ }
      pushProgress(100, { force: true });
      relaunchLinux(process.execPath);
      setTimeout(quitApp, 300);
      return;
    }
    if (code === 126) {
      failLinuxInstall('Update cancelled. Click Update to try again.');
      return;
    }
    openInSoftwareCenter();
  });
  return true;
}

function runInstallAndRelaunch() {
  if (IS_LINUX) return runLinuxInstall();
  let downloadedSize = 0;
  try { downloadedSize = updateExePath ? fs.statSync(updateExePath).size : 0; } catch { downloadedSize = 0; }

  if (!updateExePath || !updateExePath.toLowerCase().endsWith('.exe') || downloadedSize < 1024 * 1024) {
    updateState.error = 'The downloaded Setup .exe could not be found. Please download it again.';
    updateState.downloaded = false;
    pushState();
    return false;
  }

  if (updateState.target) {
    channelMeta.channel = updateState.target.channel === 'beta' ? 'beta' : 'stable';
    channelMeta.dismissed = null;
    saveChannelMeta(channelMeta);
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const tempDir = app.getPath('temp');
  const src = helperScriptSourcePath();
  if (!src) {
    updateState.error = 'Update helper script is missing from the app package.';
    updateState.installing = false;
    pushState();
    return false;
  }

  const helperPath = path.join(tempDir, 'solar-update-helper.ps1');
  const launchBat = path.join(tempDir, 'solar-update-run.cmd');
  const readyFlag = path.join(tempDir, 'solar-update-ready.flag');
  const launchExe = resolveLaunchExe();

  try {
    // Copy bytes as-is. Helper script must stay ASCII-only (Windows PS 5.x
    // mangled UTF-8 em-dashes into parse errors = black screen, no replace).
    fs.writeFileSync(helperPath, fs.readFileSync(src));
  } catch (e) {
    updateState.error = `Could not prepare updater script: ${e.message || e}`;
    updateState.installing = false;
    pushState();
    return false;
  }

  try { fs.unlinkSync(readyFlag); } catch { /* ok */ }

  // The progress window shown while the launcher is closed. Copied out of the
  // asar so PowerShell can read it; the icon makes it look like SolarClient.
  const windowPath = path.join(tempDir, 'solar-update-window.ps1');
  const iconPath = path.join(tempDir, 'solar-update-icon.ico');
  let windowArg = '';
  let iconArg = '';
  try {
    const winSrc = helperScriptSourcePath(['solar-update-window.ps1']);
    if (winSrc) { fs.writeFileSync(windowPath, fs.readFileSync(winSrc)); windowArg = windowPath; }
  } catch { /* helper falls back to its basic window */ }
  try {
    fs.writeFileSync(iconPath, fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'icon.ico')));
    iconArg = iconPath;
  } catch { /* window just has no logo */ }
  let centerX = 0;
  let centerY = 0;
  try {
    const { BrowserWindow, screen } = require('electron');
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized());
    if (win) {
      const b = win.getBounds();
      const pt = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
      centerX = Math.max(0, Math.round(pt.x));
      centerY = Math.max(0, Math.round(pt.y));
    }
  } catch { /* window centres on screen */ }

  const version = String(updateState.target?.version || '').replace(/[^\w.\-]/g, '');
  const q = (s) => `"${String(s || '').replace(/"/g, '')}"`;
  const helperArgs = `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${q(helperPath)} -Installer ${q(updateExePath)} -ParentPid ${process.pid} -PreferredLaunch ${q(launchExe)} -LocalAppData ${q(localAppData)} -Version ${q(version)} -WindowScript ${q(windowArg)} -IconPath ${q(iconArg)} -CenterX ${centerX} -CenterY ${centerY}`;

  updateState.installing = true;
  pushState();

  // Legacy route: cmd START gives the helper a console of its own, which shows
  // up as a PowerShell window. Only used if the hidden route below fails.
  const startLegacy = () => {
    const bat = [
      '@echo off',
      `echo started> ${q(readyFlag)}`,
      `start "SolarClientUpdater" /MIN powershell.exe ${helperArgs}`,
      'exit /b 0',
      '',
    ].join('\r\n');
    fs.writeFileSync(launchBat, bat, 'ascii');
    const p = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', launchBat], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    p.on('error', () => {});
    try { p.unref(); } catch { /* ok */ }
  };

  // A hidden PowerShell starts the helper with Start-Process (also hidden), so
  // no console window ever appears. Start-Process children break away from
  // Electron's child-process job, so the helper survives app.exit; the flag is
  // written only once it's running, and we don't quit before that.
  const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const boot = `Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList ${psq(helperArgs)} -ErrorAction Stop; Set-Content -LiteralPath ${psq(readyFlag)} -Value started`;
  let usedLegacy = false;
  const fallback = () => {
    if (usedLegacy) return;
    let ready = false;
    try { ready = fs.existsSync(readyFlag); } catch { /* ok */ }
    if (ready) return;
    usedLegacy = true;
    try { startLegacy(); } catch (e) {
      updateState.error = `Could not start updater: ${e.message || e}`;
      updateState.installing = false;
      updateState.downloaded = true;
      pushState();
    }
  };
  try {
    const bootProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', boot], {
      stdio: 'ignore',
      windowsHide: true,
    });
    bootProc.on('error', fallback);
    bootProc.on('exit', fallback);
  } catch {
    fallback();
  }

  // Quit after the helper is out of our process tree. No window.destroy (black screen).
  const quitClean = () => {
    try {
      app.removeAllListeners('window-all-closed');
      app.removeAllListeners('before-quit');
      app.removeAllListeners('will-quit');
    } catch { /* ok */ }
    try { app.exit(0); } catch { process.exit(0); }
  };

  // Quitting before the helper is running would kill it with us, so wait for
  // the flag. PowerShell can take several seconds to start on a cold machine.
  const started = Date.now();
  let legacyAt = 0;
  const waitReady = setInterval(() => {
    let ready = false;
    try { ready = fs.existsSync(readyFlag); } catch { /* ok */ }
    if (ready) {
      clearInterval(waitReady);
      quitClean();
      return;
    }
    if (!usedLegacy && Date.now() - started > 20000) fallback();
    if (usedLegacy && !legacyAt) legacyAt = Date.now();
    if (legacyAt && Date.now() - legacyAt > 3000) {
      clearInterval(waitReady);
      if (updateState.error) return;
      quitClean();
    }
  }, 100);

  return true;
}

function dismissOptional() {
  if (updateState.available && updateState.available.policy !== 'mandatory') {
    channelMeta.dismissed = `${updateState.available.channel}:${updateState.available.version}`;
    saveChannelMeta(channelMeta);
  }
  // Clear the popup flag so the renderer does not immediately reopen the modal.
  updateState.popupStable = false;
  pushState();
  return getUpdateState();
}

function downloadAvailable(which) {
  const key = String(which || 'auto');
  let entry = null;
  if (key === 'beta') entry = updateState.betaOffer || updateState.betaLatest;
  else if (key === 'stable') entry = updateState.stableOffer || updateState.stableLatest;
  else entry = updateState.stableOffer || updateState.available || updateState.betaOffer;
  if (!entry) return getUpdateState();
  // Do NOT await — invoke must return immediately so the progress bar can paint.
  startDownload(entry).catch((err) => {
    updateState.downloading = false;
    updateState.error = err?.message || String(err);
    pushState();
  });
  return getUpdateState();
}

// Every released beta, newest first. The VPS feed only keeps the newest one,
// so this reads the public GitHub releases list; each installer's SHA-256
// comes from GitHub's asset digest and is checked like any other download.
const BETA_LIST_TTL_MS = 10 * 60 * 1000;
const BETA_ASSET_URL = /^https:\/\/github\.com\/sharktoothgaming56-maker\/solarclientsite\/releases\/download\//;
let betaList = { at: 0, items: [] };

async function listBetas({ force = false } = {}) {
  if (IS_LINUX) return [];
  if (!force && betaList.items.length && Date.now() - betaList.at < BETA_LIST_TTL_MS) return betaList.items;
  const releases = await httpGetJson('https://api.github.com/repos/sharktoothgaming56-maker/solarclientsite/releases?per_page=100');
  const items = [];
  for (const r of Array.isArray(releases) ? releases : []) {
    const version = String(r.tag_name || '').replace(/^v/i, '');
    if (!r.prerelease || r.draft || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) continue;
    const asset = (r.assets || []).find((a) => a.name === `SolarClient-Setup-${version}.exe`);
    const sha = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest || ''));
    if (!asset || !sha || !BETA_ASSET_URL.test(String(asset.browser_download_url || ''))) continue;
    items.push({
      version,
      channel: 'beta',
      policy: 'optional',
      notes: String(r.body || '').slice(0, 4000),
      sha256: sha[1].toLowerCase(),
      size: Number(asset.size) || 0,
      url: asset.browser_download_url,
      publishedAt: r.published_at || null,
    });
  }
  items.sort((a, b) => (isNewerVersion(a.version, b.version) ? -1 : 1));
  betaList = { at: Date.now(), items };
  return items;
}

// The release's own words about what changed: the notes minus the boilerplate
// (beta banner, SHA-256, VirusTotal reminder) and markdown.
function betaSummary(notes) {
  return String(notes || '').split(/\r?\n\s*\r?\n/).map((p) => p.trim())
    .filter((p) => p && !/^(\*\*beta\*\*|sha-?256|submit the exe|virustotal)/i.test(p))
    .map((p) => p.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`#>]/g, '')
      .split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'))
    .join('\n\n').slice(0, 3000);
}

async function getBetaList(force) {
  try {
    const items = await listBetas({ force: Boolean(force) });
    return { ok: true, current: localVersion(), betas: items.map(({ version, size, publishedAt, notes }) => ({ version, size, publishedAt, summary: betaSummary(notes) })) };
  } catch (err) {
    const latest = updateState.betaLatest;
    return {
      ok: false,
      error: err?.message || String(err),
      current: localVersion(),
      betas: latest ? [{ version: latest.version, size: latest.size || 0, publishedAt: null }] : [],
    };
  }
}

async function installBeta(version) {
  const want = String(version || '').replace(/^v/i, '');
  let entry = betaList.items.find((b) => b.version === want);
  if (!entry) {
    try { entry = (await listBetas({ force: true })).find((b) => b.version === want); } catch { /* fall through */ }
  }
  if (!entry && updateState.betaLatest?.version === want) entry = updateState.betaLatest;
  if (!entry) {
    updateState.error = `Beta v${want} isn't available.`;
    pushState();
    return getUpdateState();
  }
  startDownload({ ...entry, channel: 'beta' }).catch((err) => {
    updateState.downloading = false;
    updateState.error = err?.message || String(err);
    pushState();
  });
  return getUpdateState();
}

async function switchToStable() {
  const stable = updateState.stableLatest;
  if (!stable) {
    await checkForUpdates({ force: true });
  }
  const target = updateState.stableLatest;
  if (!target) {
    updateState.error = 'No stable version is available right now.';
    pushState();
    return getUpdateState();
  }
  if (!isNewerVersion(target.version, localVersion()) && localChannel() !== 'beta') {
    updateState.error = 'You are already on the latest stable.';
    pushState();
    return getUpdateState();
  }
  startDownload({ ...target, channel: 'stable' }).catch((err) => {
    updateState.downloading = false;
    updateState.error = err?.message || String(err);
    pushState();
  });
  return getUpdateState();
}

function initAutoUpdate(mainWindow) {
  mainWin = mainWindow;
  channelMeta = loadChannelMeta();
  updateState.localVersion = localVersion();
  updateState.localChannel = localChannel();

  try { ipcMain.removeHandler('update:check'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:restart'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:download'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:dismiss'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:switchStable'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:getState'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:listBetas'); } catch { /* ok */ }
  try { ipcMain.removeHandler('update:installBeta'); } catch { /* ok */ }

  ipcMain.handle('update:getState', () => getUpdateState());
  ipcMain.handle('update:check', () => checkForUpdates({ force: true }));
  ipcMain.handle('update:download', (_e, which) => downloadAvailable(which));
  ipcMain.handle('update:dismiss', () => dismissOptional());
  ipcMain.handle('update:switchStable', () => switchToStable());
  ipcMain.handle('update:listBetas', (_e, force) => getBetaList(force));
  ipcMain.handle('update:installBeta', (_e, version) => installBeta(version));
  ipcMain.handle('update:restart', async () => runInstallAndRelaunch());

  setTimeout(() => checkForUpdates(), 4000);
  setInterval(() => checkForUpdates(), CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdate, getUpdateState };
