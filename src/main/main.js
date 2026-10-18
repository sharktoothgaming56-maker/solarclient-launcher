// TLS verification stays ON by default. Opt into insecure TLS only when
// debugging AV HTTPS inspection / broken corporate MITM (same reason the
// game JRE gets Windows-ROOT). Never leave this on for normal users.
if (process.env.SOLARCLIENT_INSECURE_TLS === '1') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
const { app, BrowserWindow, ipcMain, Menu, dialog, net, powerMonitor } = require('electron');

// Node's fetch trusts only its bundled CA list, so it fails outright on PCs
// whose antivirus or network inspects HTTPS. Chromium's stack uses the
// Windows certificate store and proxy settings, like the browser does.
function chromeFetch(url, opts) {
  return app.isReady() ? net.fetch(url, opts) : fetch(url, opts);
}
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline: streamPipeline } = require('stream/promises');
const { Readable } = require('stream');
const crypto = require('crypto');
const Store = require('electron-store');

// Cold-start timing — logged once at ready-to-show so we can measure wins.
const __bootT0 = Date.now();
function bootMark(label) {
  console.log(`[boot] +${Date.now() - __bootT0}ms ${label}`);
}
bootMark('main.js begin');

// =====================================================================
// LAZY DEPENDENCIES
//
// msmc, minecraft-launcher-core and minecraft-protocol were required at the
// top of this file, so every one of them -- and their whole transitive tree,
// which for minecraft-protocol alone is well over a hundred modules of
// prismarine-* protocol definitions -- was read from disk, parsed and
// compiled by V8 BEFORE the first BrowserWindow could even be constructed.
// The user paid that entire cost on every single cold start, staring at
// nothing, whether or not they were going to sign in or launch anything.
//
// None of the three is used at module scope. They are only ever touched
// inside a handler: msmc when you click "sign in", mclc when you press
// Launch, minecraft-protocol only if you use the AFK keep-alive. Requiring
// them at the point of first use moves all of that off the startup path,
// and Node's module cache means the second call through is free.
//
// The window appears while these are still unloaded; they load in the
// background at idle (see warmHeavyDeps below) so the first click does not
// pay for them either.
// =====================================================================
let _Auth = null, _Client = null, _mcProtocol = null;
const getAuth = () => (_Auth ||= require('msmc').Auth);
const getClient = () => (_Client ||= require('minecraft-launcher-core').Client);
const getMcProtocol = () => (_mcProtocol ||= require('minecraft-protocol'));
// autoUpdater / Discord / Bedrock are only touched after first paint or on
// user action — keep their requires off the cold-start critical path.
const getAutoUpdate = () => require('./autoUpdater');
const getDiscordPresence = () => require('./discordPresence').DiscordPresence;
const getBedrock = () => require('./bedrock');

// =====================================================================
// DATA MIGRATION — Electron derives the userData folder from the "name"
// field in package.json. Since we rebranded from "nebulaclient" to
// "solarclient", Electron would look in AppData/Roaming/solarclient
// (empty) instead of AppData/Roaming/nebulaclient (has all the user's
// accounts, playtime, settings, instances, etc.). Force it back to the
// original folder so nothing is lost.
// =====================================================================
const oldUserData = path.join(app.getPath('appData'), 'nebulaclient');
if (fs.existsSync(oldUserData)) {
  app.setPath('userData', oldUserData);
}
require('./windowsCerts').loadWindowsCerts(path.join(app.getPath('userData'), 'windows-roots.txt'));

const store = new Store();
let mainWindow;
let activeGameClient = null;

// =====================================================================
// APP IDENTITY — without these, Windows shows "Electron" in the taskbar
// jump list, the alt-tab label and every child window msmc opens. These
// have to run before app.whenReady(), which is why they're up here.
// =====================================================================
const APP_NAME = 'SolarClient';
app.setName(APP_NAME);
process.title = APP_NAME;

// =====================================================================
// SINGLE INSTANCE — exactly ONE SolarClient. Extra launches focus the
// existing window. Leftover zombies get force-killed once we hold the lock.
// =====================================================================
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another live instance owns the lock — do not start a second copy.
  app.quit();
  process.exit(0);
}

app.on('second-instance', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

/**
 * Clear hung Setup stubs only. Never taskkill SolarClient.exe here —
 * Electron uses several SolarClient.exe processes for one window; killing
 * siblings blacks the UI. Single-instance lock already blocks a second app.
 */
function killOtherSolarClients() {
  if (process.platform !== 'win32') return;
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
        /^SolarClient-Install-/i.test(name) ||
        /^Uninstall SolarClient\.exe$/i.test(name)
      ) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore', windowsHide: true, timeout: 3000 });
        } catch { /* ok */ }
      }
    }
  } catch (err) {
    console.warn('[SolarClient] could not clear leftover setup processes:', err.message);
  }
}

// Do NOT sync-kill at module load (freezes + AV-noisy). Handled after first frame.


// =====================================================================
// CHROMIUM SWITCHES
//
// These must be set before app.whenReady(); Chromium reads its command
// line once during startup and ignores anything appended afterwards.
//
// The launcher's UI is compositing-heavy (translucent panels, a canvas
// starfield, gradient backdrops), which is exactly the workload that
// benefits from pushing rasterisation onto the GPU instead of doing it on
// the CPU's raster threads and uploading the result every frame.
//
// Deliberately NOT set: --ignore-gpu-blocklist. Chromium's blocklist
// exists because those driver/GPU combinations genuinely corrupt or crash
// under acceleration; forcing past it trades a smooth window for a
// launcher that white-screens on the exact low-end machines that most need
// the help. SOLARCLIENT_NO_GPU_TWEAKS=1 escapes all of this if a specific
// machine turns out to hate it.
// =====================================================================
// GPU switches used to force rasterisation / zero-copy / 256MB tile budget.
// On several Windows machines (including Shark's) that makes the GPU process
// exit immediately → solid black frameless window. Keep Chromium defaults;
// set SOLARCLIENT_GPU_TWEAKS=1 only to opt back into the aggressive path.
if (process.env.SOLARCLIENT_GPU_TWEAKS === '1') {
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-features', 'CanvasOopRasterization');
  app.commandLine.appendSwitch('force-gpu-mem-available-mb', '256');
}
// Soft recovery: if the GPU process still dies, prefer software compositing
// on the next launch rather than a permanent black window.
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

// Calls and screen share: show received video as soon as it arrives. Chromium
// otherwise holds screen-share frames 150-400ms to smooth out their uneven sizes.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:60/');

// AppUserModelID, and why it is conditional.
if (process.platform === 'win32' && !process.defaultApp) {
  app.setAppUserModelId('com.solarclient.launcher');
}

// msmc builds its own login BrowserWindow and we don't get to pass options
// into it, so every window this process creates gets branded on the way
// out: correct icon, our title, and no "Electron" leaking through a page
// that decides to set its own document.title.
//
// LIMITATION, so nobody wastes time chasing it: none of this can change
// the WINDOWS TASKBAR ICON while the app is unpackaged. Running `electron .`
// means the running executable literally is electron.exe, and Windows takes
// the taskbar icon from the exe's own resources — no JS API reaches it.
// `npm run pack` builds SolarClient.exe with build/icon.ico compiled in,
// which is what actually replaces the atom logo.
// Windows only reliably honours a real multi-size .ico for window icons —
// handing it a 1024x1024 PNG is why the atom logo survived in the window
// menu and alt-tab. macOS and Linux want the PNG.
const APP_ICON = path.join(
  __dirname, '..', '..', 'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png',
);
// Loaded once as a nativeImage. Passing a path string works, but an
// explicitly decoded image is more reliable for the taskbar button, and it
// lets us log loudly if the file is missing or unreadable instead of
// failing invisibly.
let appIconImage = null;
function getAppIcon() {
  if (appIconImage !== null) return appIconImage || null;
  try {
    const { nativeImage } = require('electron');
    if (!fs.existsSync(APP_ICON)) {
      console.warn(`[SolarClient] app icon missing at ${APP_ICON}`);
      appIconImage = false;
      return null;
    }
    const img = nativeImage.createFromPath(APP_ICON);
    if (img.isEmpty()) {
      console.warn(`[SolarClient] app icon at ${APP_ICON} could not be decoded`);
      appIconImage = false;
      return null;
    }
    const { width, height } = img.getSize();
    console.log(`[SolarClient] window icon loaded: ${APP_ICON} (${width}x${height})`);
    appIconImage = img;
    return img;
  } catch (err) {
    console.warn('[SolarClient] app icon load failed:', err.message);
    appIconImage = false;
    return null;
  }
}

app.on('browser-window-created', (_e, win) => {
  const retitle = () => {
    const t = win.getTitle();
    if (!t || /electron/i.test(t)) win.setTitle(APP_NAME);
  };
  const applyIcon = () => {
    const img = getAppIcon();
    if (img) { try { win.setIcon(img); } catch { /* window may be gone */ } }
  };
  applyIcon();
  // Windows sometimes ignores an icon set before the window exists on
  // screen, so it's applied again once it's actually shown.
  win.once('ready-to-show', applyIcon);
  win.on('show', applyIcon);
  win.on('page-title-updated', (ev) => {
    // Microsoft's login page sets its own title; keep ours unless the page
    // has something genuinely more useful to say than "Electron".
    const pageTitle = win.webContents.getTitle();
    if (!pageTitle || /electron/i.test(pageTitle)) { ev.preventDefault(); win.setTitle(APP_NAME); }
  });
  win.webContents.on('did-finish-load', retitle);
  retitle();
});

// =====================================================================
// DISCORD RICH PRESENCE
// The app id below is SolarClient's public Discord application id — it
// is not a secret (it's visible to anyone who reads any RPC packet) and
// carries no permissions on its own. Art assets ("nebula", "java",
// "bedrock") are uploaded on the Discord developer portal for that app.
// Users can turn all of this off in Settings → Discord.
// =====================================================================
// IMPORTANT: Rich Presence requires a REAL Discord Application ID. Discord
// silently refuses the handshake for an unknown id (it replies CLOSE 4000),
// which is exactly why presence looked "broken" — there was a placeholder id
// here. There is no way around this: the id must come from an app YOU create
// at discord.com/developers/applications (free, 30 seconds, no bot needed).
// Settings → Discord has a field for it; paste the Application ID there.
// The app's NAME is what shows as "Playing <name>", so name it SolarClient.
// =====================================================================
// DISCORD APPLICATION ID — set this ONCE, here, and it ships to every user.
// Users never see or configure this; Rich Presence auto-detects whichever
// Discord account is running on THEIR machine — there's no "linking" step,
// it just works the moment they have Discord open.
//
// To get one: discord.com/developers/applications → New Application →
// name it "SolarClient" (that name is what shows as "Playing …") →
// copy the Application ID from General Information → paste it below.
// =====================================================================
const BUILT_IN_DISCORD_APP_ID = '1492589508854546626';
// Hosted Rich Presence art (HTTPS). Discord accepts https image keys and
// proxies them — this is how the new planet logo shows without a manual
// Developer Portal re-upload every time branding changes. Keep the file on
// the permanent `branding` prerelease (asset name discord-nebula.png).
const DISCORD_NEBULA_ART =
  'https://github.com/sharktoothgaming56-maker/solarclientsite/releases/download/branding/discord-nebula.png';
const DISCORD_ART_KEY = DISCORD_NEBULA_ART;

// Older builds shipped a different app ID and saved it to disk. That saved
// value overrides the built-in one, which is what produced "Invalid Client
// ID" even after the constant above was corrected. Clear any stored ID that
// isn't the current one so upgrades pick up the right app automatically.
(() => {
  const saved = store.get('discordAppId', '');
  if (saved && saved.trim() !== BUILT_IN_DISCORD_APP_ID) store.delete('discordAppId');
})();

function discordAppId() { return (store.get('discordAppId', '') || BUILT_IN_DISCORD_APP_ID).trim(); }
function discordAppIdIsBuiltIn() { return !store.get('discordAppId', '') && !!BUILT_IN_DISCORD_APP_ID; }
let discord = null;
let presenceState = { kind: 'idle', since: Date.now(), instanceName: null, versionNumber: null, edition: 'java' };

function discordEnabled() { return store.get('discordPresence', true) !== false; }
function discordShowDetails() { return store.get('discordShowDetails', true) !== false; }

function pushPresence() {
  if (!discord || !discordEnabled()) return;
  const s = presenceState;
  if (s.kind === 'idle') {
    discord.setActivity({
      details: 'In the launcher',
      state: 'Browsing instances',
      largeImageKey: store.get('discordAssets', true) ? DISCORD_ART_KEY : undefined,
      largeImageText: 'SolarClient',
      startTimestamp: s.since,
    });
    return;
  }
  const editionName = s.edition === 'bedrock' ? 'Bedrock Edition' : 'Java Edition';
  const assets = store.get('discordAssets', true);
  discord.setActivity({
    details: s.kind === 'launching' ? 'Launching Minecraft…' : 'Playing Minecraft',
    // respect the privacy toggle: never leak instance names if it's off
    state: discordShowDetails() && s.versionNumber
      ? `${editionName} ${s.versionNumber}${s.instanceName ? ` · ${s.instanceName}` : ''}`
      : editionName,
    // In-game: Minecraft art as the big image, SolarClient as the small
    // corner badge.
    largeImageKey: assets ? 'minecraft' : undefined,
    largeImageText: `Minecraft ${editionName}`,
    smallImageKey: assets ? DISCORD_ART_KEY : undefined,
    smallImageText: 'SolarClient',
    startTimestamp: s.since,
    pid: s.gamePid || undefined,
  });
}

// Medal, and Essential inside the game, set their own Discord status after
// ours and push it down the profile. Re-sending ours once they've started
// puts SolarClient back on top for as long as the launcher is open.
const DISCORD_RIVALS = /^medal(encoder)?\.exe$/i;
let discordRivalPids = new Set();
function reassertDiscordLater(ms) {
  setTimeout(() => { if (discord?.connected) discord.reassert(); }, ms);
}
setInterval(() => {
  if (process.platform !== 'win32' || !discord?.connected) return;
  require('child_process').execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, out) => {
    if (err) return;
    const now = new Set();
    for (const line of String(out).split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m && DISCORD_RIVALS.test(m[1])) now.add(m[2]);
    }
    const appeared = [...now].some((pid) => !discordRivalPids.has(pid));
    discordRivalPids = now;
    if (appeared) reassertDiscordLater(8000);
  });
}, 20000);
// They also refresh their status later (Essential on every world or server
// join, Medal while it records), so keep ours on top while either can be active.
setInterval(() => {
  if (!discord?.connected || !discordEnabled()) return;
  if (presenceState.kind === 'playing' || discordRivalPids.size) discord.reassert();
}, 90000);
// Joining a world or server in the game log: Essential is about to post its status.
const WORLD_JOIN_LINE = /Connecting to [^,\s]+, \d+|Started serving on \d+|Joining world|Preparing spawn area/i;
let lastWorldJoinReassert = 0;
function noteGameLogForDiscord(line) {
  if (!WORLD_JOIN_LINE.test(String(line))) return;
  const now = Date.now();
  if (now - lastWorldJoinReassert < 15000) return;
  lastWorldJoinReassert = now;
  reassertDiscordLater(12000);
}

function setPresence(next) {
  presenceState = { ...presenceState, ...next };
  pushPresence();
}

let discordError = null;
let discordUser = null;

function initDiscord() {
  if (!discordEnabled() || discord) return;
  const id = discordAppId();
  if (!/^\d{17,20}$/.test(id)) {
    discordError = id
      ? 'That Application ID doesn\'t look right — it should be 17–20 digits.'
      : 'Add your Discord Application ID below to turn on Rich Presence.';
    return;
  }
  discordError = null;
  const DiscordPresence = getDiscordPresence();
  discord = new DiscordPresence(id);
  discord.on('ready', (user) => {
    discordUser = user;
    discordError = null;
    // Once it has connected even once, this install is "linked" for good.
    store.set('discordLinked', true);
    pushPresence();
    broadcast('discord:state', discordStateNow());
  });
  discord.on('error', (msg) => { discordError = msg; broadcast('discord:state', discordStateNow()); });
  discord.on('disconnected', () => broadcast('discord:state', discordStateNow()));
  discord.connect();
}

// Discord is often opened after the launcher. Without a retry the presence
// never appears until you toggle it manually, which is why "client open but
// nothing showing" happened. Poll quietly until it connects.
let discordRetryTimer = null;
let discordRetryAttempt = 0;
function startDiscordAutoRetry() {
  if (discordRetryTimer) return;
  const tick = () => {
    if (!discordEnabled()) return;
    if (discord?.connected) {
      discordRetryAttempt = 0;
      return;
    }
    if (discordRetryAttempt >= 8) {
      // Stop hammering — user can Link Discord manually. Clears CPU/wake spam.
      if (discordRetryTimer) { clearInterval(discordRetryTimer); discordRetryTimer = null; }
      return;
    }
    discordRetryAttempt += 1;
    if (discord && !discord.connected) {
      try { discord.destroy(); } catch { /* already gone */ }
      discord = null;
    }
    initDiscord();
  };
  // Back off: 15s → 30s → … capped by clearing after 8 fails (~few minutes).
  discordRetryTimer = setInterval(tick, 20000);
}

function discordStateNow() {
  return {
    enabled: discordEnabled(),
    linked: store.get('discordLinked', false) === true,
    showDetails: discordShowDetails(),
    connected: !!discord?.connected,
    appId: discordAppId(),
    isBuiltIn: discordAppIdIsBuiltIn(),
    user: discordUser?.username || null,
    error: discord?.connected ? null : (discordError || discord?.lastError || null),
  };
}
function stopDiscord() {
  discordUser = null;
  if (!discord) return;
  discord.clearActivity();
  discord.destroy();
  discord = null;
}

ipcMain.handle('discord:settings', async () => discordStateNow());
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('discord:setAppId', async (_e, { appId }) => {
  store.set('discordAppId', (appId || '').trim());
  stopDiscord();
  discordError = null;
  initDiscord();
  // give the handshake a beat to land before the UI asks again
  await new Promise(r => setTimeout(r, 900));
  return discordStateNow();
});

ipcMain.handle('discord:test', async () => {
  if (!discord?.connected) { initDiscord(); await new Promise(r => setTimeout(r, 900)); }
  if (!discord?.connected) return { ok: false, error: discordStateNow().error || 'Not connected to Discord.' };
  setPresence({ kind: 'playing', edition: 'java', since: Date.now(), instanceName: 'Test', versionNumber: '1.21.11' });
  setTimeout(() => { if (!playerGameRunning()) setPresence({ kind: 'idle', instanceName: null, versionNumber: null, since: Date.now() }); }, 12000);
  return { ok: true, user: discordUser?.username || null };
});
ipcMain.handle('discord:setEnabled', async (_e, { enabled }) => {
  store.set('discordPresence', !!enabled);
  if (enabled) initDiscord(); else stopDiscord();
  return true;
});
ipcMain.handle('discord:setShowDetails', async (_e, { showDetails }) => {
  store.set('discordShowDetails', !!showDetails);
  pushPresence();
  return true;
});

// ---------- Bedrock IPC ----------
ipcMain.handle('shell:openExternal', async (_e, { url }) => {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Only web links can be opened.');
  await require('electron').shell.openExternal(url);
  return true;
});

// ---------- popups (ad clicks) open in the user's default browser ----------
// Ads live in sandboxed iframes and open their click-throughs with
// window.open. Electron's default is to create a new app window for that, so
// clicking an ad used to open the advertiser's page inside SolarClient. Every
// web popup from a launcher window now goes to the default browser instead.
//
// Two click styles are handled:
//   window.open('https://...')        -> handed straight to the browser.
//   window.open('') then set location -> some ad scripts do this to get past
//     popup blockers. The blank window is created hidden, its first real
//     navigation is handed to the browser, and the window is destroyed.
// Only http(s) URLs ever reach shell.openExternal; anything else is dropped.
function routePopupsToBrowser(webContents) {
  const { shell } = require('electron');
  const isWeb = (u) => /^https?:\/\//i.test(u || '');

  webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Beta: live chat / admin panel / who's online / updates popped out into their own little window.
    // The renderer moves the panel's DOM into it, so it must stay same-process.
    if ((!url || url === 'about:blank') && /^sc-pop-(chat|admin|online|updates)$/.test(frameName || '')) {
      const f = {};
      for (const part of String(features || '').split(',')) {
        const [k, v] = part.split('=').map((s) => s.trim());
        if (k) f[k.toLowerCase()] = Number(v);
      }
      const width = Math.round(Math.max(330, Math.min(Number.isFinite(f.width) ? f.width : 420, 1600)));
      const height = Math.round(Math.max(320, Math.min(Number.isFinite(f.height) ? f.height : 560, 1400)));
      const opts = {
        width, height, minWidth: 330, minHeight: 320,
        frame: false, roundedCorners: true, show: true, maximizable: false, fullscreenable: false,
        backgroundColor: '#1a142e', icon: APP_ICON, title: 'SolarClient',
      };
      if (Number.isFinite(f.left) && Number.isFinite(f.top)) {
        const { screen } = require('electron');
        const wa = screen.getDisplayNearestPoint({ x: Math.round(f.left + width / 2), y: Math.round(f.top + 20) }).workArea;
        opts.x = Math.round(Math.max(wa.x, Math.min(f.left, wa.x + wa.width - width)));
        opts.y = Math.round(Math.max(wa.y, Math.min(f.top, wa.y + wa.height - height)));
      }
      return { action: 'allow', overrideBrowserWindowOptions: opts };
    }
    if (isWeb(url)) {
      shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    }
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: { preload: undefined, sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    return { action: 'deny' };
  });

  webContents.on('did-create-window', (child, details) => {
    const pop = /^sc-pop-(chat|admin|online|updates)$/.exec(details?.frameName || '');
    if (pop) { watchPopout(child, pop[1]); return; }
    let handedOff = false;
    const handOff = (url) => {
      if (handedOff || !isWeb(url)) return;
      handedOff = true;
      shell.openExternal(url).catch(() => {});
      setImmediate(() => { if (!child.isDestroyed()) child.destroy(); });
    };
    child.webContents.on('will-navigate', (e, url) => { e.preventDefault(); handOff(e.url || url); });
    child.webContents.on('did-start-navigation', (e, url, _isInPlace, isMainFrame) => {
      if ((e.isMainFrame ?? isMainFrame) !== false) handOff(e.url || url);
    });
    // A blank window that never navigates anywhere is thrown away.
    setTimeout(() => { if (!child.isDestroyed()) child.destroy(); }, 10_000);
  });
}

// A popped-out panel window. Dragging it back over the launcher docks it:
// the launcher shows where it will land while the cursor is over it, and
// takes the panel back when the move ends there.
const popouts = new Map();
const popToMain = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
/** Cursor spot over the launcher (and where it holds the pop-out), or null when it's elsewhere. */
function popOverMain(child) {
  const { screen } = require('electron');
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return null;
  const p = screen.getCursorScreenPoint();
  const b = mainWindow.getContentBounds();
  if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) return null;
  const c = child.getBounds();
  return { x: p.x - b.x, y: p.y - b.y, ox: p.x - c.x, oy: p.y - c.y };
}

// Grab-anywhere moving and edge resizing of a pop-out. The window follows the
// real cursor (polled while the button is held) rather than page events, so it
// keeps up with the mouse and works even when the cursor outruns the window.
let popGrabbing = null;
function popGrabStop(dock) {
  const g = popGrabbing;
  if (!g) return;
  popGrabbing = null;
  clearInterval(g.timer);
  if (g.mode !== 'move' || g.child.isDestroyed()) return;
  const at = dock ? popOverMain(g.child) : null;
  if (g.over) popToMain('popout:hover', { key: g.key, over: false });
  if (at) popToMain('popout:dock', { key: g.key, ...at });
}
ipcMain.on('popout:grab', (_e, { key, mode, edge, sx, sy } = {}) => {
  const { screen } = require('electron');
  const child = popouts.get(key);
  if (!child || child.isDestroyed()) return;
  popGrabStop(false);
  const start = Number.isFinite(sx) && Number.isFinite(sy) ? { x: sx, y: sy } : screen.getCursorScreenPoint();
  const b = child.getBounds();
  const [minW, minH] = child.getMinimumSize();
  const g = { key, child, mode: mode === 'resize' ? 'resize' : 'move', edge: String(edge || ''), over: false, last: '' };
  g.timer = setInterval(() => {
    if (child.isDestroyed()) { popGrabStop(false); return; }
    const p = screen.getCursorScreenPoint();
    const dx = p.x - start.x, dy = p.y - start.y;
    let nb;
    if (g.mode === 'move') {
      nb = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height };
    } else {
      nb = { ...b };
      if (g.edge.includes('e')) nb.width = Math.max(minW, b.width + dx);
      if (g.edge.includes('s')) nb.height = Math.max(minH, b.height + dy);
      if (g.edge.includes('w')) { nb.width = Math.max(minW, b.width - dx); nb.x = b.x + b.width - nb.width; }
      if (g.edge.includes('n')) { nb.height = Math.max(minH, b.height - dy); nb.y = b.y + b.height - nb.height; }
    }
    const sig = `${nb.x},${nb.y},${nb.width},${nb.height}`;
    if (sig !== g.last) {
      g.last = sig;
      if (g.mode === 'move') child.setPosition(Math.round(nb.x), Math.round(nb.y));
      else child.setBounds({ x: Math.round(nb.x), y: Math.round(nb.y), width: Math.round(nb.width), height: Math.round(nb.height) });
    }
    if (g.mode === 'move') {
      const over = !!popOverMain(child);
      if (over !== g.over) { g.over = over; popToMain('popout:hover', { key, over }); }
    }
  }, 8);
  popGrabbing = g;
});
ipcMain.on('popout:release', () => popGrabStop(true));

function watchPopout(child, key) {
  const { shell } = require('electron');
  popouts.set(key, child);
  child.on('closed', () => {
    if (popouts.get(key) === child) popouts.delete(key);
    if (popGrabbing?.child === child) popGrabStop(false);
  });
  child.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//i.test(url || '')) shell.openExternal(url).catch(() => {});
  });
}

ipcMain.handle('bedrock:detect', async () => getBedrock().detectBedrock());
ipcMain.handle('bedrock:openStore', async () => { await getBedrock().openBedrockStorePage(); return true; });
ipcMain.handle('bedrock:launch', async (_e, { preview }) => {
  assertNotBanned();
  const res = await getBedrock().launchBedrock({ preview });
  setPresence({ kind: 'playing', edition: 'bedrock', since: Date.now(), versionNumber: res.version || null, instanceName: null });
  // Bedrock is a Store app we don't own the process of — show it as playing
  // for a sensible window, then fall back to idle.
  setTimeout(() => { if (presenceState.edition === 'bedrock') setPresence({ kind: 'idle', edition: 'java', since: Date.now(), versionNumber: null }); }, 60 * 60 * 1000);
  return res;
});

// Remove the default File/Edit/View/Window menu bar — that native menu is
// what makes an Electron app immediately look like a 2015 utility instead
// of a real product.
Menu.setApplicationMenu(null);

// ---------- paths ----------
function instancesRoot() {
  const root = path.join(app.getPath('userData'), 'instances');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function majorFolderFor(versionNumber) {
  const parts = versionNumber.split('.');
  return `${parts[0]}.${parts[1]}.x`;
}

function instancePath(versionNumber, instanceName) {
  return path.join(instancesRoot(), majorFolderFor(versionNumber), instanceName);
}

// ---------- window ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#0a0714',
    icon: APP_ICON,
    frame: false, // custom title bar drawn in the renderer instead

    // PERF: `show` defaults to true, so the window used to appear the
    // instant it was constructed -- as an empty rectangle -- and then sat
    // there while the renderer parsed 130KB of CSS and 220KB of JS. That
    // empty-frame period is what reads to a user as "the launcher takes
    // ages to open", even when the total time is unchanged.
    //
    // Held back until 'ready-to-show', which fires after the renderer has
    // produced its first frame, so the window appears already drawn.
    show: false,
    paintWhenInitiallyHidden: true,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,

      // Nothing in this app needs to keep animating at full rate while it
      // is behind a fullscreen Minecraft. Throttling a backgrounded
      // renderer is the single biggest thing the launcher can do to stop
      // stealing frames from the game itself.
      backgroundThrottling: true,

      // Spell-check spins up a dictionary download and a per-keystroke
      // check for a UI that has three text inputs. Off.
      spellcheck: false,

      // v8 code caching for the renderer bundle: second and subsequent
      // launches skip re-compiling renderer.js from source.
      v8CacheOptions: 'code',
    },
  });

  routePopupsToBrowser(mainWindow.webContents);

  // Start the load immediately; ready-to-show is what gates visibility.
  bootMark('createWindow / loadFile');
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    bootMark('ready-to-show → show()');
    mainWindow.show();
    // Frameless (frame:false) windows on Windows have a known quirk where
    // the renderer doesn't reliably receive keyboard focus on first load,
    // making inputs look "dead" until you click the title bar first.
    mainWindow.focus();
  });

  // Safety net: if a renderer error means ready-to-show never fires, do not
  // leave the user with no window at all.
  mainWindow.webContents.once('did-finish-load', () => {
    if (!mainWindow.isVisible()) { mainWindow.show(); mainWindow.focus(); }
  });

  // PERF: forwarding every renderer console message across the process
  // boundary and writing it to stdout is not free -- a chatty renderer turns
  // into main-process I/O that blocks the event loop, which is the thread
  // that services all IPC. Only wire it up in development.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_event, _level, message, line) => {
      console.log(`[RENDERER] ${message} (line ${line})`);
    });
  }
}

// Brand the Electron binary from inside the app as well as from
// `npm start`. Because the script COPIES electron.exe and patches the copy,
// this is safe to run while Electron is live — it just takes effect on the
// next launch. This covers people who start the app from a shortcut, an
// editor, or `npx electron .` rather than through npm.
function brandElectronInBackground() {
  // process.defaultApp is true when started via the Electron CLI from a
  // source folder, and is unaffected by the executable's name — unlike
  // app.isPackaged, which is literally just a filename check.
  if (process.platform !== 'win32' || !process.defaultApp) return;
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'brand-dev.js');
    if (!fs.existsSync(script)) return;
    const child = spawn(process.execPath, [script], {
      detached: true, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => process.stderr.write(d));
    child.unref();
  } catch (err) {
    console.warn('[SolarClient] branding skipped:', err.message);
  }
}

app.whenReady().then(() => {
  bootMark('app.whenReady');
  // =====================================================================
  // STARTUP ORDER
  //
  // Everything below used to run BEFORE createWindow(): an XP repair pass
  // that walks the playtime store, the friends backend handshake (a network
  // round trip), icon loading, and brandElectronInBackground(), which
  // literally spawns a child process. None of it has anything to do with
  // drawing the first frame, and all of it ran on the main process's only
  // thread -- so the window could not even be CONSTRUCTED until all of it
  // had finished.
  //
  // The window is created first now. Everything else is deferred until
  // after the first frame is on screen, so none of it can delay the app
  // appearing, and the pieces that touch the network or the disk are
  // additionally spread out so they don't land in one blocking clump.
  // =====================================================================
  createWindow();

  // One ready-to-show gate for all deferred startup work (avoid MaxListeners spam).
  const firstFrameJobs = [];
  const afterFirstFrame = (fn, delay = 0) => {
    firstFrameJobs.push({ fn, delay });
  };
  const runFirstFrameJobs = () => {
    for (const { fn, delay } of firstFrameJobs) {
      setTimeout(() => { try { fn(); } catch (err) { console.warn('[startup]', err.message); } }, delay);
    }
    firstFrameJobs.length = 0;
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.once('ready-to-show', runFirstFrameJobs);
  } else {
    runFirstFrameJobs();
  }

  // Clear leftover zombies AFTER first paint — never block window creation.
  // (Removed the every-5-minute taskkill loop: it spawned cmd forever + AV bait.)
  afterFirstFrame(() => { try { killOtherSolarClients(); } catch { /* ok */ } }, 1500);

  // Cheap, synchronous, and needed by the UI almost immediately.
  afterFirstFrame(() => {
    console.log(`[SolarClient] running as: ${process.execPath}`);
    getAppIcon();
    app.setAboutPanelOptions?.({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      version: '',
      credits: 'SolarClient',
    });
  }, 0);

  // Walks every playtime record on disk. Not urgent, and not worth a frame.
  afterFirstFrame(() => repairXpFromRealPlaytime(), 400);

  // Discord IPC + the updater check are both network-bound; stagger them so
  // they don't contend with the renderer's own first-paint work.
  afterFirstFrame(() => { initDiscord(); startDiscordAutoRetry(); }, 800);
  // Register update IPC before the renderer asks for state (was 2.5s late → errors).
  afterFirstFrame(() => getAutoUpdate().initAutoUpdate(mainWindow), 0);
  afterFirstFrame(() => brandElectronInBackground(), 3000);

  // Pre-compile the heavy launch/auth dependency trees while the machine is
  // idle, so the first click on Launch or Sign In doesn't pay for the
  // require() that lazy loading deferred. Deliberately last.
  afterFirstFrame(() => {
    try { getClient(); } catch { /* only matters at launch time */ }
    try { getAuth(); } catch { /* only matters at sign-in time */ }
    // Prefetch Solar mod release metadata so first Fabric launch skips GitHub.
    warmSolarModMeta().catch(() => {});
  }, 4000);

  // Friends + in-game bridge load AFTER first paint — they used to be
  // top-level requires that blocked BrowserWindow construction entirely.
  afterFirstFrame(() => {
    try {
      const f = ensureFriends();
      const activeId = store.get('activeAccountId');
      f.setSelf(getAccounts().find(a => a.id === activeId) || null);

      f.setAuthProvider(async (serverId) => {
        const account = getAccounts().find(a => a.id === (store.get('activeAccountId')));
        if (!account) throw new Error('Not signed in.');
        const join = (auth, uuid) => fetch('https://sessionserver.mojang.com/session/minecraft/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accessToken: auth.access_token, selectedProfile: uuid, serverId }),
        });
        // Fast path: a still-valid token from earlier. Falls through to a
        // full refresh if Mojang no longer accepts it.
        const device = await getDeviceId();
        const cached = cachedOnlineSession(account.id);
        if (cached) {
          try {
            const r = await join(cached, cached.id);
            if (r.status === 204) return { username: cached.name, uuid: cached.id, device };
          } catch { /* refresh below */ }
          store.delete('onlineSession');
        }
        const auth = await getFreshAuthorization(account);
        const uuid = String(auth.uuid || account.id).replace(/-/g, '');
        const res = await join(auth, uuid);
        if (res.status !== 204) {
          let detail = '';
          try { detail = (await res.text()).slice(0, 300); } catch { /* no body */ }
          const shape = `token:${auth.access_token ? auth.access_token.length + 'ch' : 'MISSING'} profile:${uuid || 'MISSING'}`;
          throw new Error(`Mojang refused the session check (${res.status}). ${detail || '(no body)'} [${shape}]`);
        }
        return { username: auth.name || account.name, uuid, device };
      });

      f.connect();
      checkDeviceBan();
      // Sleep and network changes kill sockets silently; reconnect the moment we're back.
      const wake = () => { try { friends?.wake(); } catch { /* not started */ } };
      powerMonitor.on('resume', wake);
      powerMonitor.on('unlock-screen', wake);
    } catch (err) { console.warn('[friends] startup:', err.message); }
  }, 0);

  afterFirstFrame(async () => {
    try {
      await ensureBridge().start();
      pushBridge();
    } catch (err) { console.warn('[bridge] could not start:', err.message); }
  }, 1600);
});
app.on('will-quit', () => stopDiscord());
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // Force a real exit — hanging child handles used to leave zombie
  // SolarClient.exe entries in Task Manager after the window closed.
  try { app.exit(0); } catch { process.exit(0); }
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// window chrome controls for the custom title bar — act on whichever
// window sent the message (the main window or a game monitor window)
ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('window:close', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  // Closing the main window must quit the whole app (one task only).
  if (!mainWindow || win === mainWindow || win.id === mainWindow.id) {
    try { app.exit(0); } catch { process.exit(0); }
    return;
  }
  win.close();
});

// send to every open window (main + any monitor windows)
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// =====================================================================
// IPC COALESCING
//
// Two channels here are firehoses:
//
//   launch:log      Minecraft prints several hundred lines in the first
//                   seconds of a modded launch, and every one was its own
//                   IPC message.
//   launch:progress the downloader reported after every completed file --
//                   a first install is ~2500 asset files.
//
// Every electron IPC send is a structured clone plus a hop across the
// process boundary, and it lands in the renderer as a task that pre-empts
// rendering. Thousands of them arriving faster than the renderer can draw
// is why the window went unresponsive during a download and why the game
// monitor locked up on launch.
//
// Nothing is dropped from the log (order is preserved and the whole batch
// is delivered); it is just delivered as one message per frame-ish tick
// instead of one per line. Progress IS coalesced by latest-wins, which is
// correct -- a progress value nobody managed to draw has no meaning.
// =====================================================================
const LOG_FLUSH_MS = 60;        // ~16/sec, comfortably below a 60Hz frame budget
const PROGRESS_FLUSH_MS = 100;  // 10/sec is faster than a human reads a number

const logPending = new Map();   // launchId -> [{line, level}]
let logTimer = null;

function flushLogs() {
  logTimer = null;
  if (!logPending.size) return;
  for (const [launchId, lines] of logPending) {
    if (lines.length) broadcast('launch:log-batch', { launchId, lines });
  }
  logPending.clear();
}

function emitLog(launchId, line, level) {
  bufferLog(launchId, line, level);
  let arr = logPending.get(launchId);
  if (!arr) { arr = []; logPending.set(launchId, arr); }
  arr.push({ line, level });
  // Cap the in-flight batch. A runaway crash loop can print megabytes in a
  // second and there is no value in shipping more than the console can hold.
  if (arr.length > 1200) arr.splice(0, arr.length - 1200);
  if (!logTimer) logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
}

const progressPending = new Map();  // launchId -> latest payload
let progressTimer = null;

function flushProgressIpc() {
  progressTimer = null;
  for (const [, payload] of progressPending) broadcast('launch:progress', payload);
  progressPending.clear();
}

function emitProgress(payload) {
  const key = payload.launchId || '_';
  const isTerminal = payload.percent === 100 || payload.done;
  progressPending.set(key, payload);
  if (isTerminal) {
    // Never let "finished" sit in a queue -- that is the one update the
    // user is actually waiting to see.
    if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
    flushProgressIpc();
    return;
  }
  if (!progressTimer) progressTimer = setTimeout(flushProgressIpc, PROGRESS_FLUSH_MS);
}

// =====================================================================
// AUTH — supports multiple saved Microsoft/Minecraft accounts, with one
// marked "active" at a time. Uses msmc's built-in vanilla launcher client
// id, so no Azure app registration is needed to get started.
// =====================================================================
function getAccounts() { return store.get('accounts', []); }
function saveAccounts(list) { store.set('accounts', list); }

ipcMain.handle('auth:login', async () => {
  const authManager = new (getAuth())('select_account');
  const xboxManager = await authManager.launch('electron');
  const token = await xboxManager.getMinecraft();

  const account = {
    id: token.profile.id,
    name: token.profile.name,
    xuid: token.profile.xuid,
    // Xbox#save() — confirmed against msmc's actual class definition —
    // is the serializable string built specifically to be handed back to
    // Auth#refresh(refreshToken: string) later. (My last two attempts at
    // this were wrong: Minecraft tokens don't have .save(), and
    // Auth#token is an unrelated OAuth client-config field, not the
    // user's session.)
    savedToken: xboxManager.save(),
    //
    // NOTE: stored as plain JSON via electron-store. Fine for local dev —
    // pass an `encryptionKey` to `new Store()` before shipping this to
    // other people so tokens aren't sitting in plaintext on disk.
  };

  const accounts = getAccounts().filter(a => a.id !== account.id);
  accounts.push(account);
  saveAccounts(accounts);
  store.set('activeAccountId', account.id);

  return { id: account.id, name: account.name };
});

async function getFreshAuthorization(account) {
  if (!account.savedToken) {
    throw new Error('This account was saved before a login fix — remove it in Settings and sign in again.');
  }
  const authManager = new (getAuth())('select_account');
  const xboxManager = await authManager.refresh(account.savedToken);
  const token = await xboxManager.getMinecraft();

  // keep the (possibly rotated) token saved for next time too
  const fresh = token.mclc();

  // Repair records written by older builds while we're here: keep the
  // rotated refresh token, and correct the stored id/name if they drifted
  // from what Mojang actually says this token belongs to. Without this an
  // account saved by an old version stays subtly wrong forever, and every
  // session check it makes is refused.
  const correctedId = String(fresh.uuid || account.id).replace(/-/g, '');
  const accounts = getAccounts().map(a => a.id === account.id
    ? { ...a, id: correctedId, name: fresh.name || a.name, savedToken: xboxManager.save() }
    : a);
  saveAccounts(accounts);
  if (store.get('activeAccountId') === account.id) store.set('activeAccountId', correctedId);

  // Minecraft access tokens live ~24h. Keeping the newest one lets the
  // online connection skip the Microsoft -> Xbox -> Minecraft refresh chain,
  // which is most of the time it takes to connect.
  store.set('onlineSession', {
    id: correctedId, name: fresh.name || account.name,
    access_token: fresh.access_token, exp: Date.now() + 20 * 60 * 60 * 1000,
  });
  return fresh;
}

function cachedOnlineSession(accountId) {
  const s = store.get('onlineSession');
  return s && s.id === accountId && s.access_token && s.exp > Date.now() ? s : null;
}

ipcMain.handle('auth:list', async () => {
  return getAccounts().map(a => ({ id: a.id, name: a.name }));
});

ipcMain.handle('auth:current', async () => {
  const activeId = store.get('activeAccountId');
  const account = getAccounts().find(a => a.id === activeId);
  return account ? { id: account.id, name: account.name } : null;
});

ipcMain.handle('auth:switch', async (_e, { id }) => {
  store.set('activeAccountId', id);
  const account = getAccounts().find(a => a.id === id);
  return account ? { id: account.id, name: account.name } : null;
});

ipcMain.handle('auth:remove', async (_e, { id }) => {
  const accounts = getAccounts().filter(a => a.id !== id);
  saveAccounts(accounts);
  if (store.get('onlineSession')?.id === id) store.delete('onlineSession');
  if (store.get('activeAccountId') === id) {
    store.set('activeAccountId', accounts[0]?.id || null);
  }
  return true;
});

// =====================================================================
// AFK SESSIONS — connects to a server and stays logged in without ever
// opening the actual game (no window, no rendering, no mods). Uses
// minecraft-protocol (a lightweight reimplementation of the Minecraft
// network protocol) instead of launching the real client headlessly,
// since the real client needs a graphics context to even start.
//
// afkSessions (persisted): saved {id, name, ip, port, accountId} configs.
// afkClients (in-memory only): sessionId -> live connection + status.
// Nothing here is a full game client — no world rendering, no movement,
// no interaction beyond responding to keep-alive so the server doesn't
// time it out. Good for parking on an AFK-friendly server; won't survive
// anything that requires the player to actually do something (many
// anti-AFK plugins will still eventually kick/kill an idle player).
//
// A server's own rules about AFK bots/farming still apply here same as
// they would for any other AFK method — this just automates staying
// connected, it doesn't get around anything server-side.
// =====================================================================
const afkClients = new Map();

function getAfkSessions() { return store.get('afkSessions', []); }
function saveAfkSessions(list) { store.set('afkSessions', list); }

function parseIpPort(raw) {
  const [host, portStr] = raw.trim().split(':');
  return { host, port: portStr ? Number(portStr) : 25565 };
}

function afkStatusPayload() {
  const sessions = getAfkSessions();
  return sessions.map(s => ({
    ...s,
    status: afkClients.get(s.id)?.status || 'stopped',
  }));
}

function broadcastAfkStatus() {
  broadcast('afk:status', afkStatusPayload());
}

ipcMain.handle('afk:list', async () => afkStatusPayload());

ipcMain.handle('afk:save', async (_e, { name, ip, accountId }) => {
  const { host, port } = parseIpPort(ip);
  if (!host) throw new Error('Enter a server IP.');
  const sessions = getAfkSessions();
  sessions.push({ id: `afk-${Date.now()}`, name: name || host, ip: host, port, accountId });
  saveAfkSessions(sessions);
  return afkStatusPayload();
});

ipcMain.handle('afk:delete', async (_e, { id }) => {
  const running = afkClients.get(id);
  if (running) { running.client.end(); afkClients.delete(id); }
  saveAfkSessions(getAfkSessions().filter(s => s.id !== id));
  return afkStatusPayload();
});

ipcMain.handle('afk:start', async (_e, { id }) => {
  const session = getAfkSessions().find(s => s.id === id);
  if (!session) throw new Error('Session not found.');
  if (afkClients.has(id)) throw new Error('Already running.');

  // Duplicate-IP guard — a server will just kick the second connection
  // for the same account anyway, but this gives a clear message instead
  // of a confusing disconnect a moment later.
  const dupe = [...afkClients.values()].find(c => c.ip === session.ip && c.port === session.port);
  if (dupe) throw new Error(`You're already online on ${session.ip} (via "${dupe.name}").`);

  const account = getAccounts().find(a => a.id === session.accountId);
  if (!account) throw new Error('The account saved for this session no longer exists — edit or re-save this session.');

  let auth;
  try {
    auth = await getFreshAuthorization(account);
  } catch (err) {
    throw new Error(`Sign-in expired for ${account.name}: ${err.message}`);
  }

  const entry = { name: session.name, ip: session.ip, port: session.port, status: 'connecting', client: null, timeout: null };
  afkClients.set(id, entry);
  broadcastAfkStatus();

  // Cleans up + reports a failure exactly once, no matter which of
  // timeout/error/end fires first — without this, any path that didn't
  // explicitly delete the map entry left the session stuck showing
  // "Connecting…" forever with no way to retry (afk:start refuses to
  // start something the map already thinks is running, and there was
  // no way to Stop it either — see the afk:stop fix below).
  function fail(reason) {
    if (!afkClients.has(id)) return; // already cleaned up
    clearTimeout(entry.timeout);
    afkClients.delete(id);
    broadcastAfkStatus();
    broadcast('afk:disconnected', { id, name: session.name, reason });
  }

  // A dead/wrong IP, a firewall silently dropping packets, or a server
  // that just never completes the login handshake won't necessarily
  // ever emit 'error' — TCP can sit "connecting" far longer than anyone
  // will wait around for. Force a clear failure instead of hanging.
  entry.timeout = setTimeout(() => {
    fail('Timed out waiting to log in. Double-check the server IP/port and that the server is online.');
    try { entry.client?.end(); } catch { /* already gone */ }
  }, 20000);

  let client;
  try {
    client = getMcProtocol().createClient({
      host: session.ip,
      port: session.port,
      username: auth.name,
      // NOTE: deliberately NO `auth: 'microsoft'` here. That option tells
      // minecraft-protocol to run its OWN interactive Microsoft
      // device-code sign-in, ignoring the session below. There's nowhere
      // to show that prompt in a headless AFK connection, so it just
      // hangs until the 20s timeout above fires with "Timed out waiting
      // to log in" — which is exactly the symptom this caused. Passing a
      // pre-fetched `session` is sufficient on its own.
      // minecraft-protocol accepts a pre-fetched session to skip its own
      // login flow — mapped from the same mclc()-shaped auth object
      // launch:start already uses (access_token / uuid / name).
      session: {
        clientToken: account.id,
        accessToken: auth.access_token,
        selectedProfile: { id: auth.uuid, name: auth.name },
      },
      // CRITICAL: omitting this does NOT auto-detect — per the library's
      // own docs it silently defaults to protocol 1.8 (2014). Against any
      // current server that mismatch fails the handshake outright, which
      // was very likely the actual reason nothing ever connected.
      version: false,
      // We just fetched this token seconds ago via the same msmc flow
      // launch:start uses — no need for the library to also re-validate
      // it against Mojang's auth server before connecting.
      skipValidation: true,
    });
  } catch (err) {
    // createClient can throw synchronously (bad options, immediate DNS
    // failure, etc.) — before this fix that left the entry orphaned in
    // the map with client:null forever, since nothing after this point
    // ever ran to clean it up. fail() already broadcasts the reason
    // (renderer shows it via onAfkDisconnected), so just return cleanly
    // here rather than also rejecting the invoke with the same message.
    fail(err.message || 'Could not start the connection.');
    return afkStatusPayload();
  }
  entry.client = client;

  client.on('login', () => {
    clearTimeout(entry.timeout);
    entry.status = 'online';
    broadcastAfkStatus();
  });
  client.on('end', (reason) => fail(reason || 'Connection closed.'));
  client.on('error', (err) => fail(err.message || 'Connection error.'));
  client.on('kick_disconnect', (packet) => {
    broadcast('afk:disconnected', { id, name: session.name, reason: packet.reason || 'Kicked from server.' });
  });

  return afkStatusPayload();
});

ipcMain.handle('afk:stop', async (_e, { id }) => {
  const running = afkClients.get(id);
  if (running) {
    clearTimeout(running.timeout);
    // Always clean up the map entry even if ending the underlying
    // connection throws (e.g. it's already dead/half-open) — previously
    // the throw skipped the delete() below entirely, so a session that
    // failed to end cleanly could never be cleared without restarting
    // the whole launcher.
    try { running.client?.end('Stopped from launcher'); } catch { /* already gone */ }
    afkClients.delete(id);
  }
  broadcastAfkStatus();
  return afkStatusPayload();
});

// XP + level system
// XP needed to reach the next level grows each time — starts easy then
// Minutes needed to clear a single level. Starts around 17 min and grows
// gently so level 500 stays reachable.
function xpForLevel(level) {
  if (level >= 500) return Math.floor(15 + 500 * 2.2);
  return Math.floor(15 + level * 2.2);
}

// Total minutes needed to REACH a level, counting from level 1. Playtime
// is cumulative and never gets spent, so these are running totals.
function totalXpForLevel(level) {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpForLevel(l);
  return sum;
}

function levelForTotal(totalMinutes) {
  let level = 1;
  let spent = 0;
  while (level < 500 && totalMinutes >= spent + xpForLevel(level)) {
    spent += xpForLevel(level);
    level += 1;
  }
  return level;
}

function getXpData() {
  const raw = store.get('xp', { xp: 0, level: 1, totalXp: 0 });
  // Older builds subtracted xp on level-up, so totalXp is the only
  // trustworthy figure — derive everything from it.
  const total = raw.totalXp ?? raw.xp ?? 0;
  return { totalXp: total, level: levelForTotal(total) };
}

// Everything the UI needs, all expressed as lifetime playtime.
function xpPayload() {
  const d = getXpData();
  const start = totalXpForLevel(d.level);
  const next = start + xpForLevel(d.level);
  return {
    totalXp: d.totalXp,      // lifetime minutes played
    level: d.level,
    xp: d.totalXp,           // shown as-is; never decreases
    xpNeeded: next,          // lifetime total required for the next level
    levelStart: start,       // lifetime total this level began at
  };
}

// Single choke point for awarding XP. Every grant goes through here so the
// store write and the "the number changed" broadcast can never get out of
// sync — previously the launch bonus wrote straight to the store and the
// renderer had no idea, so whichever widget happened to re-render next
// showed a different level than the one that didn't.
function addXp(amount) {
  const before = getXpData();
  const total = before.totalXp + (Number(amount) || 0);
  store.set('xp', { totalXp: total, level: levelForTotal(total) });
  const after = xpPayload();
  const payload = { ...after, leveled: after.level > before.level };
  broadcast('xp:changed', payload);
  return payload;
}

// Proxy external images through main process to bypass CORS restrictions
// that block browser-based image requests (e.g. Minecraft wiki textures).
ipcMain.handle('util:fetchImageBase64', async (_e, url) => {
  try {
    const res = await chromeFetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const b64 = Buffer.from(buffer).toString('base64');
    const ct = res.headers.get('content-type') || 'image/png';
    return `data:${ct};base64,${b64}`;
  } catch { return null; }
});

// =====================================================================
// FRIENDS / BRIDGE / SERVERS — lazy-loaded after first paint
//
// These three modules (plus serverPing) used to be required at the top of
// this section during main.js evaluation — BEFORE createWindow could run.
// On cold start that meant hundreds of KB of parse+compile sitting between
// process start and a visible window. Handlers still register immediately;
// the require() happens on first use or the deferred startup jobs above.
// =====================================================================
let friends = null;
let bridge = null;
let serverHost = null;
let friendsBridgeWired = false;

// A random id for this install. The uninstaller (build/installer.nsh) posts it
// to the server, which then stops listing the player as offline.
function installId() {
  const file = path.join(app.getPath('userData'), 'install-id');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(v)) return v;
  } catch { /* first run */ }
  const v = require('crypto').randomBytes(16).toString('hex');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, v); } catch { /* read-only profile */ }
  return v;
}

function ensureFriends() {
  if (friends) return friends;
  const { Friends } = require('./friends');
  friends = new Friends(store);
  friends.installId = installId();
  friends.on('changed', (snap) => broadcast('friends:changed', snap));
  friends.on('notify', (n) => broadcast('friends:notify', n));
  friends.on('connection', (c) => {
    if (c.connected) clearBan();   // the server let us in, so no ban stands
    broadcast('friends:connection', c);
  });
  friends.on('banned', (b) => setBan(b));
  friends.on('blocked', (b) => broadcast('friends:blocked', b));
  friends.on('mod', (m) => broadcast('mod:event', m));
  friends.on('global', (g) => broadcast('chat:global', g));
  friends.on('voice', (m) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('voice:event', m);
  });
  friends.on('error', (e) => console.warn('[friends]', e));
  wireFriendsBridge();
  return friends;
}

// ---- bans -------------------------------------------------------------
// A ban comes from the server (on sign-in, or the startup device check)
// and is kept here, so the launcher stays locked even offline or signed
// out. Launching games is refused in this process, not just in the UI.

/** One-way code for this computer. The raw machine id never leaves the PC. */
let deviceIdPromise = null;
function getDeviceId() {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      const run = (cmd, args) => new Promise((resolve) => {
        require('child_process').execFile(cmd, args, { windowsHide: true, timeout: 5000 },
          (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      let raw = '';
      try {
        if (process.platform === 'win32') {
          const out = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
          raw = (out.match(/MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i) || [])[1] || '';
        } else if (process.platform === 'linux') {
          for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
            try { raw = fs.readFileSync(f, 'utf8').trim(); } catch { /* try the next */ }
            if (raw) break;
          }
        } else if (process.platform === 'darwin') {
          const out = await run('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
          raw = (out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/) || [])[1] || '';
        }
      } catch { /* fall back below */ }
      if (!raw) {
        raw = store.get('deviceSeed');
        if (!raw) { raw = crypto.randomUUID(); store.set('deviceSeed', raw); }
      }
      return crypto.createHash('sha256').update(`solarclient-device-v1:${String(raw).toLowerCase()}`).digest('hex');
    })();
  }
  return deviceIdPromise;
}

function currentBan() {
  const b = store.get('ban');
  if (!b || typeof b !== 'object') return null;
  if (b.until && b.until <= Date.now()) { store.delete('ban'); return null; }
  return b;
}
function setBan(b) {
  const ban = {
    id: String(b?.id || '').slice(0, 16),
    name: String(b?.name || '').slice(0, 16),
    reason: String(b?.reason || 'No reason given').slice(0, 500),
    at: Number(b?.at) || Date.now(),
    until: b?.until ? Number(b.until) : null,
    length: String(b?.length || '').slice(0, 40),
  };
  store.set('ban', ban);
  broadcast('ban:state', ban);
}
function clearBan() {
  if (!store.get('ban')) return;
  store.delete('ban');
  broadcast('ban:state', null);
}
function assertNotBanned() {
  const b = currentBan();
  if (!b) return;
  throw new Error(b.until
    ? `You're banned from SolarClient until ${new Date(b.until).toLocaleString()}.`
    : "You're permanently banned from SolarClient.");
}
/** Ask the server whether this computer is banned (works signed out too). */
async function checkDeviceBan() {
  try {
    const base = await ensureFriends().backendHttpBase();
    if (!base) return currentBan();
    const res = await fetch(`${base}/ban/check?device=${await getDeviceId()}`,
      { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!res.ok) return currentBan();
    const data = await res.json();
    if (data.banned) setBan(data);
    else clearBan();
  } catch { /* offline: keep whatever we had */ }
  return currentBan();
}

const MOD_OPS = new Set([
  'overview', 'flag_delete', 'flags_clear', 'ban', 'unban', 'webhook_test',
  'mute', 'unmute', 'report_delete', 'reports_clear',
]);

function ensureBridge() {
  if (bridge) return bridge;
  const { Bridge } = require('./bridge');
  bridge = new Bridge({ userDataDir: app.getPath('userData') });
  bridge.on('action', async ({ action, payload, reply }) => {
    try {
      const f = ensureFriends();
      switch (action) {
        case 'friends:message':
          if (payload.conversationKind === 'group') f.sendGroupMessage(payload.conversationId, payload.text);
          else f.sendDm(payload.conversationId, payload.text);
          break;
        case 'friends:invite':
          f.sendInvite({
            kind: payload.address ? 'server' : 'world',
            address: payload.address || null,
            worldName: payload.worldName || null,
            instanceName: payload.instanceName || null,
            versionNumber: payload.versionNumber || null,
            conversationKind: payload.conversationKind,
            conversationId: payload.conversationId,
          });
          break;
        case 'friends:join': {
          const target = f.resolveInvite(payload.inviteId);
          return reply({ ok: true, address: target.address, name: target.name });
        }
        case 'friends:lanOpened':
          f.setActivity({ ...(f.activity || {}), lanPort: payload.port, ip: payload.ip || null });
          break;
        case 'friends:markRead':
          f.markRead(payload.conversationId);
          break;
        case 'roles:query': {
          const map = await f.queryRoles(payload.uuids || []);
          return reply({ ok: true, roles: map });
        }
        // Roles are managed only with !solarclient on Discord; older mods
        // still send the in-game command, so answer it here.
        case 'solarclient:command':
          return reply({ ok: false, message: 'Roles are managed on Discord now: !solarclient <role> <add|remove> <minecraft name> <discord username>' });
        default: break;
      }
      reply({ ok: true });
    } catch (err) {
      reply({ ok: false, error: err.message });
    }
  });
  wireFriendsBridge();
  return bridge;
}

function wireFriendsBridge() {
  if (friendsBridgeWired || !friends || !bridge) return;
  friendsBridgeWired = true;
  friends.on('changed', () => pushBridge());
  friends.on('notify', (n) => pushBridge(n));
}

function bridgePayload() {
  const snap = ensureFriends().snapshot();
  return {
    self: snap.self,
    connected: snap.connected,
    friends: snap.friends.map(f => ({ uuid: f.uuid, name: f.name, status: f.status, activity: f.activity })),
    groups: snap.groups.map(g => ({ id: g.id, name: g.name, icon: g.icon, members: g.members.length })),
    conversations: [
      ...snap.friends.map(f => ({
        kind: 'dm', id: f.uuid, name: f.name,
        messages: (snap.dms[f.uuid] || []).slice(-40),
      })),
      ...snap.groups.map(g => ({
        kind: 'group', id: g.id, name: g.name,
        messages: (g.messages || []).slice(-40),
      })),
    ],
    invites: snap.invites,
  };
}

let bridgePushQueued = false;
function pushBridge(notice = null) {
  if (!bridge) return;
  if (bridgePushQueued && !notice) return;
  bridgePushQueued = true;
  setImmediate(() => {
    bridgePushQueued = false;
    try { bridge.publish(bridgePayload(), notice); } catch { /* bridge may be down */ }
  });
}

// Wrap every handler so a thrown error reaches the renderer as a message
// rather than an unhandled rejection in the console.
const friendsHandlers = {
  'friends:snapshot': () => ensureFriends().snapshot(),
  'friends:follow': (_e, { uuid, name }) => ensureFriends().follow(uuid, name),
  'friends:unfollow': (_e, { uuid }) => ensureFriends().unfollow(uuid),
  'friends:block': (_e, { uuid }) => ensureFriends().block(uuid),
  'friends:unblock': (_e, { uuid }) => ensureFriends().unblock(uuid),
  'friends:sendDm': (_e, { uuid, text, replyTo }) => ensureFriends().sendDm(uuid, text, null, replyTo),
  'friends:editMessage': (_e, payload) => ensureFriends().editMessage(payload),
  'friends:deleteMessage': (_e, payload) => ensureFriends().deleteMessage(payload),
  'friends:clearConversation': (_e, payload) => ensureFriends().clearConversation(payload),
  'friends:createGroup': (_e, { name, members, icon }) => ensureFriends().createGroup(name, members, icon),
  'friends:setGroupIcon': (_e, { groupId, icon }) => ensureFriends().setGroupIcon(groupId, icon),
  'friends:removeFromGroup': (_e, { groupId, uuid }) => ensureFriends().removeFromGroup(groupId, uuid),
  'friends:addToGroup': (_e, { groupId, uuid }) => ensureFriends().addToGroup(groupId, uuid),
  'friends:leaveGroup': (_e, { groupId }) => ensureFriends().leaveGroup(groupId),
  'friends:sendGroupMessage': (_e, { groupId, text, replyTo }) => ensureFriends().sendGroupMessage(groupId, text, null, replyTo),
  'friends:markRead': (_e, { conversationId }) => ensureFriends().markRead(conversationId),
  'friends:sendInvite': (_e, payload) => ensureFriends().sendInvite(payload),
  'communities:create': (_e, payload) => ensureFriends().createCommunity(payload),
  'communities:join': (_e, payload) => ensureFriends().joinCommunity(payload),
  'communities:addChannel': (_e, payload) => ensureFriends().addCommunityChannel(payload),
  'communities:renameChannel': (_e, payload) => ensureFriends().renameCommunityChannel(payload),
  'communities:update': (_e, { id, name, icon } = {}) => ensureFriends().updateCommunity({ id, name, icon }),
  'profile:get': (_e, { uuid } = {}) => ensureFriends().getProfile(uuid),
  'profile:meta': () => ensureFriends().profileMeta(),
  'profile:setMeta': (_e, patch = {}) => ensureFriends().setProfileMeta(patch),
  'communities:deleteChannel': (_e, payload) => ensureFriends().deleteCommunityChannel(payload),
  'communities:setLayout': (_e, payload) => ensureFriends().setCommunityLayout(payload),
  'communities:leave': (_e, payload) => ensureFriends().leaveCommunity(payload),
  'communities:send': (_e, payload) => ensureFriends().sendCommunityMessage(payload),
  'voice:join': (_e, { id, channelId, muted, deafened } = {}) => ensureFriends().sendVoice({ t: 'voice_join', id, channelId, muted: muted === true, deafened: deafened === true }),
  'voice:leave': () => ensureFriends().sendVoice({ t: 'voice_leave' }),
  'voice:state': (_e, { muted, deafened } = {}) => ensureFriends().sendVoice({ t: 'voice_state', muted: muted === true, deafened: deafened === true }),
  'friends:setSetting': (_e, { key, value }) => ensureFriends().setSetting(key, value),
  'friends:reconnect': () => ensureFriends().connect(),
  'friends:wake': () => { ensureFriends().wake(); },
  'chat:state': () => ensureFriends().globalState(),
  'chat:ensure': () => ensureFriends().ensureConnected(),
  'chat:send': (_e, { text }) => ensureFriends().sendGlobal(text),
  'chat:delete': (_e, { id }) => ensureFriends().deleteGlobal(id),
  'chat:presence': (_e, { open }) => ensureFriends().setChatOpen(open),
  'online:list': () => ensureFriends().onlineList(),
  'ban:state': () => currentBan(),
  'ban:recheck': async () => {
    const b = await checkDeviceBan();
    if (!b) ensureFriends().connect();
    return b;
  },
  'mod:access': () => !!friends?.isMod,
  'mod:request': (_e, { op, id, username, uuid, duration, reason }) => {
    if (!MOD_OPS.has(op)) throw new Error('Unknown request.');
    return ensureFriends().modRequest(op, { id, username, uuid, duration, reason });
  },
  'mod:file': (_e, { id, file }) => ensureFriends().modReportFile(String(id || ''), String(file || '')),
  'report:send': (_e, { target, targetName, reason, details, context, files }) => {
    const list = (Array.isArray(files) ? files : []).slice(0, 4).map((f) => {
      const data = Buffer.from(f?.data || []);
      if (data.length > 25 * 1024 * 1024) throw new Error(`${f?.name || 'A file'} is over 25 MB.`);
      return { name: String(f?.name || 'file').slice(0, 80), data };
    });
    return ensureFriends().report({
      target: String(target || ''), targetName: String(targetName || ''), reason: String(reason || ''),
      details: String(details || ''), files: list,
      context: context && typeof context === 'object'
        ? { where: String(context.where || ''), text: String(context.text || ''), at: Number(context.at) || null } : null,
    });
  },
};
for (const [channel, fn] of Object.entries(friendsHandlers)) {
  ipcMain.handle(channel, async (e, arg) => fn(e, arg || {}));
}
// AudioWorklet modules and fetch() can't load from file:// pages, so the
// renderer gets the RNNoise worklet source and wasm through here.
let rnnoiseAssets = null;
ipcMain.handle('voice:rnnoise', () => {
  if (!rnnoiseAssets) {
    const dir = path.join(__dirname, '..', 'renderer', 'vendor', 'rnnoise');
    rnnoiseAssets = {
      worklet: fs.readFileSync(path.join(dir, 'worklet.js'), 'utf8').replace(/^\uFEFF/, ''),
      wasm: fs.readFileSync(path.join(dir, 'rnnoise.wasm')),
    };
  }
  return rnnoiseAssets;
});

ipcMain.on('voice:audio', (_e, frame) => {
  if (!friends || !frame || typeof frame.d !== 'string') return;
  friends.sendVoice({ t: 'voice_audio', d: frame.d, ts: Number(frame.ts) || 0 });
});

// Calls, screen share and webcam: the media goes straight between players
// (WebRTC). The server only carries these small setup messages.
const VOICE_SIGNALS = new Set(['voice_call_ring', 'voice_call_accept', 'voice_call_decline', 'voice_call_busy', 'voice_call_end', 'voice_rtc', 'voice_media']);
ipcMain.handle('voice:signal', (_e, f) => {
  if (!friends || !f || !VOICE_SIGNALS.has(f.t)) return false;
  const out = { t: f.t };
  if (f.to != null) out.to = String(f.to).slice(0, 40);
  if (f.callId != null) out.callId = String(f.callId).slice(0, 64);
  if (f.scope != null) out.scope = String(f.scope).slice(0, 160);
  if (f.name != null) out.name = String(f.name).slice(0, 16);
  if (f.t === 'voice_media') { out.screen = f.screen === true; out.cam = f.cam === true; }
  if (f.t === 'voice_rtc') {
    const d = JSON.stringify(f.data ?? null);
    if (d.length > 48 * 1024) return false;
    out.data = JSON.parse(d);
  }
  return friends.sendVoice(out);
});

// Screen share: the renderer shows its own picker from these, then asks for
// the stream; the request handler below hands over the picked source.
let displayPick = null;
ipcMain.handle('media:sources', async () => {
  const { desktopCapturer, screen } = require('electron');
  const displays = screen.getAllDisplays();
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 384, height: 216 }, fetchWindowIcons: true });
  return list.map((s) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id));
    return {
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : '',
      w: d ? Math.round(d.size.width * d.scaleFactor) : 0,
      h: d ? Math.round(d.size.height * d.scaleFactor) : 0,
      hz: d ? Math.round(d.displayFrequency || 0) : 0,
    };
  });
});
ipcMain.handle('media:pick', (_e, { id, audio } = {}) => {
  displayPick = { id: String(id || ''), audio: audio === true, at: Date.now() };
  return true;
});
app.whenReady().then(() => {
  const { session, desktopCapturer } = require('electron');
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const pick = displayPick;
    displayPick = null;
    if (!pick || Date.now() - pick.at > 30000) { cb({}); return; }
    try {
      const src = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })).find((s) => s.id === pick.id);
      if (!src) { cb({}); return; }
      cb(pick.audio && process.platform === 'win32' ? { video: src, audio: 'loopback' } : { video: src });
    } catch { cb({}); }
  });
});

// Incoming call while the launcher is in the background: flash the taskbar and show a Windows notification.
let callNote = null;
ipcMain.handle('call:attention', (_e, { on, title, body } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  try { callNote?.close(); } catch { /* already gone */ }
  callNote = null;
  if (!on) { mainWindow.flashFrame(false); return true; }
  if (mainWindow.isFocused()) return true;
  mainWindow.flashFrame(true);
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    callNote = new Notification({ title: String(title || '').slice(0, 80), body: String(body || '').slice(0, 160), icon: getAppIcon() || undefined, urgency: 'critical', timeoutType: 'never' });
    callNote.on('click', () => {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    callNote.show();
  }
  return true;
});

ipcMain.handle('players:lookup', async (_e, { name }) => {
  const clean = String(name || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(clean)) throw new Error('That is not a valid Minecraft username.');
  const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(clean)}`);
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`Mojang lookup failed (${res.status}).`);
  const j = await res.json();
  return { id: j.id, name: j.name };
});

ipcMain.handle('friends:joinInvite', async (_e, { inviteId }) => ensureFriends().resolveInvite(inviteId));

app.on('before-quit', () => { try { bridge?.stop(); } catch { /* fine */ } });

// =====================================================================
// SERVER PING + HOSTING
// =====================================================================
const pingCache = new Map();
ipcMain.handle('servers:ping', async (_e, { address }) => {
  const { pingServer, parseAddress } = require('./serverPing');
  const key = String(address || '').trim().toLowerCase();
  const hit = pingCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const { host, port } = parseAddress(address);
  if (!host) throw new Error('No address given.');
  try {
    const value = await pingServer(host, port);
    pingCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    const value = { offline: true, reason: err.message };
    pingCache.set(key, { at: Date.now(), value });
    return value;
  }
});

function ensureServerHost() {
  if (serverHost) return serverHost;
  const { ServerHost } = require('./serverHost');
  serverHost = new ServerHost(store, {
    rootDir: app.getPath('userData'),
    ensureJava: (major, onProgress) => ensureJava(major, onProgress),
    requiredJavaFor,
  });
  serverHost.on('changed', (snap) => broadcast('servers:changed', snap));
  serverHost.on('log', (entry) => broadcast('servers:log', entry));
  return serverHost;
}

const serverHandlers = {
  'servers:snapshot': () => ensureServerHost().snapshot(),
  'servers:create': (_e, cfg) => ensureServerHost().create(cfg),
  'servers:update': (_e, { id, patch }) => ensureServerHost().update(id, patch),
  'servers:remove': (_e, { id }) => ensureServerHost().remove(id),
  'servers:deleteFiles': (_e, { id }) => ensureServerHost().deleteFiles(id),
  'servers:acceptEula': (_e, { id }) => ensureServerHost().acceptEula(id),
  'servers:command': (_e, { id, command }) => ensureServerHost().command(id, command),
  'servers:logs': (_e, { id }) => ensureServerHost().logs(id),
  'servers:stop': (_e, { id }) => ensureServerHost().stop(id),
};
for (const [channel, fn] of Object.entries(serverHandlers)) {
  ipcMain.handle(channel, async (e, arg) => fn(e, arg || {}));
}
ipcMain.handle('servers:start', async (_e, { id }) =>
  ensureServerHost().start(id, (msg) => broadcast('servers:progress', { id, message: msg })));

app.on('before-quit', () => { try { serverHost?.stopAll(); } catch { /* best effort */ } });

ipcMain.handle('xp:get', () => xpPayload());

ipcMain.handle('leaderboard:list', async () => {
  const base = await require('./endpoints').apiBase();
  const account = getAccounts().find(a => a.id === store.get('activeAccountId'));
  const id = String(account?.id || '').replace(/-/g, '').toLowerCase();
  let payload = null;
  if (/^[0-9a-f]{32}$/.test(id) && account?.name) {
    const xp = xpPayload();
    payload = {
      id,
      name: String(account.name).slice(0, 16),
      level: xp.level,
      minutes: xp.totalXp,
    };
  }
  const res = await fetch(`${base}/leaderboard`, {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'content-type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('leaderboard unavailable');
  const data = await res.json();
  const rows = Array.isArray(data.rows) ? data.rows : [];
  return { rows, you: data.you || (payload ? payload.id : '') };
});

ipcMain.handle('xp:add', (_e, amount) => addXp(amount));
// leave phantom "logged in" sessions hanging on some server's player list.
app.on('before-quit', () => {
  for (const [, entry] of afkClients) {
    clearTimeout(entry.timeout);
    try { entry.client?.end('Launcher closed'); } catch { /* already gone */ }
  }
  afkClients.clear();
});

// A single unhandled error anywhere in main used to show Electron's
// "A JavaScript error occurred in the main process" dialog and take the
// launcher down with it — including things as minor as a failed temp-file
// delete. Log it, tell the window, keep running.
function reportMainError(kind, err) {
  const message = (err && err.message) || String(err);
  console.error(`[SolarClient] ${kind}:`, err);
  try { broadcast('main:error', { kind, message }); } catch { /* window may be gone */ }
}
process.on('uncaughtException', (err) => reportMainError('uncaughtException', err));
process.on('unhandledRejection', (err) => reportMainError('unhandledRejection', err));

// =====================================================================
// INSTANCES
// =====================================================================
ipcMain.handle('instances:list', async () => listInstances());

function listInstances() {
  const root = instancesRoot();
  const result = [];
  if (!fs.existsSync(root)) return result;
  for (const group of fs.readdirSync(root)) {
    const groupPath = path.join(root, group);
    if (!fs.statSync(groupPath).isDirectory()) continue;
    for (const name of fs.readdirSync(groupPath)) {
      const metaFile = path.join(groupPath, name, 'instance.json');
      if (fs.existsSync(metaFile)) {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
        result.push({ group, name, ...meta });
      }
    }
  }
  return result;
}

function defaultModsDir() {
  const dir = path.join(app.getPath('userData'), 'default-mods');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('settings:openDefaultModsFolder', async () => {
  const { shell } = require('electron');
  await shell.openPath(defaultModsDir());
  return true;
});

ipcMain.handle('instances:create', async (_e, { name, versionNumber, loader }) =>
  createInstance({ name, versionNumber, loader }));

async function createInstance({ name, versionNumber, loader, fromModpack }) {
  const dir = instancePath(versionNumber, name);
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'resourcepacks'), { recursive: true });
  const meta = { versionNumber, loader: loader || 'vanilla', createdAt: Date.now() };
  if (fromModpack) meta.modpack = fromModpack;
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(meta, null, 2));

  // "auto install" mechanism: anything dropped in the default-mods folder
  // (Settings → "Open default mods folder") gets copied into every new
  // Fabric/Quilt instance automatically. This is how you make your own
  // built SolarClient mod jar show up in every instance without manually
  // re-adding it each time.
  if (loader === 'fabric' || loader === 'quilt') {
    const defaults = defaultModsDir();
    for (const file of fs.readdirSync(defaults)) {
      if (file.endsWith('.jar')) {
        fs.copyFileSync(path.join(defaults, file), path.join(modsDir, file));
      }
    }
  }

  // Stage the resource pack right away too — launch:start re-checks this
  // every time (in case the user turns it off/on or the bundled pack gets
  // updated), but doing it here means it's already there and enabled the
  // very first time this instance opens, not just on the second launch.
  if (autoInstallResourcePackEnabled()) {
    try {
      installBundledResourcePack(dir, versionNumber, (line) => console.log(line));
    } catch (err) {
      console.error('[SolarClient] Resource pack auto-install failed:', err);
    }
  }

  // Pull in the SolarClient mod so a brand-new Fabric instance already has
  // it before its first launch. doLaunch() re-runs this every time, which
  // is what keeps it updated afterwards.
  try {
    await ensureSolarMod(dir, versionNumber, loader, (line) => console.log(line));
  } catch (err) {
    console.error('[SolarClient] Mod auto-install failed:', err);
  }

  return { name, group: majorFolderFor(versionNumber), ...meta };
}

ipcMain.handle('instances:delete', async (_e, { name, versionNumber }) => {
  fs.rmSync(instancePath(versionNumber, name), { recursive: true, force: true });
  return true;
});

// =====================================================================
// MODS — Modrinth API (public, no key needed).
// =====================================================================
const MODRINTH_API = 'https://api.modrinth.com/v2';

ipcMain.handle('mods:search', async (_e, { query, versionNumber, loader, projectType, source }) => {
  // Modrinth (default)
  const facets = [[`project_type:${projectType || 'mod'}`]];
  if (versionNumber) facets.push([`versions:${versionNumber}`]);
  // "vanilla" is our own internal placeholder for "no loader chosen" — it
  // isn't a real Modrinth category, so sending it as a categories facet
  // matched nothing and silently zeroed out every search for any instance
  // that didn't have Fabric/Forge/Quilt picked at creation time.
  if (loader && loader !== 'vanilla' && projectType !== 'resourcepack') facets.push([`categories:${loader}`]);

  const sort = query ? 'relevance' : 'downloads';
  const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query || '')}&index=${sort}&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const res = await chromeFetch(url);
  if (!res.ok) throw new Error(`Modrinth search failed: ${res.status}`);
  const hits = (await res.json()).hits;
  return hits.map(h => ({ ...h, source: 'modrinth' }));
});

ipcMain.handle('mods:versions', async (_e, { projectId, versionNumber, loader, source, projectType }) => {
  const query = async (withVersion) => {
    const params = new URLSearchParams();
    if (withVersion && versionNumber) params.set('game_versions', JSON.stringify([versionNumber]));
    // Resource packs are published under Modrinth's "minecraft" loader, not
    // Fabric/Forge, so filtering them by the instance's mod loader matched
    // nothing and every resource pack install failed.
    if (projectType !== 'resourcepack' && loader && loader !== 'vanilla') params.set('loaders', JSON.stringify([loader]));
    const res = await chromeFetch(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${params}`);
    if (!res.ok) throw new Error(`Modrinth versions failed: ${res.status}`);
    return res.json();
  };
  const exact = await query(true);
  // A pack tagged for 1.21.10 still loads on 1.21.11 (the game just labels
  // it "made for an older version"), so fall back to its newest release.
  if (!exact.length && projectType === 'resourcepack') return query(false);
  return exact;
});

// per-instance mod metadata, so the installed-mods list can show a real
// title + icon instead of a raw jar filename
function readModManifest(modsDir) {
  const p = path.join(modsDir, '.nebula-manifest.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return {}; }
}
function writeModManifest(modsDir, manifest) {
  fs.writeFileSync(path.join(modsDir, '.nebula-manifest.json'), JSON.stringify(manifest, null, 2));
}

ipcMain.handle('mods:install', async (_e, { fileUrl, fileName, instanceName, versionNumber, folder, installId, projectId, title, iconUrl, slug }) => {
  const targetDir = path.join(instancePath(versionNumber, instanceName), folder || 'mods');
  fs.mkdirSync(targetDir, { recursive: true });
  const res = await chromeFetch(fileUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  // Stream straight to disk instead of buffering the whole file in memory —
  // faster to first byte written, and a 500MB modpack no longer costs 500MB
  // of RAM. Written to a .part file first so a cancelled download never
  // leaves a corrupt half-jar in the mods folder.
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  let lastSent = -1;
  const finalPath = path.join(targetDir, fileName);
  const partPath = `${finalPath}.part`;
  const out = fs.createWriteStream(partPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(Buffer.from(value))) {
        await new Promise(r => out.once('drain', r));
      }
      if (total) {
        const percent = Math.round((received / total) * 100);
        if (percent !== lastSent) { // don't spam IPC every chunk
          lastSent = percent;
          mainWindow.webContents.send('mods:progress', { installId, fileName, percent });
        }
      }
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    fs.renameSync(partPath, finalPath);
  } catch (err) {
    out.destroy();
    fs.rmSync(partPath, { force: true });
    throw err;
  }

  if (projectId) {
    const manifest = readModManifest(targetDir);
    manifest[fileName] = { projectId, slug: slug || '', title: title || fileName, iconUrl: iconUrl || '' };
    writeModManifest(targetDir, manifest);
  }

  mainWindow.webContents.send('mods:progress', { installId, fileName, percent: 100, done: true });
  return true;
});

// =====================================================================
// MODPACKS — install from Modrinth, import an .mrpack, or export an
// instance as one (see modpacks.js).
// =====================================================================
let _modpacks;
const modpacks = () => (_modpacks ||= require('./modpacks').createModpacks({
  instancePath, createInstance, listInstances, readModManifest, writeModManifest,
  getAdmZip, broadcast, fetchImpl: chromeFetch,
}));

ipcMain.handle('modpacks:install', async (_e, { projectId, title, iconUrl, preferVersion, installId }) =>
  modpacks().installFromModrinth({ projectId, title, iconUrl, preferVersion, installId }));

ipcMain.handle('modpacks:import', async (_e, { installId }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import a modpack',
    properties: ['openFile'],
    filters: [{ name: 'Modrinth modpacks', extensions: ['mrpack'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return modpacks().installMrpack(result.filePaths[0], { installId });
});

ipcMain.handle('modpacks:export', async (_e, { instanceName, versionNumber, loader }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export as modpack',
    defaultPath: path.join(app.getPath('desktop'), `${instanceName.replace(/[<>:"/\\|?*]/g, '')}.mrpack`),
    filters: [{ name: 'Modrinth modpacks', extensions: ['mrpack'] }],
  });
  if (result.canceled || !result.filePath) return null;
  const out = await modpacks().exportInstance({ name: instanceName, versionNumber, loader }, result.filePath);
  require('electron').shell.showItemInFolder(out.path);
  return out;
});

// =====================================================================
// MINECRAFT VERSIONS — real list from Mojang, so instance creation is a
// dropdown instead of free text. The manifest is cached on disk (10 min
// TTL, with stale-fallback if Mojang is unreachable) so app startup and
// the Versions tab are instant instead of waiting on a network call.
// =====================================================================
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const MANIFEST_TTL_MS = 10 * 60 * 1000;
let manifestMemCache = null; // { fetchedAt, data }

async function getVersionManifest() {
  const now = Date.now();
  if (manifestMemCache && now - manifestMemCache.fetchedAt < MANIFEST_TTL_MS) {
    return manifestMemCache.data;
  }
  const cacheFile = path.join(app.getPath('userData'), 'version-manifest-cache.json');
  let diskCache = null;
  try { diskCache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { /* none yet */ }

  if (diskCache && now - diskCache.fetchedAt < MANIFEST_TTL_MS) {
    manifestMemCache = diskCache;
    return diskCache.data;
  }
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    manifestMemCache = { fetchedAt: now, data };
    fs.writeFile(cacheFile, JSON.stringify(manifestMemCache), () => {});
    return data;
  } catch (err) {
    // Offline or Mojang hiccup — serve the stale cache rather than a blank screen.
    if (diskCache) { manifestMemCache = diskCache; return diskCache.data; }
    throw new Error(`Failed to fetch version list: ${err.message}`);
  }
}

ipcMain.handle('versions:list', async () => {
  const data = await getVersionManifest();
  return data.versions
    .filter(v => v.type === 'release')
    .map(v => v.id);
});

ipcMain.handle('versions:grouped', async () => {
  const data = await getVersionManifest();
  const releases = data.versions.filter(v => v.type === 'release').map(v => v.id);

  const groups = new Map(); // "1.21.x" or "26.x" -> [versions...]
  for (const id of releases) {
    const parts = id.split('.');
    const groupKey = `${parts[0]}.${parts[1] || '0'}.x`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(id);
  }
  return Array.from(groups.entries()).map(([group, versions]) => ({ group, versions }));
});

// =====================================================================
// SKINS — a local library plus apply/upload against Mojang's profile API.
//
// Applying a skin needs the account's live Minecraft access token, which
// is exactly what getFreshAuthorization already produces for launching,
// so the same refresh path is reused rather than storing a second token.
// =====================================================================
function skinsDir() {
  const d = path.join(app.getPath('userData'), 'skins');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function skinLibrary() { return store.get('skinLibrary', []); }
function saveSkinLibrary(list) { store.set('skinLibrary', list); }

ipcMain.handle('skins:list', async () => {
  // Drop entries whose file has been deleted out from under us.
  const list = skinLibrary().filter(s => fs.existsSync(path.join(skinsDir(), s.file)));
  if (list.length !== skinLibrary().length) saveSkinLibrary(list);
  return list.map(s => ({
    ...s,
    dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(skinsDir(), s.file)).toString('base64')}`,
  }));
});

function addSkinFromBuffer(buf, name, model) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) throw new Error('That file is not a PNG.');
  const id = crypto.randomUUID();
  const file = `${id}.png`;
  fs.writeFileSync(path.join(skinsDir(), file), buf);
  const entry = { id, file, name: name || 'Skin', model: model || 'classic', addedAt: Date.now() };
  saveSkinLibrary([entry, ...skinLibrary()]);
  return entry;
}

ipcMain.handle('skins:import', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add a skin',
    filters: [{ name: 'Skin PNG', extensions: ['png'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled) return [];
  return res.filePaths.map(fp =>
    addSkinFromBuffer(fs.readFileSync(fp), path.basename(fp, '.png'), 'classic'));
});

// Used by the editor's "save to library" and by drag-and-drop.
ipcMain.handle('skins:saveDataUrl', async (_e, { dataUrl, name, model }) => {
  const b64 = String(dataUrl).split(',')[1] || '';
  return addSkinFromBuffer(Buffer.from(b64, 'base64'), name, model);
});

ipcMain.handle('skins:rename', async (_e, { id, name }) => {
  saveSkinLibrary(skinLibrary().map(s => (s.id === id ? { ...s, name } : s)));
  return true;
});

ipcMain.handle('skins:delete', async (_e, { id }) => {
  const entry = skinLibrary().find(s => s.id === id);
  if (entry) { try { fs.rmSync(path.join(skinsDir(), entry.file), { force: true }); } catch { /* already gone */ } }
  saveSkinLibrary(skinLibrary().filter(s => s.id !== id));
  return true;
});

// Fetch the account's current skin so the library can show what's live.
ipcMain.handle('skins:current', async (_e, { accountId } = {}) => {
  const account = getAccounts().find(a => a.id === (accountId || store.get('activeAccountId')));
  if (!account) throw new Error('Sign in first.');
  const auth = await getFreshAuthorization(account);
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${auth.access_token}` },
  });
  if (!res.ok) throw new Error(`Couldn't read your profile (${res.status}).`);
  const profile = await res.json();
  const skin = (profile.skins || []).find(s => s.state === 'ACTIVE');
  return skin ? { url: skin.url, model: skin.variant === 'SLIM' ? 'slim' : 'classic' } : null;
});

// Resolve a player's REAL skin texture the way NameMC does: ask Mojang's
// session server for the profile, decode the base64 textures property, and
// use the URL it hands back.
//
// This replaces mc-heads.net, which was the actual cause of the "the model
// is see-through / has bits missing" reports. When mc-heads can't resolve a
// UUID it doesn't error — it quietly returns the DEFAULT Steve skin, which
// is a legacy 64x32 texture with no second arm or leg. So the launcher was
// faithfully rendering a default skin with missing limbs while the player's
// own skin was something else entirely. The session server is
// authoritative, needs no auth, and also reports slim vs classic properly
// instead of us guessing from pixel transparency.
ipcMain.handle('skins:textureFor', async (_e, { uuid }) => {
  const clean = String(uuid || '').replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(clean)) throw new Error('Not a valid player UUID.');

  // no-store: a cached profile is exactly how an old skin keeps showing.
  const res = await chromeFetch(`https://sessionserver.mojang.com/session/minecraft/profile/${clean}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Mojang profile lookup failed (${res.status}).`);
  const profile = await res.json();

  const prop = (profile.properties || []).find(p => p.name === 'textures');
  if (!prop) throw new Error('That profile has no skin data.');
  const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
  const skin = decoded.textures && decoded.textures.SKIN;
  if (!skin || !skin.url) return { dataUrl: null, model: 'classic', isDefault: true };

  const img = await chromeFetch(skin.url.replace(/^http:/, 'https:'));
  if (!img.ok) throw new Error(`Couldn't download the skin (${img.status}).`);
  const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');

  return {
    dataUrl: `data:image/png;base64,${b64}`,
    model: skin.metadata && skin.metadata.model === 'slim' ? 'slim' : 'classic',
    isDefault: false,
  };
});

ipcMain.handle('skins:apply', async (_e, { id, model, accountId }) => {
  const account = getAccounts().find(a => a.id === (accountId || store.get('activeAccountId')));
  if (!account) throw new Error('Sign in first.');
  const entry = skinLibrary().find(s => s.id === id);
  if (!entry) throw new Error('That skin is no longer in your library.');

  const auth = await getFreshAuthorization(account);
  const png = fs.readFileSync(path.join(skinsDir(), entry.file));

  const form = new FormData();
  form.append('variant', (model || entry.model) === 'slim' ? 'slim' : 'classic');
  form.append('file', new Blob([png], { type: 'image/png' }), 'skin.png');

  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.access_token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Session expired — remove and re-add the account in Settings.');
    throw new Error(`Mojang rejected the skin (${res.status})${body ? ' — ' + body.slice(0, 140) : ''}`);
  }
  saveSkinLibrary(skinLibrary().map(s => ({ ...s, model: s.id === id ? (model || s.model) : s.model })));
  return { ok: true };
});

// =====================================================================
// SYNC BETWEEN INSTANCES — carry your setup to a new version without
// rebuilding it by hand. Mods are re-resolved rather than copied: a jar
// built for 1.20.1 will not run on 1.21, so each mod is looked up by its
// Modrinth project id and the build matching the TARGET version/loader is
// downloaded. Resource packs are copied as-is, because pack format
// mismatches are usually cosmetic and most packs work across versions —
// so the user gets them either way and can judge for themselves.
// Nothing is ever removed from the source instance.
// =====================================================================
ipcMain.handle('instances:syncPreview', async (_e, { from }) => {
  const dir = instancePath(from.versionNumber, from.name);
  const [mods, packs] = await Promise.all([
    listInstalledFiles(path.join(dir, 'mods'), 'jar', true),
    listInstalledFiles(path.join(dir, 'resourcepacks'), 'zip', false),
  ]);
  return { mods, packs };
});

// Fabric mods aren't Forge mods and nothing loads on vanilla. Quilt runs
// Fabric mods, so that one direction is allowed; everything else is not.
function loadersCompatibleForMods(a, b) {
  const x = (a || 'vanilla').toLowerCase();
  const y = (b || 'vanilla').toLowerCase();
  return x === y || (x === 'fabric' && y === 'quilt');
}

ipcMain.handle('instances:sync', async (_e, { from, to, includeMods, includePacks, syncId }) => {
  if (includeMods && !loadersCompatibleForMods(from.loader, to.loader)) {
    throw new Error(`${from.loader} mods can't run on ${to.loader}.`);
  }
  const srcDir = instancePath(from.versionNumber, from.name);
  const dstDir = instancePath(to.versionNumber, to.name);
  const results = { copied: [], upgraded: [], skipped: [] };

  const report = (label, done, total) => {
    broadcast('sync:progress', { syncId, label, done, total });
  };

  const jobs = [];
  if (includeMods) {
    for (const m of await listInstalledFiles(path.join(srcDir, 'mods'), 'jar', true)) jobs.push({ kind: 'mod', item: m });
  }
  if (includePacks) {
    for (const p of await listInstalledFiles(path.join(srcDir, 'resourcepacks'), 'zip', false)) jobs.push({ kind: 'pack', item: p });
  }

  let done = 0;
  for (const job of jobs) {
    const { kind, item } = job;
    report(item.title || item.fileName, done, jobs.length);
    try {
      if (kind === 'pack') {
        // Version-agnostic on purpose.
        const targetDir = path.join(dstDir, 'resourcepacks');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(path.join(srcDir, 'resourcepacks', item.fileName), path.join(targetDir, item.fileName));
        const man = readModManifest(targetDir);
        const srcMan = readModManifest(path.join(srcDir, 'resourcepacks'));
        if (srcMan[item.fileName]) { man[item.fileName] = srcMan[item.fileName]; writeModManifest(targetDir, man); }
        results.copied.push(item.title || item.fileName);
      } else {
        const targetDir = path.join(dstDir, 'mods');
        fs.mkdirSync(targetDir, { recursive: true });

        // Same MC version and loader? The existing jar is already correct.
        if (from.versionNumber === to.versionNumber && (from.loader || 'vanilla') === (to.loader || 'vanilla')) {
          fs.copyFileSync(path.join(srcDir, 'mods', item.fileName), path.join(targetDir, item.fileName));
          const man = readModManifest(targetDir);
          const srcMan = readModManifest(path.join(srcDir, 'mods'));
          if (srcMan[item.fileName]) { man[item.fileName] = srcMan[item.fileName]; writeModManifest(targetDir, man); }
          results.copied.push(item.title || item.fileName);
        } else if (!item.projectId) {
          // No project id means we can't find its sibling build, and
          // copying a jar across versions is how you get a crash on boot.
          results.skipped.push({ title: item.title || item.fileName, reason: 'not found on Modrinth' });
        } else {
          const params = new URLSearchParams();
          params.set('game_versions', JSON.stringify([to.versionNumber]));
          const targetLoader = to.loader === 'quilt' ? ['quilt', 'fabric'] : [to.loader];
          if (to.loader && to.loader !== 'vanilla') params.set('loaders', JSON.stringify(targetLoader));
          const res = await chromeFetch(`${MODRINTH_API}/project/${item.projectId}/version?${params}`);
          const versions = res.ok ? await res.json() : [];
          if (!versions.length) {
            results.skipped.push({ title: item.title || item.fileName, reason: `no ${to.loader} build for ${to.versionNumber}` });
          } else {
            const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
            // Streamed: this runs in a loop over every mod in an instance, so
            // buffering each jar into RAM and then blocking on writeFileSync
            // froze the UI once per mod for the whole batch.
            await streamToFile(file.url, path.join(targetDir, file.filename));
            const man = readModManifest(targetDir);
            man[file.filename] = { projectId: item.projectId, title: item.title, iconUrl: item.iconUrl || '' };
            writeModManifest(targetDir, man);
            results.upgraded.push(item.title || item.fileName);
          }
        }
      }
    } catch (err) {
      results.skipped.push({ title: item.title || item.fileName, reason: err.message });
    }
    done++;
    report(item.title || item.fileName, done, jobs.length);
  }

  return results;
});

// =====================================================================
// LOADER AVAILABILITY — which Minecraft versions each loader actually
// ships for. The version picker used to offer every release for every
// loader, so you could ask for "Fabric on 1.0" and only find out it was
// impossible after the instance was created and the launch failed.
// Fabric and Quilt publish a supported-game-version list; Forge's is
// derived from the same promotions file the installer already reads, so
// the picker can only offer builds ensureLoaderInstalled() can deliver.
// =====================================================================
const LOADER_VERSIONS_TTL_MS = 6 * 60 * 60 * 1000;
const loaderVersionsMem = new Map(); // loader -> { fetchedAt, versions }

async function fetchLoaderGameVersions(loader) {
  if (loader === 'fabric' || loader === 'quilt') {
    const url = loader === 'fabric'
      ? 'https://meta.fabricmc.net/v2/versions/game'
      : 'https://meta.quiltmc.org/v3/versions/game';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const list = await res.json();
    return list.map(v => v && v.version).filter(Boolean);
  }
  if (loader === 'forge') {
    const res = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const out = new Set();
    for (const key of Object.keys(data.promos || {})) {
      const mc = key.replace(/-(recommended|latest)$/, '');
      if (mc) out.add(mc);
    }
    return Array.from(out);
  }
  return null;
}

// Loaders didn't exist for the whole history of Minecraft, and their meta
// APIs are not honest about it: Quilt's loader is "version agnostic", so
// its endpoint happily returns a build for 1.0 even though the loader has
// never worked below 1.19. Hard floors, applied on top of whatever the meta
// API says.
const LOADER_MIN_VERSION = {
  fabric: '1.14',   // Fabric's first supported release
  quilt: '1.19',    // Quilt has never shipped support below this
  // Forge goes all the way back, so there's no floor for it.
};

// Compare Minecraft version strings numerically, component by component.
// Works for both the old 1.x scheme and the newer year-based numbers.
function compareMcVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10));
  const pb = String(b).split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (Number.isNaN(x) || x === undefined) return Number.isNaN(y) || y === undefined ? 0 : -1;
    if (Number.isNaN(y) || y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

function meetsLoaderFloor(loader, mcVersion) {
  const floor = LOADER_MIN_VERSION[loader];
  if (!floor) return true;
  // Snapshots and anything unparseable fall through rather than being
  // wrongly hidden.
  if (!/^\d+(\.\d+)*$/.test(String(mcVersion))) return true;
  return compareMcVersions(mcVersion, floor) >= 0;
}

// Returns an array of supported Minecraft versions, or null meaning
// "couldn't find out" — the UI treats null as "don't filter" so a flaky
// network shows too many versions rather than an empty picker.
ipcMain.handle('loaders:gameVersions', async (_e, loader) => {
  if (!loader || loader === 'vanilla') return null;
  const now = Date.now();
  const mem = loaderVersionsMem.get(loader);
  if (mem && now - mem.fetchedAt < LOADER_VERSIONS_TTL_MS) return mem.versions;
  const applyFloor = (list) => (Array.isArray(list) ? list.filter(v => meetsLoaderFloor(loader, v)) : list);

  const cacheFile = path.join(app.getPath('userData'), `loader-versions-${loader}.json`);
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')); } catch { /* none yet */ }
  if (disk && now - disk.fetchedAt < LOADER_VERSIONS_TTL_MS) {
    disk.versions = applyFloor(disk.versions);
    loaderVersionsMem.set(loader, disk);
    return disk.versions;
  }

  try {
    let versions = await fetchLoaderGameVersions(loader);
    if (Array.isArray(versions)) versions = versions.filter(v => meetsLoaderFloor(loader, v));
    const entry = { fetchedAt: now, versions };
    loaderVersionsMem.set(loader, entry);
    fs.writeFile(cacheFile, JSON.stringify(entry), () => {});
    return versions;
  } catch {
    if (disk) { disk.versions = applyFloor(disk.versions); loaderVersionsMem.set(loader, disk); return disk.versions; }
    return null;
  }
});

// =====================================================================
// PER-INSTANCE MOD MANAGEMENT — list what's actually installed, and
// enable/disable by renaming file <-> file.disabled (the same convention
// Fabric/Forge/Quilt all already understand).
// =====================================================================
ipcMain.handle('mods:importFile', async (_e, { instanceName, versionNumber, folder }) => {
  const isResourcePack = folder === 'resourcepacks';
  const result = await dialog.showOpenDialog(mainWindow, {
    title: isResourcePack ? 'Add a resource pack' : 'Add a mod',
    properties: ['openFile', 'multiSelections'],
    filters: isResourcePack
      ? [{ name: 'Resource packs', extensions: ['zip'] }]
      : [{ name: 'Mods', extensions: ['jar'] }],
  });
  if (result.canceled || !result.filePaths.length) return { imported: [] };

  const targetDir = path.join(instancePath(versionNumber, instanceName), folder || 'mods');
  fs.mkdirSync(targetDir, { recursive: true });

  const manifest = readModManifest(targetDir);
  const imported = [];
  for (const src of result.filePaths) {
    const fileName = path.basename(src);
    const destPath = path.join(targetDir, fileName);
    await fsp.copyFile(src, destPath);
    imported.push(fileName);

    // Manually-added jars have no title/icon on their own. If it's a known
    // Modrinth file, look it up by SHA1 (the same hash Modrinth already
    // indexes every file under) so it shows up with a real name and icon
    // just like mods installed through Browse & Install.
    if (!isResourcePack) {
      try {
        const hash = await hashFileStream(destPath, 'sha1');
        const verRes = await chromeFetch(`${MODRINTH_API}/version_file/${hash}?algorithm=sha1`);
        if (verRes.ok) {
          const version = await verRes.json();
          const projRes = await chromeFetch(`${MODRINTH_API}/project/${version.project_id}`);
          if (projRes.ok) {
            const project = await projRes.json();
            manifest[fileName] = {
              projectId: project.id,
              title: project.title || fileName,
              iconUrl: project.icon_url || '',
            };
          }
        }
      } catch {
        // Not on Modrinth, or offline — falls back to showing the raw
        // filename with a placeholder icon, same as before.
      }
    }
  }
  writeModManifest(targetDir, manifest);
  return { imported };
});

// Shared by mods and resource packs: lists whatever's in a folder, using
// the .jar/.jar.disabled convention where enable/disable makes sense
// (mods) and skipping it where it doesn't (resource packs are toggled
// in-game, not by renaming the file).
async function listInstalledFiles(dir, ext, supportsDisable) {
  if (!fs.existsSync(dir)) return [];
  const manifest = readModManifest(dir);
  const pattern = supportsDisable
    ? (f) => f.endsWith(`.${ext}`) || f.endsWith(`.${ext}.disabled`)
    : (f) => f.endsWith(`.${ext}`);
  const files = fs.readdirSync(dir).filter(pattern);

  let changed = false;
  const unknown = files.filter(f => !manifest[f.replace(/\.disabled$/, '')]);
  await Promise.all(unknown.map(async (f) => {
    const fileName = f.replace(/\.disabled$/, '');
    try {
      const filePath = path.join(dir, f);
      // PERF: this sat inside Promise.all(...map()), so an instance with
      // fifty unrecognised jars did fifty blocking whole-file reads in a
      // row with nothing yielding in between -- a multi-second freeze on
      // opening the Content tab. Streaming hashes actually interleave.
      const hash = await hashFileStream(filePath, 'sha1');
      const verRes = await chromeFetch(`${MODRINTH_API}/version_file/${hash}?algorithm=sha1`);
      if (!verRes.ok) return;
      const version = await verRes.json();
      const projRes = await chromeFetch(`${MODRINTH_API}/project/${version.project_id}`);
      if (!projRes.ok) return;
      const project = await projRes.json();
      manifest[fileName] = { projectId: project.id, slug: project.slug || '', title: project.title || fileName, iconUrl: project.icon_url || '' };
      changed = true;
    } catch {
      // Not on Modrinth, or offline — leave it showing the raw filename.
    }
  }));
  // Repair entries that ARE in the manifest but have no icon. The
  // performance-stack installer wrote `iconUrl: ''` for everything it
  // installed, and the backfill above only looks at files the manifest has
  // never seen — so those mods were stuck showing a blank placeholder
  // forever while browse-installed ones looked fine. Modrinth takes a bulk
  // id lookup, so this is one request no matter how many need fixing.
  const needIcon = Object.entries(manifest)
    .filter(([, m]) => m && m.projectId && !m.iconUrl)
    .map(([, m]) => m.projectId);
  if (needIcon.length) {
    try {
      const ids = JSON.stringify([...new Set(needIcon)]);
      const res = await chromeFetch(`${MODRINTH_API}/projects?ids=${encodeURIComponent(ids)}`);
      if (res.ok) {
        const projects = await res.json();
        // Manifests written by older builds put the SLUG in projectId, and
        // Modrinth answers with both, so index on both or half the lookups
        // silently miss and the icons stay blank.
        const byId = new Map();
        for (const p of projects) {
          if (p.id) byId.set(p.id, p);
          if (p.slug) byId.set(p.slug, p);
        }
        for (const meta of Object.values(manifest)) {
          const proj = meta && meta.projectId && byId.get(meta.projectId);
          if (!proj) continue;
          if (proj.icon_url) { meta.iconUrl = proj.icon_url; changed = true; }
          if (!meta.title && proj.title) { meta.title = proj.title; changed = true; }
          if (!meta.slug && proj.slug) { meta.slug = proj.slug; changed = true; }
        }
      }
    } catch {
      // Offline — placeholders stay until next time, which is fine.
    }
  }

  if (changed) writeModManifest(dir, manifest);

  return files.map(f => {
    const fileName = f.replace(/\.disabled$/, '');
    const meta = manifest[fileName];
    return {
      fileName,
      enabled: !f.endsWith('.disabled'),
      title: meta?.title || fileName,
      iconUrl: meta?.iconUrl || '',
      projectId: meta?.projectId || null,
    };
  });
}

ipcMain.handle('instances:listMods', async (_e, { name, versionNumber }) => {
  const modsDir = path.join(instancePath(versionNumber, name), 'mods');
  return listInstalledFiles(modsDir, 'jar', true);
});

// Resource packs get their own list — previously they were installed
// into resourcepacks/ but never shown anywhere in the UI once in place.
ipcMain.handle('instances:listResourcePacks', async (_e, { name, versionNumber }) => {
  const packsDir = path.join(instancePath(versionNumber, name), 'resourcepacks');
  return listInstalledFiles(packsDir, 'zip', false);
});

ipcMain.handle('instances:toggleMod', async (_e, { name, versionNumber, fileName, enable }) => {
  const modsDir = path.join(instancePath(versionNumber, name), 'mods');
  const enabledPath = path.join(modsDir, fileName);
  const disabledPath = path.join(modsDir, `${fileName}.disabled`);
  if (enable && fs.existsSync(disabledPath)) fs.renameSync(disabledPath, enabledPath);
  if (!enable && fs.existsSync(enabledPath)) fs.renameSync(enabledPath, disabledPath);
  return true;
});

// Permanently removes a mod's jar from disk (both the enabled and
// .disabled forms, whichever exists) and drops its manifest entry so it
// doesn't leave a stale icon/title behind for a file that no longer
// exists. This is a real delete, not a toggle — there's no undo.
ipcMain.handle('mods:delete', async (_e, { name, versionNumber, fileName, folder }) => {
  const dir = path.join(instancePath(versionNumber, name), folder || 'mods');
  const enabledPath = path.join(dir, fileName);
  const disabledPath = path.join(dir, `${fileName}.disabled`);
  let removed = false;
  if (fs.existsSync(enabledPath)) { fs.rmSync(enabledPath); removed = true; }
  if (fs.existsSync(disabledPath)) { fs.rmSync(disabledPath); removed = true; }
  try {
    const manifest = readModManifest(dir);
    if (manifest[fileName]) { delete manifest[fileName]; writeModManifest(dir, manifest); }
  } catch { /* manifest may not exist */ }
  return { removed };
});

// Drag-and-drop import: a batch of raw file paths (from a renderer drop
// event) instead of a picked-by-dialog file. Jars go to mods/, zips go
// to resourcepacks/ — same Modrinth hash lookup as the "+ From file"
// button gets them, so a dropped-in file shows a real name/icon too.
async function importFilesInto(targetDir, srcPaths, isResourcePack) {
  fs.mkdirSync(targetDir, { recursive: true });
  const manifest = readModManifest(targetDir);
  const imported = [];
  for (const src of srcPaths) {
    const fileName = path.basename(src);
    const destPath = path.join(targetDir, fileName);
    try { await fsp.copyFile(src, destPath); } catch { continue; }
    imported.push(fileName);
    if (!isResourcePack) {
      try {
        const hash = await hashFileStream(destPath, 'sha1');
        const verRes = await chromeFetch(`${MODRINTH_API}/version_file/${hash}?algorithm=sha1`);
        if (verRes.ok) {
          const version = await verRes.json();
          const projRes = await chromeFetch(`${MODRINTH_API}/project/${version.project_id}`);
          if (projRes.ok) {
            const project = await projRes.json();
            manifest[fileName] = { projectId: project.id, slug: project.slug || '', title: project.title || fileName, iconUrl: project.icon_url || '' };
          }
        }
      } catch { /* not on Modrinth, or offline */ }
    }
  }
  writeModManifest(targetDir, manifest);
  return imported;
}

ipcMain.handle('mods:importPaths', async (_e, { instanceName, versionNumber, paths }) => {
  const jarPaths = (paths || []).filter(p => p.toLowerCase().endsWith('.jar'));
  const zipPaths = (paths || []).filter(p => p.toLowerCase().endsWith('.zip'));
  const imported = [];
  if (jarPaths.length) {
    imported.push(...await importFilesInto(path.join(instancePath(versionNumber, instanceName), 'mods'), jarPaths, false));
  }
  if (zipPaths.length) {
    imported.push(...await importFilesInto(path.join(instancePath(versionNumber, instanceName), 'resourcepacks'), zipPaths, true));
  }
  return { imported, skipped: (paths || []).length - jarPaths.length - zipPaths.length };
});

// =====================================================================
// JAVA — instead of trusting whatever "java" resolves to on the user's
// PATH (which is exactly what broke earlier: an old Java 8 shadowing a
// newer install), we download and keep our own known-good Java runtime
// per major version, same approach real launchers use. Source: Adoptium
// (Eclipse Temurin), a free, open-source, official OpenJDK build service.
//   1.17+   needs Java 16+
//   1.18+   needs Java 17+
//   1.20.5+ needs Java 21+
// =====================================================================
// Same treatment: these two are only reached when a JDK actually has to be
// unpacked, which happens once, the first time a given Java major is needed.
let _AdmZip = null, _tar = null;
const getAdmZip = () => (_AdmZip ||= require('adm-zip'));
const getTar = () => (_tar ||= require('tar'));

function requiredJavaFor(versionNumber) {
  const [maj, min] = versionNumber.split('.').map(Number);
  // Minecraft moved to year-based versioning (26.1, 26.2, ...) starting
  // in 2026 — anything with a major version above 1 is from that scheme
  // and is newer than even 1.21.x. Mojang bumped the Java requirement to
  // 25 for this generation (1.21.11 was the final 1.x release and the
  // last to require only Java 21).
  if (maj >= 2) return 25;
  if (maj === 1 && min >= 20) return 21; // 1.20.5+ through 1.21.11
  if (maj === 1 && min >= 18) return 17;
  if (maj === 1 && min >= 17) return 16;
  return 8;
}

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}
function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  return 'x64';
}

function findJavaExecutable(dir) {
  const target = process.platform === 'win32' ? 'java.exe' : 'java';
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === target && current.endsWith('bin')) return full;
    }
  }
  return null;
}

async function ensureJava(majorVersion, onProgress) {
  const bundleDir = path.join(app.getPath('userData'), 'java', String(majorVersion));
  const existing = fs.existsSync(bundleDir) ? findJavaExecutable(bundleDir) : null;
  if (existing) return existing;

  onProgress?.(`Downloading Java ${majorVersion} (first time only, ~180MB)…`, 0);
  const url = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/${adoptiumOs()}/${adoptiumArch()}/jre/hotspot/normal/eclipse`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download Java ${majorVersion} (status ${res.status}). Install it manually from adoptium.net instead.`);

  fs.mkdirSync(bundleDir, { recursive: true });
  const isZip = adoptiumOs() === 'windows';
  const archivePath = path.join(bundleDir, isZip ? 'java.zip' : 'java.tar.gz');

  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const fileStream = fs.createWriteStream(archivePath);
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    fileStream.write(Buffer.from(value));
    if (total) onProgress?.(`Downloading Java ${majorVersion}…`, Math.round((received / total) * 100));
  }
  await new Promise((resolve) => fileStream.end(resolve));

  onProgress?.('Extracting Java…', null);
  if (isZip) {
    new (getAdmZip())(archivePath).extractAllTo(bundleDir, true);
  } else {
    await getTar().x({ file: archivePath, cwd: bundleDir });
  }
  fs.unlinkSync(archivePath);

  const javaPath = findJavaExecutable(bundleDir);
  if (!javaPath) throw new Error(`Downloaded Java ${majorVersion} but couldn't find the executable afterward — try deleting the "java" folder in the app data directory and relaunching.`);
  return javaPath;
}

// One-click fix for "Java runtime is broken" style crashes: wipes our
// bundled copy for that major version (a half-finished download or a
// bad extract is the usual cause) and re-downloads it fresh. Progress
// is broadcast so the crash banner's "Fix it" button can show a spinner.
async function reinstallJava(javaMajor, onProgress) {
  const bundleDir = path.join(app.getPath('userData'), 'java', String(javaMajor));
  if (fs.existsSync(bundleDir)) fs.rmSync(bundleDir, { recursive: true, force: true });
  try {
    return await ensureJava(javaMajor, onProgress);
  } catch (err) {
    throw new Error(`Couldn't download Java ${javaMajor}: ${err.message}`);
  }
}

ipcMain.handle('crash:fixJava', async (_e, { javaMajor }) => {
  const javaPath = await reinstallJava(javaMajor, (msg, percent) => {
    broadcast('fix:progress', { label: msg, percent: percent ?? null });
  });
  return { ok: true, javaPath };
});


// =====================================================================
// MOD LOADER INSTALLATION — this was the actual bug behind "mods don't
// do anything": picking "Fabric" as a loader only ever saved a label in
// instance.json, but launch:start always launched plain vanilla. Fabric
// and Quilt both publish a "profile json" (the same file their own
// installers generate) via a public meta API — we fetch that and drop
// it into the instance's own versions/ folder, then hand its version id
// to minecraft-launcher-core via the `custom` option, which is exactly
// the mechanism mclc expects for loader support.
//   Forge is NOT handled yet — it needs its actual installer jar run,
//   which is a different (heavier) mechanism. Vanilla/Fabric/Quilt work.
// =====================================================================
const LOADER_META = {
  fabric: 'https://meta.fabricmc.net/v2/versions/loader',
  quilt: 'https://meta.quiltmc.org/v3/versions/loader',
};

// Forge uses a different API — find the recommended/latest build for a MC version
async function getForgeVersion(mcVersion) {
  const res = await fetch(`https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`);
  if (!res.ok) throw new Error(`Couldn't fetch Forge versions (${res.status})`);
  const data = await res.json();
  const key = `${mcVersion}-recommended`;
  const key2 = `${mcVersion}-latest`;
  const forgeVer = data.promos[key] || data.promos[key2];
  if (!forgeVer) throw new Error(`No Forge build found for Minecraft ${mcVersion}`);
  return forgeVer;
}

// =====================================================================
// FORGE
//
// The previous implementation fetched
//   .../forge-<mc>-<ver>-client.json
// from Forge's maven. That file has never existed — Forge does not publish
// a ready-made version JSON, which is why every Forge launch died with a
// 404 regardless of version.
//
// Forge ships an installer JAR. The version JSON lives inside it, and from
// 1.13 onward the installer also has to run "processors" that patch the
// vanilla client jar — a step that cannot be reproduced by downloading a
// file, it has to actually execute. So we download the installer and run
// it with --installClient, which is what the official launcher does too.
// =====================================================================
function findForgeVersionDir(instanceDir, mcVersion, forgeVer) {
  const versionsDir = path.join(instanceDir, 'versions');
  if (!fs.existsSync(versionsDir)) return null;
  // Forge has used a few naming schemes over the years
  // (1.20.1-forge-47.2.0, 1.12.2-forge1.12.2-14.23.5.2859, ...), so match
  // loosely on "contains forge and both version numbers" rather than
  // guessing one exact string.
  const candidates = fs.readdirSync(versionsDir).filter((d) => {
    const lower = d.toLowerCase();
    return lower.includes('forge') && d.includes(mcVersion)
      && fs.existsSync(path.join(versionsDir, d, `${d}.json`));
  });
  if (!candidates.length) return null;
  if (!forgeVer) return candidates[0];
  return candidates.find(d => d.includes(forgeVer)) || candidates[0];
}

async function ensureForgeInstalled(instanceDir, mcVersion, onProgress) {
  // Warm path: any forge-*mcVersion* profile already on disk → zero network.
  // Promotions JSON is only needed when we still have to install.
  const already = findForgeVersionDir(instanceDir, mcVersion, null);
  if (already) return already;

  onProgress?.(`Finding Forge for ${mcVersion}…`, null);
  const forgeVer = await getForgeVersion(mcVersion);

  const existing = findForgeVersionDir(instanceDir, mcVersion, forgeVer);
  if (existing) return existing;

  // The installer is a Java program, so we need a JRE before anything else.
  onProgress?.('Preparing Java for the Forge installer…', null);
  const javaPath = await ensureJava(requiredJavaFor(mcVersion), onProgress);

  const installerName = `forge-${mcVersion}-${forgeVer}-installer.jar`;
  const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${forgeVer}/${installerName}`;
  const installerPath = path.join(app.getPath('userData'), 'cache', installerName);

  if (!fs.existsSync(installerPath)) {
    onProgress?.(`Downloading Forge ${forgeVer} installer…`, null);
    // Streamed rather than buffered-then-writeFileSync'd: the Forge
    // installer is tens of megabytes, and a synchronous write of that size
    // stalls every IPC reply for its whole duration.
    try {
      await streamToFile(installerUrl, installerPath);
    } catch (err) {
      throw new Error(
        err.status === 404
          ? `Forge ${forgeVer} has no installer published for Minecraft ${mcVersion}. Forge usually lags behind new Minecraft releases by a few weeks.`
          : `Couldn't download the Forge installer (${err.message}).`,
      );
    }
  }

  // The installer refuses to run against a directory that doesn't look like
  // a Minecraft install — it reads (and rewrites) launcher_profiles.json.
  // A stub is enough; we never use the profiles it writes.
  const profilesPath = path.join(instanceDir, 'launcher_profiles.json');
  fs.mkdirSync(instanceDir, { recursive: true });
  if (!fs.existsSync(profilesPath)) {
    fs.writeFileSync(profilesPath, JSON.stringify({ profiles: {}, version: 3 }, null, 2));
  }

  onProgress?.(`Installing Forge ${forgeVer} — this can take a minute…`, null);
  await new Promise((resolve, reject) => {
    const proc = spawn(javaPath, ['-jar', installerPath, '--installClient', instanceDir], {
      cwd: instanceDir,
      windowsHide: true,
    });
    let log = '';
    proc.stdout.on('data', (d) => {
      log += d.toString();
      const line = d.toString().trim().split('\n').pop();
      if (line) onProgress?.(`Forge: ${line.slice(0, 90)}`, null);
    });
    proc.stderr.on('data', (d) => { log += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Couldn't start the Forge installer: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = log.trim().split('\n').slice(-4).join(' | ').slice(0, 300);
      reject(new Error(`The Forge installer failed (exit ${code})${tail ? ` — ${tail}` : ''}`));
    });
  });

  const versionId = findForgeVersionDir(instanceDir, mcVersion, forgeVer);
  if (!versionId) {
    throw new Error('The Forge installer finished but produced no version profile. Try deleting the instance and creating it again.');
  }
  return versionId;
}

async function ensureLoaderInstalled(loader, instanceDir, mcVersion, onProgress) {
  if (loader === 'vanilla' || !loader) return null;

  if (loader === 'forge') {
    return ensureForgeInstalled(instanceDir, mcVersion, onProgress);
  }

  if (!meetsLoaderFloor(loader, mcVersion)) {
    throw new Error(`${loader[0].toUpperCase()}${loader.slice(1)} doesn't support Minecraft ${mcVersion} — it only works on ${LOADER_MIN_VERSION[loader]} and newer.`);
  }

  const metaBase = LOADER_META[loader];
  if (!metaBase) {
    throw new Error(`${loader} isn't supported yet — use Vanilla, Fabric, Quilt, or Forge.`);
  }

  // Warm path: profile already on disk → skip meta fetch entirely.
  // Folder name is `${loader}-loader-${loaderVersion}-${mcVersion}`.
  {
    const versionsDir = path.join(instanceDir, 'versions');
    if (fs.existsSync(versionsDir)) {
      const prefix = `${loader}-loader-`;
      const suffix = `-${mcVersion}`;
      const hit = fs.readdirSync(versionsDir).find((d) => {
        if (!d.startsWith(prefix) || !d.endsWith(suffix)) return false;
        return fs.existsSync(path.join(versionsDir, d, `${d}.json`));
      });
      if (hit) return hit;
    }
  }

  onProgress?.(`Checking ${loader} loader versions…`, null);
  const listRes = await fetch(`${metaBase}/${mcVersion}`);
  if (!listRes.ok) throw new Error(`Couldn't find a ${loader} loader for Minecraft ${mcVersion} (status ${listRes.status}).`);
  const list = await listRes.json();
  if (!list.length) throw new Error(`No ${loader} loader is published for Minecraft ${mcVersion} yet.`);
  // Loader meta lists newest first. Fabric marks releases with a boolean
  // `stable` flag and we honour it. Quilt has no such flag and ships betas
  // as its current build — my previous "skip anything with beta/rc in the
  // name" rule therefore forced Quilt back onto an ancient loader, which is
  // how you end up with "Unsupported class file major version" on a new
  // Minecraft: the old loader's bundled ASM can't read the game's classes.
  const hasStableFlag = list.some(l => typeof l.loader?.stable === 'boolean');
  const chosen = hasStableFlag ? (list.find(l => l.loader.stable) || list[0]) : list[0];
  const loaderVersion = chosen.loader.version;

  const versionId = `${loader}-loader-${loaderVersion}-${mcVersion}`;
  const versionDir = path.join(instanceDir, 'versions', versionId);
  const versionJsonPath = path.join(versionDir, `${versionId}.json`);

  if (!fs.existsSync(versionJsonPath)) {
    onProgress?.(`Installing ${loader} ${loaderVersion}…`, null);
    const profileRes = await fetch(`${metaBase}/${mcVersion}/${loaderVersion}/profile/json`);
    if (!profileRes.ok) {
      const body = await profileRes.text().catch(() => '');
      throw new Error(`Couldn't download the ${loader} profile for ${mcVersion} (HTTP ${profileRes.status})${body ? ` — ${body.slice(0, 160)}` : ''}`);
    }
    const profile = await profileRes.json();
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(versionJsonPath, JSON.stringify(profile, null, 2));
  }

  return versionId;
}

// Tuned G1GC flags used by most performance-focused launchers/servers.
// Fewer and shorter GC pauses = fewer in-game stutters, especially with
// mods. Applied only when "Performance mode" is on.
// NOTE: several of these are experimental VM options — the JVM refuses to
// start unless -XX:+UnlockExperimentalVMOptions comes FIRST (this was the
// "Could not create the Java Virtual Machine" crash).
const PERF_JVM_ARGS = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  // Four collectors, not eight. Eight froze the counter down at ~100.
  // Two left collection running so long the score sat near 700 instead of ~1000.
  '-XX:ParallelGCThreads=4',
  '-XX:ConcGCThreads=2',
  '-XX:MaxGCPauseMillis=30',
  '-XX:+PerfDisableSharedMem',
  '-XX:G1HeapRegionSize=16M',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1ReservePercent=20',
  '-XX:SurvivorRatio=32',
  '-XX:+DisableExplicitGC',
  '-XX:MaxTenuringThreshold=1',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:G1HeapWastePercent=5',
];

// The heap is committed up front. Compile thresholds stay at the JDK
// defaults. Forcing methods to compile after a few dozen calls, then
// freezing them after two tries, left the game stuck near 100. Four
// compiler threads clear that queue. The normal threshold is a real
// profile, so the counter is not kicked by a recompile every second.
const FPS_WARMUP_JVM_ARGS = [
  '-XX:+AlwaysPreTouch',
  '-XX:ReservedCodeCacheSize=384m',
  '-XX:CICompilerCount=4',
];

function perfJvmArgs(versionNumber, maxGB) {
  void versionNumber;
  void maxGB;
  // G1 with the heap already resident is what Prism, Modrinth and Aikar's
  // flags use for a steady counter. Generational ZGC stays off this path:
  // its allocation stalls are the multi-hundred FPS drops.
  return [...PERF_JVM_ARGS, ...FPS_WARMUP_JVM_ARGS];
}

// Windows: the bundled game JRE's cacerts often cannot validate Mojang's
// TLS chain on machines with AV HTTPS inspection / incomplete CA stores.
// That surfaces in-game as "authentication servers are currently not
// reachable" on multiplayer join (PKIX path building failed). Point Java
// at the Windows root store — same fix that makes sessionserver reachable
// from a JDK that already trusts the OS certs.
const WINDOWS_SSL_JVM_ARGS = [
  '-Djavax.net.ssl.trustStoreType=Windows-ROOT',
];

// =====================================================================
// TURBO DOWNLOADER — the reason first launches were slow: mclc's
// downloader defaults to maxSockets:2 (two connections for hundreds of
// asset files). This replacement enumerates everything a version needs
// (client jar, libraries + natives, the full asset index, loader
// libraries) and pulls the missing files with 64 parallel keep-alive
// connections, byte-accurate progress, .part-file crash safety, and one
// retry per file. mclc then finds everything already on disk and skips
// straight to launching. It also powers "speculative pre-caching": the
// download starts the moment an instance is selected, before Launch is
// ever clicked.
// =====================================================================
// Connection reuse matters more than raw socket count: without keep-alive
// every one of ~3000 asset files pays a fresh TCP + TLS handshake (~100-200ms
// each). One pooled agent per host turns that into a handful of handshakes
// total, which is the single biggest real-world speedup after parallelism.
const https = require('https');
const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 128,
  maxFreeSockets: 64,
  scheduling: 'lifo',
  timeout: 30000,
});

// =====================================================================
// streamToFile — the non-blocking way to put a URL on disk.
//
// Several call sites did `fs.writeFileSync(p, Buffer.from(await
// res.arrayBuffer()))`. That has two problems, and the second one is the
// reason downloads felt like the app had hung:
//
//   1. arrayBuffer() holds the ENTIRE response in memory before a single
//      byte reaches disk. A Forge installer or a modpack jar is tens of
//      megabytes of resident memory that did not need to exist.
//   2. writeFileSync BLOCKS THE MAIN PROCESS EVENT LOOP for the whole
//      write. The main process is the only thread servicing IPC, so while
//      that write runs the renderer's messages are not being answered: the
//      window stops responding to clicks, progress stops updating, and the
//      OS may paint it as "Not Responding". On a slow disk a 40MB
//      synchronous write is comfortably long enough to be seen.
//
// Streaming fixes both: constant memory, and the event loop stays free the
// whole time so the UI keeps running.
// =====================================================================
async function streamToFile(url, destPath, { headers } = {}) {
  const res = await fetch(url, headers ? { headers } : undefined);
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  // Write to .part first so an interrupted download can never be mistaken
  // for a complete file on the next run.
  const partPath = `${destPath}.part`;
  // 1MB buffer instead of the 64KB default: a quarter of the syscalls on
  // the large files this is used for.
  const out = fs.createWriteStream(partPath, { highWaterMark: 1 << 20 });
  try {
    await streamPipeline(Readable.fromWeb(res.body), out);
    await fsp.rename(partPath, destPath);
  } catch (err) {
    try { await fsp.rm(partPath, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return destPath;
}

// Streaming file hash — same result as
// crypto.createHash(algo).update(fs.readFileSync(p)), without reading the
// entire file into memory or blocking the event loop while it happens.
function hashFileStream(filePath, algo = 'sha1') {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const rs = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

// Adaptive concurrency: start high, back off if the CDN starts erroring
// (which is what actually throttles most connections), climb back when
// things are healthy. Beats a fixed number on both fast and flaky links.
const TURBO_MIN = 8;
const TURBO_MAX = 128;
let turboConcurrency = 64;

const versionJsonCache = new Map(); // versionNumber -> parsed version json

const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';

function rulesAllow(rules) {
  if (!rules || !rules.length) return true;
  let allowed = false;
  for (const r of rules) {
    const matches = !r.os || (!r.os.name || r.os.name === osName);
    if (matches) allowed = r.action === 'allow';
  }
  return allowed;
}

async function getVersionJson(versionNumber) {
  if (versionJsonCache.has(versionNumber)) return versionJsonCache.get(versionNumber);
  const manifest = await getVersionManifest();
  const entry = manifest.versions.find(v => v.id === versionNumber);
  if (!entry) throw new Error(`Unknown Minecraft version ${versionNumber}`);
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error(`Couldn't fetch version data (${res.status})`);
  const json = await res.json();
  versionJsonCache.set(versionNumber, json);
  return json;
}

function mavenToPath(name) {
  // "net.fabricmc:fabric-loader:0.16.9" -> "net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar"
  const [group, artifact, version] = name.split(':');
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}.jar`;
}

function fileOk(dest, size) {
  try {
    const st = fs.statSync(dest);
    return size ? st.size === size : st.size > 0;
  } catch { return false; }
}

function completeMarkerPath(root, versionNumber) {
  return path.join(root, 'versions', versionNumber, '.solar-complete');
}

function writeCompleteMarker(root, versionNumber, assetIndexId) {
  try {
    const dir = path.join(root, 'versions', versionNumber);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(completeMarkerPath(root, versionNumber), JSON.stringify({
      version: versionNumber,
      assetIndexId: assetIndexId || null,
      at: Date.now(),
    }));
  } catch { /* best effort */ }
}

// Enumerate every file the version needs; return only the missing ones.
async function collectMissing(root, versionNumber, loaderProfile) {
  const tasks = [];
  const add = (url, dest, size) => { if (url && !fileOk(dest, size)) tasks.push({ url, dest, size: size || 0 }); };

  const vjson = await getVersionJson(versionNumber);
  const vDir = path.join(root, 'versions', versionNumber);
  fs.mkdirSync(vDir, { recursive: true });
  const vJsonPath = path.join(vDir, `${versionNumber}.json`);
  if (!fs.existsSync(vJsonPath)) fs.writeFileSync(vJsonPath, JSON.stringify(vjson));
  const clientJar = path.join(vDir, `${versionNumber}.jar`);

  // Warm relaunch: skip statting thousands of asset objects when a previous
  // successful verify left a marker and the client jar + asset index still exist.
  const markerPath = completeMarkerPath(root, versionNumber);
  if (fs.existsSync(markerPath) && fileOk(clientJar, vjson.downloads?.client?.size)) {
    try {
      const mark = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      const idxId = vjson.assetIndex?.id;
      const idxPath = idxId ? path.join(root, 'assets', 'indexes', `${idxId}.json`) : null;
      if (mark.version === versionNumber
          && mark.assetIndexId === idxId
          && idxPath
          && fileOk(idxPath, vjson.assetIndex?.size)) {
        if (loaderProfile?.libraries) {
          for (const lib of loaderProfile.libraries) {
            if (!lib.name || !lib.url) continue;
            const rel = mavenToPath(lib.name);
            add(lib.url.replace(/\/$/, '') + '/' + rel, path.join(root, 'libraries', ...rel.split('/')), lib.size);
          }
        }
        const totalBytes = tasks.reduce((s, t) => s + t.size, 0);
        return { tasks, totalBytes, assetIndexId: idxId };
      }
    } catch { /* fall through to full scan */ }
  }

  // version json + client jar
  add(vjson.downloads?.client?.url, clientJar, vjson.downloads?.client?.size);

  // libraries (+ platform natives for older versions)
  for (const lib of vjson.libraries || []) {
    if (!rulesAllow(lib.rules)) continue;
    const art = lib.downloads?.artifact;
    if (art?.path) add(art.url, path.join(root, 'libraries', ...art.path.split('/')), art.size);
    if (lib.natives && lib.downloads?.classifiers) {
      const key = (lib.natives[osName] || '').replace('${arch}', process.arch.includes('64') ? '64' : '32');
      const cls = lib.downloads.classifiers[key];
      if (cls?.path) add(cls.url, path.join(root, 'libraries', ...cls.path.split('/')), cls.size);
    }
  }

  // loader (Fabric/Quilt) maven libraries, if the profile is installed
  if (loaderProfile?.libraries) {
    for (const lib of loaderProfile.libraries) {
      if (!lib.name || !lib.url) continue;
      const rel = mavenToPath(lib.name);
      add(lib.url.replace(/\/$/, '') + '/' + rel, path.join(root, 'libraries', ...rel.split('/')), lib.size);
    }
  }

  // full asset index
  if (vjson.assetIndex?.url) {
    const idxDir = path.join(root, 'assets', 'indexes');
    fs.mkdirSync(idxDir, { recursive: true });
    const idxPath = path.join(idxDir, `${vjson.assetIndex.id}.json`);
    let index;
    if (fileOk(idxPath, vjson.assetIndex.size)) {
      index = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
    } else {
      const res = await fetch(vjson.assetIndex.url);
      if (!res.ok) throw new Error(`Couldn't fetch asset index (${res.status})`);
      index = await res.json();
      fs.writeFileSync(idxPath, JSON.stringify(index));
    }
    const seen = new Set();
    for (const obj of Object.values(index.objects || {})) {
      if (seen.has(obj.hash)) continue;
      seen.add(obj.hash);
      const sub = obj.hash.slice(0, 2);
      add(`https://resources.download.minecraft.net/${sub}/${obj.hash}`,
          path.join(root, 'assets', 'objects', sub, obj.hash), obj.size);
    }
  }

  const totalBytes = tasks.reduce((s, t) => s + t.size, 0);
  if (!tasks.length) writeCompleteMarker(root, versionNumber, vjson.assetIndex?.id);
  return { tasks, totalBytes, assetIndexId: vjson.assetIndex?.id || null };
}

// Raw https.get through the pooled keep-alive agent, streamed straight to
// disk. Node's fetch() can't be pointed at an https.Agent, and this path
// also avoids buffering the body through a ReadableStream reader.
function downloadOne(task) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(task.dest), { recursive: true });
    const part = task.dest + '.part';

    // ---------------------------------------------------------------
    // `scrub` used to be declared with `const` INSIDE the response
    // callback, while req.on('error') — which lives out here — also
    // called it. Any failure before a response arrived (socket reset,
    // timeout, DNS blip: routine at 64 concurrent connections) therefore
    // threw ReferenceError inside an 'error' handler. reject() never ran,
    // so the promise never settled, so that worker waited forever and the
    // download stalled a few files short of finishing — with no error,
    // because the global uncaughtException handler swallowed it.
    //
    // It's defined once, out here, where both handlers can see it. On
    // Windows the .part file is often still held open by the stream that
    // just died, so removal is best-effort and retried.
    // ---------------------------------------------------------------
    const scrub = (file) => {
      try { fs.rmSync(file, { force: true }); }
      catch { setTimeout(() => { try { fs.rmSync(file, { force: true }); } catch { /* leave it */ } }, 1500); }
    };

    // A promise can only settle once; guard so a late 'error' after a
    // successful finish (or vice versa) can't cause trouble.
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (err) { scrub(part); reject(err); } else resolve(value);
    };

    // Socket timeouts only fire on total inactivity. A trickling
    // connection that never finishes would otherwise hold a worker
    // forever, so cap the whole request too.
    const stallTimer = setTimeout(() => {
      try { req.destroy(new Error('stalled')); } catch { /* already gone */ }
      done(new Error('stalled'));
    }, 120000);

    const req = https.get(task.url, { agent: httpsAgent, timeout: 30000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        return downloadOne({ ...task, url: res.headers.location })
          .then(v => done(null, v), e => done(e));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(new Error(`HTTP ${res.statusCode}`));
      }
      const out = fs.createWriteStream(part);
      let got = 0;
      res.on('data', (c) => { got += c.length; });
      res.pipe(out);
      out.on('finish', () => {
        try { fs.renameSync(part, task.dest); done(null, got); }
        catch (err) { done(err); }
      });
      const bail = (err) => { out.destroy(); res.destroy(); done(err); };
      out.on('error', bail);
      res.on('error', bail);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => done(err));
  });
}

async function turboDownload(tasks, totalBytes, onProgress) {
  const failed = [];
  let doneBytes = 0, doneFiles = 0, cursor = 0;
  let recentErrors = 0, recentOk = 0;
  let windowBytes = 0, windowStart = Date.now(), speed = 0;
  const report = () => {
    const now = Date.now();
    if (now - windowStart >= 700) {
      speed = windowBytes / ((now - windowStart) / 1000);
      windowBytes = 0; windowStart = now;
    }
    onProgress?.({
      doneBytes, totalBytes, doneFiles, totalFiles: tasks.length,
      percent: totalBytes ? Math.min(100, (doneBytes / totalBytes) * 100) : (tasks.length ? (doneFiles / tasks.length) * 100 : 100),
      bytesPerSec: speed,
    });
  };

  // back off on errors, climb back when the CDN is happy
  function tune(ok) {
    if (ok) {
      recentOk++;
      if (recentOk >= 40) { turboConcurrency = Math.min(TURBO_MAX, turboConcurrency + 8); recentOk = 0; }
    } else {
      recentErrors++;
      if (recentErrors >= 3) { turboConcurrency = Math.max(TURBO_MIN, Math.floor(turboConcurrency / 2)); recentErrors = 0; recentOk = 0; }
    }
  }

  let active = 0;
  async function worker(id) {
    active++;
    while (cursor < tasks.length) {
      // honor a shrunken pool: extra workers retire themselves
      if (id >= turboConcurrency && active > TURBO_MIN) break;
      const task = tasks[cursor++];
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        try {
          const got = await downloadOne(task);
          doneBytes += task.size || got; windowBytes += got;
          ok = true;
        } catch {
          if (attempt < 2) await new Promise(r => setTimeout(r, 150 * (attempt + 1))); // brief backoff
        }
      }
      if (!ok) {
        doneBytes += task.size || 0; // keep the bar honest; mclc re-pulls stragglers
        failed.push(task.url);
      }
      tune(ok);
      doneFiles++;
      report();
    }
    active--;
  }
  const poolSize = Math.min(turboConcurrency, tasks.length);
  await Promise.all(Array.from({ length: poolSize }, (_, i) => worker(i)));
  report();
  if (failed.length) {
    console.warn(`[SolarClient] ${failed.length}/${tasks.length} files failed to download:`, failed.slice(0, 5));
  }
  return { failed };
}

// ---------- speculative prewarm (per-instance, deduped) ----------
const prewarms = new Map();     // "version|name" -> { promise, done }
const prewarmTaps = new Set();  // launch:start listens here to reuse progress for its own bar
function emitPrewarm(payload) {
  broadcast('prewarm:progress', payload);
  for (const t of prewarmTaps) { try { t(payload); } catch { /* tap gone */ } }
}

function readLoaderProfile(instanceDir) {
  // whatever loader profile ensureLoaderInstalled dropped in versions/
  //
  // This only matched directories starting with "fabric-" or "quilt-".
  // Forge names its profile directory after the Minecraft version
  // (1.20.1-forge-47.2.0), so Forge instances never had their loader
  // libraries pre-downloaded at all — they were left to mclc's slow
  // two-socket path afterwards.
  const vdir = path.join(instanceDir, 'versions');
  if (!fs.existsSync(vdir)) return null;
  for (const d of fs.readdirSync(vdir)) {
    const p = path.join(vdir, d, `${d}.json`);
    const isLoaderDir = /^(fabric|quilt)-/.test(d) || /forge/i.test(d);
    if (isLoaderDir && fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
    }
  }
  return null;
}

function startPrewarm(instanceName, versionNumber, loader) {
  const key = `${versionNumber}|${instanceName}`;
  if (prewarms.has(key)) return prewarms.get(key);

  const root = instancePath(versionNumber, instanceName);
  const state = { done: false, customVersionId: null };
  state.promise = (async () => {
    // Install loader profile first so collectMissing includes Fabric/Quilt/Forge
    // libs — otherwise first launch pays a second turbo pass after click.
    let customVersionId = null;
    if (loader && loader !== 'vanilla') {
      try {
        customVersionId = await ensureLoaderInstalled(loader, root, versionNumber, null);
        state.customVersionId = customVersionId;
      } catch (err) {
        console.warn('[SolarClient] prewarm loader setup:', err.message);
      }
    }
    const profile = readLoaderProfile(root);
    const { tasks, totalBytes, assetIndexId } = await collectMissing(root, versionNumber, profile);
    if (!tasks.length) {
      writeCompleteMarker(root, versionNumber, assetIndexId);
      emitPrewarm({ key, instanceName, versionNumber, percent: 100, done: true, doneBytes: 0, totalBytes: 0, bytesPerSec: 0 });
      state.done = true;
      return;
    }
    const { failed } = await turboDownload(tasks, totalBytes, (p) => {
      emitPrewarm({ key, instanceName, versionNumber, ...p, done: false });
    });
    if (!failed?.length) writeCompleteMarker(root, versionNumber, assetIndexId);
    // Hard-link vanilla client jar into loader version dir during prewarm
    if (customVersionId) {
      const vanillaJar = path.join(root, 'versions', versionNumber, `${versionNumber}.jar`);
      const customJar = path.join(root, 'versions', customVersionId, `${customVersionId}.jar`);
      if (fs.existsSync(vanillaJar) && !fs.existsSync(customJar)) {
        fs.mkdirSync(path.dirname(customJar), { recursive: true });
        try { fs.linkSync(vanillaJar, customJar); } catch { try { fs.copyFileSync(vanillaJar, customJar); } catch { /* ok */ } }
      }
    }
    state.done = true;
    emitPrewarm({ key, instanceName, versionNumber, percent: 100, done: true, doneBytes: totalBytes, totalBytes, bytesPerSec: 0 });
  })().catch(err => {
    prewarms.delete(key); // let a later attempt retry
    emitPrewarm({ key, instanceName, versionNumber, percent: 0, done: true, error: err.message });
  });

  prewarms.set(key, state);
  return state;
}

ipcMain.handle('launch:prewarm', async (_e, { instanceName, versionNumber, loader }) => {
  if (currentBan()) return false;
  startPrewarm(instanceName, versionNumber, loader || 'vanilla');
  return true;
});

// =====================================================================
// LAUNCH — rebuilt for speed and accuracy:
//   · auth refresh, Java setup, and loader install all run IN PARALLEL
//     with the turbo pre-download instead of one after another
//   · Microsoft session refreshes are cached for 10 minutes, so
//     back-to-back launches skip the network round-trip entirely
//   · one monotonic, byte-accurate progress number for the whole launch
//     (no more bar that fills up three times)
//   · the game's child process is kept so Stop can actually kill it
//   · a CPU/RAM sampler feeds the live game monitor window
// =====================================================================
const crashFixer = require('./crashFixer');
const gpuGuard = require('./gpuGuard');
// launchId -> { fixes, reportPath, ctx } from the last crash analysis. The
// renderer only ever sends back fix ids, never paths.
const pendingCrashFixes = new Map();

// Bring the crash dialog in front of the game / Fabric's error window once.
// Only momentarily always-on-top (Windows won't let a background app take
// focus otherwise) — clicking another window afterwards covers it as normal.
function surfaceMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.moveTop();
  mainWindow.focus();
  setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false); }, 400);
}
ipcMain.handle('crash:dialogClosed', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
});

ipcMain.handle('crash:applyFixes', async (_e, { launchId, ids }) => {
  const pending = pendingCrashFixes.get(launchId);
  if (!pending) throw new Error('That crash check has expired — launch again to re-check.');
  // Still running means Fabric's error window is up and holding the jars open.
  if (runningLaunches.has(launchId)) {
    broadcast('fix:progress', { label: 'Closing the crashed game…', percent: null });
    killLaunch(launchId);
    for (let i = 0; i < 40 && runningLaunches.has(launchId); i++) await new Promise(r => setTimeout(r, 250));
    await new Promise(r => setTimeout(r, 500));
  }
  const chosen = pending.fixes.filter(f => !Array.isArray(ids) || ids.includes(f.id));
  // Re-check for a newer SolarClient mod on the relaunch — crash patches ship there.
  solarModMetaCache.fetchedAt = 0;
  const out = await crashFixer.apply(chosen, {
    ...pending.ctx,
    reinstallJava,
    readModManifest,
    writeModManifest,
    onProgress: (label, percent) => broadcast('fix:progress', { label, percent: percent ?? null }),
  });
  pendingCrashFixes.delete(launchId);
  return out;
});

ipcMain.handle('crash:openReport', async (_e, { launchId }) => {
  const p = pendingCrashFixes.get(launchId)?.reportPath;
  if (!p) return false;
  await require('electron').shell.openPath(p);
  return true;
});
const { spawn, exec, execFile } = require('child_process');
const runningLaunches = new Map(); // id -> { launcher, child, instanceName, accountName, startedAt, statsTimer, prevCpuSec }
let launchCounter = 0;
const logBuffers = new Map();     // launchId -> [{line, level}] ring buffer for late-opened monitors
const monitorWindows = new Map(); // launchId -> BrowserWindow (one per launch, reuse)

const authCache = new Map(); // accountId -> { mclc, at }
const AUTH_CACHE_TTL = 30 * 60 * 1000;

async function getAuthorizationCached(account) {
  const hit = authCache.get(account.id);
  if (hit && Date.now() - hit.at < AUTH_CACHE_TTL) return hit.mclc;
  const mclcAuth = await getFreshAuthorization(account);
  authCache.set(account.id, { mclc: mclcAuth, at: Date.now() });
  return mclcAuth;
}

function bufferLog(launchId, line, level) {
  let buf = logBuffers.get(launchId);
  if (!buf) { buf = []; logBuffers.set(launchId, buf); }
  buf.push({ line, level });
  if (buf.length > 600) buf.splice(0, buf.length - 600);
}

ipcMain.handle('launch:logBuffer', async (_e, { launchId }) => logBuffers.get(launchId) || []);

// ---------- game mode: get out of Minecraft's way while it runs ----------
// Chromium runs its GPU process at above-normal priority, so a launcher
// sitting on a second monitor could out-schedule the game it launched.
// While any game is running, every launcher process drops to below-normal;
// the original priorities come back when the last game closes. The game
// itself stays at normal priority: raising it starved OBS, Discord and the
// desktop whenever Minecraft was CPU-heavy, which made the whole PC lag.
const savedPriorities = new Map(); // pid -> priority before game mode
let gameModeActive = false;

function setGameMode(active) {
  const { PRIORITY_BELOW_NORMAL } = os.constants.priority;
  if (active === gameModeActive) return;
  gameModeActive = active;
  if (active) {
    for (const { pid } of app.getAppMetrics()) {
      try {
        const cur = os.getPriority(pid);
        // Larger numbers are lower priority; leave already-idle processes alone.
        if (cur >= PRIORITY_BELOW_NORMAL) continue;
        savedPriorities.set(pid, cur);
        os.setPriority(pid, PRIORITY_BELOW_NORMAL);
      } catch { /* process exited between listing and setting */ }
    }
  } else {
    for (const [pid, prio] of savedPriorities) {
      try { os.setPriority(pid, prio); } catch { /* gone */ }
    }
    savedPriorities.clear();
  }
  broadcast('game:mode', { active });
}

ipcMain.handle('game:mode', () => ({ active: gameModeActive }));

// ---------- per-process CPU/RAM sampling (no native deps, no PowerShell) ----------
function sampleProcess(entry, cb) {
  const pid = entry.child?.pid;
  if (!pid) return cb(null);
  if (process.platform === 'win32') {
    // tasklist, not PowerShell: starting PowerShell every few seconds cost a
    // CPU burst big enough to show up as stutter in the game being watched.
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, out) => {
        if (err || !out) return cb(null);
        // "javaw.exe","1234","Console","1","1,234,567 K"
        const m = /"([\d.,\s\u00a0]+)\sK"\s*$/m.exec(String(out));
        const kb = m ? Number(m[1].replace(/[^\d]/g, '')) : NaN;
        if (!Number.isFinite(kb) || kb <= 0) return cb(null);
        cb({ cpuPercent: 0, memMB: kb / 1024 });
      }
    );
  } else {
    exec(`ps -o %cpu=,rss= -p ${pid}`, (err, out) => {
      if (err || !out.trim()) return cb(null);
      const [cpu, rss] = out.trim().split(/\s+/).map(Number);
      const cores = require('os').cpus().length || 1;
      cb({ cpuPercent: (cpu || 0) / cores, memMB: (rss || 0) / 1024 });
    });
  }
}

function startStatsPoller(launchId) {
  const entry = runningLaunches.get(launchId);
  if (!entry) return;
  // Only poll while a monitor window is open for this launch — otherwise
  // we spawn helper processes forever for stats nobody is watching.
  // ...and only while it is on screen: every 3s when focused, every 15s
  // when visible behind the game, never while minimized or hidden.
  let lastSample = 0;
  entry.statsTimer = setInterval(() => {
    const e = runningLaunches.get(launchId);
    if (!e) return;
    const mon = monitorWindows.get(launchId);
    if (!mon || mon.isDestroyed() || !mon.isVisible() || mon.isMinimized()) return;
    const now = Date.now();
    if (now - lastSample < (mon.isFocused() ? 2900 : 14900)) return;
    lastSample = now;
    sampleProcess(e, (stats) => {
      if (!stats) return;
      try {
        if (!mon.isDestroyed()) {
          mon.webContents.send('launch:stats', {
            launchId, ...stats,
            uptimeSec: Math.floor((Date.now() - e.startedAt) / 1000),
          });
        }
      } catch { /* ok */ }
    });
  }, 3000);
}

// ---------- playtime tracking (mini "wrapped") ----------
function addPlaytimeMs(instanceName, versionNumber, ms, countLaunch) {
  if (!(ms > 0)) return;
  const key = `${versionNumber}|${instanceName}`;
  const pt = store.get('playtime', {});
  const cur = pt[key] || { ms: 0, launches: 0 };
  pt[key] = {
    ms: cur.ms + ms,
    launches: cur.launches + (countLaunch ? 1 : 0),
    lastPlayed: Date.now(),
  };
  store.set('playtime', pt);
}

// Playtime used to be written once, at the moment the game closed. Nothing
// moved while you were actually playing, and a crash or a force-kill threw
// the whole session away. It now accrues every minute.
function startPlaytimeTicker(launchId) {
  const entry = runningLaunches.get(launchId);
  if (!entry) return;
  entry.lastTick = Date.now();
  entry.xpCarryMs = 0;
  entry.playtimeTimer = setInterval(() => {
    const e = runningLaunches.get(launchId);
    if (!e) return;
    const now = Date.now();
    const delta = now - e.lastTick;
    e.lastTick = now;
    addPlaytimeMs(e.instanceName, e.versionNumber, delta, false);

    // XP is simply playtime in whole minutes. Carry the remainder so
    // repeated partial minutes aren't silently discarded.
    e.xpCarryMs += delta;
    const mins = Math.floor(e.xpCarryMs / 60000);
    if (mins > 0) { e.xpCarryMs -= mins * 60000; addXp(mins); }

    broadcast('playtime:changed', { instanceName: e.instanceName, versionNumber: e.versionNumber });
  }, 60000);
}

// Called once when a session ends: bank whatever time has passed since the
// last tick, and count the launch.
function flushPlaytime(entry) {
  if (!entry) return;
  clearInterval(entry.playtimeTimer);
  if (!entry.child || !entry.lastTick) return; // never actually started playing
  const delta = Math.max(0, Date.now() - entry.lastTick);
  addPlaytimeMs(entry.instanceName, entry.versionNumber, delta, true);
  const mins = Math.floor(((entry.xpCarryMs || 0) + delta) / 60000);
  if (mins > 0) addXp(mins);
  broadcast('playtime:changed', { instanceName: entry.instanceName, versionNumber: entry.versionNumber });
}

// One-time correction. XP was being displayed as "played" while also being
// handed out for merely PRESSING launch — 25 from here and another 10 from
// the renderer, so every launch invented 35 minutes of playtime that never
// happened. Over a few hundred launches that is where figures like "145
// hours" came from. Rebuild the counter from time actually recorded.
function repairXpFromRealPlaytime() {
  if (store.get('xpFromPlaytimeV1')) return;
  const pt = store.get('playtime', {});
  const realMinutes = Math.floor(
    Object.values(pt).reduce((a, p) => a + (p && p.ms ? p.ms : 0), 0) / 60000,
  );
  const cur = getXpData();
  if (cur.totalXp > realMinutes) {
    console.log(`[SolarClient] correcting playtime: ${cur.totalXp}m of XP -> ${realMinutes}m actually played`);
    store.set('xp', { totalXp: realMinutes, level: levelForTotal(realMinutes) });
  }
  store.set('xpFromPlaytimeV1', true);
}
ipcMain.handle('stats:playtime', async () => store.get('playtime', {}));

ipcMain.handle('launch:start', async (_e, args) => {
  assertNotBanned();
  const shown = revealPreload(args);
  if (shown) return shown;
  // Still loading in the background: show it the moment it's ready rather
  // than throwing that work away and starting over.
  if (preloadState && !preloadState.ready && !args.joinServer && preloadState.key === preloadKey(args)) {
    preloadState.pendingLaunch = args;
    if (runningLaunches.get(preloadState.launchId)?.child) {
      emitProgress({ launchId: preloadState.launchId, label: 'Starting game…', percent: 95 });
    }
    return { launchId: preloadState.launchId, pending: true };
  }
  // A cold launch must not share the instance folder with a hidden game.
  stopPreload();
  // With Faster launch on, this game stays open (hidden) after it's closed.
  const fastLaunch = !!preloadWanted && preloadKey(args) === preloadKey(preloadWanted)
    && ![...runningLaunches.values()].some((e) => e.fastLaunch);
  try {
    return await doLaunch({ ...args, fastLaunch });
  } catch (err) {
    // make sure a failed setup doesn't leave a ghost "running" entry
    broadcast('launch:closed', { launchId: err.launchId || null, code: null });
    throw err;
  }
});

// The mods that actually raise frame rate. Installed at launch when missing.
// Video settings are left alone — this only drops jars into the mods folder.
const FPS_LAUNCH_MODS = {
  fabric: [
    { slug: 'fabric-api', title: 'Fabric API' },
    { slug: 'sodium', title: 'Sodium' },
    { slug: 'lithium', title: 'Lithium' },
    { slug: 'entityculling', title: 'Entity Culling' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast' },
  ],
  quilt: [
    { slug: 'qsl', title: 'QFAPI' },
    { slug: 'sodium', title: 'Sodium' },
    { slug: 'lithium', title: 'Lithium' },
    { slug: 'entityculling', title: 'Entity Culling' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast' },
  ],
  forge: [
    { slug: 'embeddium', title: 'Embeddium' },
    { slug: 'radium', title: 'Radium' },
    { slug: 'entityculling', title: 'Entity Culling' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast' },
  ],
};

function fpsModPresent(modsDir, slug) {
  const manifest = readModManifest(modsDir);
  const needle = slug.toLowerCase().replace(/-/g, '');
  for (const [file, meta] of Object.entries(manifest)) {
    if (!fs.existsSync(path.join(modsDir, file))) continue;
    const id = String(meta.slug || meta.projectId || '').toLowerCase().replace(/-/g, '');
    if (id === needle) return true;
  }
  let names = [];
  try { names = fs.readdirSync(modsDir); } catch { return false; }
  return names.some((n) => n.endsWith('.jar') && n.toLowerCase().replace(/-/g, '').includes(needle));
}

async function ensureFpsMods(dir, versionNumber, loader, onOne) {
  const pack = FPS_LAUNCH_MODS[loader];
  if (!pack || !versionNumber) return;
  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  for (const mod of pack) {
    if (fpsModPresent(modsDir, mod.slug)) continue;
    onOne?.(mod.title);
    const params = new URLSearchParams();
    params.set('game_versions', JSON.stringify([versionNumber]));
    params.set('loaders', JSON.stringify([loader]));
    const res = await chromeFetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(mod.slug)}/version?${params}`);
    if (!res.ok) continue;
    const versions = await res.json();
    const pick = versions.find((v) => v.version_type === 'release') || versions[0];
    const file = pick && (pick.files.find((f) => f.primary) || pick.files[0]);
    if (!file?.url || !file.filename) continue;
    const got = await chromeFetch(file.url);
    if (!got.ok) continue;
    const finalPath = path.join(modsDir, file.filename);
    const partPath = `${finalPath}.part`;
    const out = fs.createWriteStream(partPath);
    const reader = got.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      fs.renameSync(partPath, finalPath);
    } catch (err) {
      out.destroy();
      fs.rmSync(partPath, { force: true });
      throw err;
    }
    const manifest = readModManifest(modsDir);
    manifest[file.filename] = { projectId: pick.project_id || mod.slug, slug: mod.slug, title: mod.title, iconUrl: '' };
    writeModManifest(modsDir, manifest);
  }
}

// Windows picks the integrated GPU for javaw unless this exe is marked
// high-performance. GpuPreference=2 is the discrete adapter. No game setting.
function preferDiscreteGpu(exePath) {
  if (process.platform !== 'win32' || !exePath || !fs.existsSync(exePath)) return;
  const { execFileSync } = require('child_process');
  const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
  let current = '';
  try {
    const out = execFileSync('reg', ['query', key, '/v', exePath], { encoding: 'utf8', windowsHide: true });
    const m = /REG_SZ\s+(\S.*)$/m.exec(out);
    current = m ? m[1].trim() : '';
  } catch { /* value not set yet */ }
  const data = /GpuPreference=\d/.test(current)
    ? current.replace(/GpuPreference=\d/, 'GpuPreference=2')
    : `${current.replace(/;?\s*$/, '')}${current ? ';' : ''}GpuPreference=2;`;
  execFileSync('reg', ['add', key, '/v', exePath, '/t', 'REG_SZ', '/d', data, '/f'], { windowsHide: true });
}

// Sodium 0.8 turns NVIDIA_THREADED_OPTIMIZATIONS_BROKEN on for every NVIDIA
// GPU, then enables GL_DEBUG_OUTPUT_SYNCHRONOUS. That forces the driver to
// submit commands one at a time. On a 5070 that is the difference between
// ~300 FPS and the card actually running. The old driver-1486 check is a
// separate method; this build never consults it. Skip that one branch.
function patchSodiumWorkaroundsClass(buf) {
  const b = Buffer.from(buf);
  let hits = 0;
  for (let i = 0; i < b.length - 7; i++) {
    if (b[i] === 0xB8 && b[i + 3] === 0x99 && b[i + 4] === 0x00 && b[i + 5] === 0x0B && b[i + 6] === 0x2A && b[i + 7] === 0xB2) {
      // ifne pops the boolean ifeq would have popped, so the stack map stays valid.
      // NVIDIA present (1) now skips the slow-path add.
      b[i + 3] = 0x9A;
      hits++;
    }
  }
  return hits === 1 ? b : null;
}

function parkIrisIfShadersOff(dir) {
  const modsDir = path.join(dir, 'mods');
  let shadersOn = false;
  try {
    shadersOn = /^\s*enableShaders\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(dir, 'config', 'iris.properties'), 'utf8'));
  } catch { /* no iris config */ }
  let names = [];
  try { names = fs.readdirSync(modsDir); } catch { return; }
  for (const name of names) {
    const base = name.replace(/\.disabled$/i, '');
    if (!/^iris-.*\.jar$/i.test(base)) continue;
    const on = path.join(modsDir, base);
    const off = `${on}.disabled`;
    if (shadersOn) {
      if (!fs.existsSync(on) && fs.existsSync(off)) fs.renameSync(off, on);
    } else if (fs.existsSync(on)) {
      if (fs.existsSync(off)) fs.rmSync(off, { force: true });
      fs.renameSync(on, off);
    }
  }
}

function watchGraphicsLog(dir, launchId) {
  const logPath = path.join(dir, 'logs', 'latest.log');
  let tries = 0;
  const tick = async () => {
    if (!runningLaunches.has(launchId)) return;
    tries += 1;
    let text = '';
    try { text = fs.readFileSync(logPath, 'utf8'); } catch { text = ''; }
    if (!/OpenGL Renderer:/i.test(text) && tries < 8) {
      setTimeout(tick, 5000);
      return;
    }
    const lines = gpuGuard.inspectGameLog(text, app.getPath('userData'));
    const pid = runningLaunches.get(launchId)?.child?.pid;
    try {
      const on = await gpuGuard.minecraftOnNvidia(pid);
      if (on === true) lines.push('[SolarClient] Minecraft’s process is on the NVIDIA GPU.');
      else if (on === false) lines.push('[SolarClient] Minecraft’s process is not on the NVIDIA GPU.');
    } catch { /* nvidia-smi is optional */ }
    for (const line of lines) emitLog(launchId, line, 'debug');
  };
  setTimeout(tick, 8000);
}

function raiseGamePriority(pid) {
  if (process.platform !== 'win32' || !pid) return;
  const id = Number(pid);
  if (!id) return;
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SolarPrio {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint a, bool i, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern bool SetPriorityClass(IntPtr h, uint c);
  [DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr h, int c, ref STATE s, int n);
  public struct STATE { public uint Version; public uint ControlMask; public uint StateMask; }
  public static void Apply(int pid) {
    IntPtr h = OpenProcess(0x1200, false, pid);
    if (h == IntPtr.Zero) return;
    try {
      SetPriorityClass(h, 0x80);
      STATE st = new STATE { Version = 1, ControlMask = 1, StateMask = 0 };
      SetProcessInformation(h, 4, ref st, 12);
    } finally { CloseHandle(h); }
  }
}
"@
[SolarPrio]::Apply(${id})
`;
  // Windows puts the game back into efficiency mode a moment after launch,
  // and that is the drop under the peak. One helper keeps reapplying until
  // the game process exits. It does not touch video settings.
  require('child_process').spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script + `
$deadline = (Get-Date).AddHours(6)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Id ${id} -ErrorAction SilentlyContinue)) { break }
  [SolarPrio]::Apply(${id})
  Start-Sleep -Seconds 20
}
`],
    { windowsHide: true, stdio: 'ignore' },
  );
}

// Windows sleeps the render thread in ~15ms slices unless some process has
// asked for a 1ms timer. The request dies with the process that made it,
// so this helper stays alive until the launcher exits.
let timerResolutionHolder = null;
function holdHighTimerResolution() {
  if (process.platform !== 'win32' || timerResolutionHolder) return;
  const script = [
    'Add-Type -TypeDefinition "using System; using System.Runtime.InteropServices; public class SolarTimer { [DllImport(\\"winmm.dll\\")] public static extern uint timeBeginPeriod(uint u); }"',
    '[SolarTimer]::timeBeginPeriod(1) | Out-Null',
    'Wait-Process -Id ' + process.pid,
  ].join('; ');
  timerResolutionHolder = require('child_process').spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, stdio: 'ignore' },
  );
  timerResolutionHolder.on('exit', () => { timerResolutionHolder = null; });
}

// Borderless Minecraft goes through a Windows flip model that adds a frame
// of wait. Marking the game JRE exempt does not change the picture.
function disableFullscreenOptimizations(javaPath) {
  if (process.platform !== 'win32' || !javaPath) return;
  const { execFileSync } = require('child_process');
  const key = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
  let current = '';
  try {
    const out = execFileSync('reg', ['query', key, '/v', javaPath], { windowsHide: true, encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => l.includes('REG_SZ'));
    current = line ? line.split('REG_SZ').pop().trim() : '';
  } catch { /* value not set yet */ }
  if (current.includes('DISABLEFULLSCREENOPTIMIZATIONS')) return;
  const data = `${current} DISABLEFULLSCREENOPTIMIZATIONS`.trim();
  try {
    execFileSync('reg', ['add', key, '/v', javaPath, '/t', 'REG_SZ', '/d', data.startsWith('~') ? data : `~ ${data}`, '/f'], { windowsHide: true });
  } catch { /* non-fatal */ }
}

function unlockSodiumNvidia(dir) {
  const modsDir = path.join(dir, 'mods');
  let names = [];
  try { names = fs.readdirSync(modsDir); } catch { return false; }
  let changed = false;
  for (const name of names) {
    if (!/^sodium-.*\.jar$/i.test(name)) continue;
    const jarPath = path.join(modsDir, name);
    const zip = new (getAdmZip())(jarPath);
    const entry = zip.getEntry('net/caffeinemc/mods/sodium/client/compatibility/workarounds/Workarounds.class');
    if (!entry) continue;
    const patched = patchSodiumWorkaroundsClass(entry.getData());
    if (!patched) continue;
    zip.updateFile(entry, patched);
    zip.writeZip(jarPath);
    changed = true;
  }
  return changed;
}

// Runtime path only. Video options below are the look he already played with
// (fast preset, render distance 8). They are written back so an earlier pass
// cannot leave clouds, mipmaps, or entity distance changed.
function applySolidFps(dir) {
  const cfg = path.join(dir, 'config');
  fs.mkdirSync(cfg, { recursive: true });
  const sodiumPath = path.join(cfg, 'sodium-options.json');
  let sodium = {};
  if (fs.existsSync(sodiumPath)) {
    try { sodium = JSON.parse(fs.readFileSync(sodiumPath, 'utf8')); } catch { sodium = {}; }
  }
  // Scheduling only. Culling, fog, leaves, fluids, textures, and animations
  // stay whatever this instance already saved — those change the picture.
  sodium.performance = {
    ...(sodium.performance || {}),
    // ONE_FRAME is a real Sodium 0.8 DeferMode. NONE is not, and it crashed.
    // ALWAYS holds chunk builds so long the counter sits near 50, then jumps.
    chunk_build_defer_mode: 'ONE_FRAME',
    // Two builders, not four. Extra builders steal the render thread and the
    // counter drops by a few hundred until the batch finishes.
    chunk_builder_threads: 2,
    use_no_error_g_l_context: true,
  };
  sodium.advanced = {
    ...(sodium.advanced || {}),
    cpu_render_ahead_limit: 3,
  };
  fs.writeFileSync(sodiumPath, JSON.stringify(sodium, null, 2));
}

async function doLaunch({ instanceName, versionNumber, loader, memoryMaxGB, memoryMinGB, accountId, performanceMode, joinServer, preload = false, fastLaunch = false, onLaunchId = null }) {
  const account = getAccounts().find(a => a.id === (accountId || store.get('activeAccountId')));
  if (!account) throw new Error('Not signed in.');

  const launchId = `launch-${++launchCounter}`;
  let maxPercent = 0;
  const send = (label, percent, extra = {}) => {
    if (entry.preload && !(preloadState?.launchId === launchId && preloadState.pendingLaunch)) return;
    if (percent != null) { maxPercent = Math.max(maxPercent, percent); percent = maxPercent; }
    emitProgress({ launchId, label, percent, ...extra });
  };

  const dir = instancePath(versionNumber, instanceName);
  const entry = { launcher: null, child: null, instanceName, versionNumber, loader, accountName: account.name, startedAt: Date.now(), statsTimer: null, prevCpuSec: null, prevCpuAt: null, stopRequested: false, stopWatchdog: null, preload,
    fastLaunch: preload || fastLaunch,
    preloadKey: preloadKey({ accountId, instanceName, versionNumber, loader, memoryMaxGB, memoryMinGB, performanceMode }) };
  runningLaunches.set(launchId, entry);
  if (onLaunchId) onLaunchId(launchId);
  if (!preload) {
    broadcast('launch:started', { launchId, instanceName, accountName: account.name, versionNumber, loader });

    // No XP for launching. XP is playtime, and it is granted by the ticker in
    // startPlaytimeTicker as minutes are genuinely spent in game.

    setPresence({ kind: 'launching', edition: 'java', since: Date.now(), instanceName, versionNumber });
  }

  if (!preload && loader && loader !== 'vanilla') {
    try {
      await ensureFpsMods(dir, versionNumber, loader, (title) => send(`Installing ${title}…`, 2));
    } catch (err) {
      emitLog(launchId, `[SolarClient] FPS mods: ${err.message}`, 'debug');
    }
  }

  // Make sure SolarClient's bundled resource pack is sitting in this
  // instance and switched on — same "rewrite it right before launch" logic
  // as the perf profile below, since options.txt is also what we'd be
  // fighting if this ran any earlier.
  if (autoInstallResourcePackEnabled()) {
    const logRP = (line) => emitLog(launchId, line, 'debug');
    try {
      installBundledResourcePack(dir, versionNumber, logRP);
    } catch (err) {
      logRP(`[SolarClient] Resource pack auto-install failed: ${err.message}`);
    }
  }

  // Re-apply the saved performance profile RIGHT NOW. Minecraft overwrites
  // options.txt from memory on exit, so writing once at "optimize" time was
  // always doomed — this makes the settings actually stick.
  const applied = applyPerfProfileForLaunch(instanceName, versionNumber);
  if (applied) {
    send(`Applying your ${applied.tier}-tier settings…`, 1);
  }

  try { unlockSodiumNvidia(dir); } catch (err) {
    emitLog(launchId, `[SolarClient] Sodium NVIDIA unlock: ${err.message}`, 'debug');
  }
  try { applySolidFps(dir); } catch (err) {
    emitLog(launchId, `[SolarClient] FPS settings: ${err.message}`, 'debug');
  }

  send('Contacting the stars…', 1);

  // ---- phase 1: everything that can overlap, overlaps -----------------
  // Solar mod GitHub check used to run BEFORE this Promise.all and added a
  // full RTT on every Fabric launch even when nothing changed. It now rides
  // alongside auth / Java / loader / prewarm.
  const prewarmState = startPrewarm(instanceName, versionNumber, loader); // may already be running/done from selection

  let solarModJar = null;
  const solarModPromise = (async () => {
    const logMod = (line) => emitLog(launchId, line, 'debug');
    try {
      send('Checking for mod updates…', 1);
      solarModJar = await ensureSolarMod(dir, versionNumber, loader, logMod);
    } catch (err) {
      logMod(`[SolarClient] Mod auto-update failed: ${err.message}`);
    }
  })();

  const authPromise = getAuthorizationCached(account).catch(err => {
    throw new Error(`Sign-in expired and couldn't refresh (${err.message}). Try removing this account in Settings and signing in again.`);
  });

  const javaPromise = ensureJava(requiredJavaFor(versionNumber), (msg, percent) => {
    // Java download is its own sub-range (2→12) so the bar never rewinds
    send(msg, percent != null ? 2 + percent * 0.10 : null);
  }).catch(err => { throw new Error(`Java setup failed: ${err.message}`); });

  const loaderPromise = ensureLoaderInstalled(loader, dir, versionNumber, (msg) => send(msg, null))
    .catch(err => { throw new Error(`Loader setup failed: ${err.message}`); });

  // stream turbo-download progress into the 12→90 range, byte-accurate
  const prewarmListener = (payload) => {
    if (payload.instanceName !== instanceName || payload.versionNumber !== versionNumber) return;
    if (payload.totalBytes > 0 && !payload.done) {
      const mb = (payload.doneBytes / 1048576).toFixed(0);
      const mbT = (payload.totalBytes / 1048576).toFixed(0);
      send(`Downloading game files — ${mb} / ${mbT} MB`, 12 + (payload.percent * 0.78), { bytesPerSec: payload.bytesPerSec });
    }
  };
  const tap = (payload) => prewarmListener(payload);
  prewarmTaps.add(tap);

  let customVersionId = null;
  try {
    await Promise.all([
      authPromise,
      javaPromise,
      loaderPromise.then(id => { customVersionId = id; }),
      solarModPromise,
    ]);

    // loader libs weren't known when prewarm started — top them up now (small)
    if (customVersionId) {
      const profile = readLoaderProfile(dir);
      if (profile) {
        const { tasks, totalBytes, assetIndexId } = await collectMissing(dir, versionNumber, profile);
        if (tasks.length) {
          const { failed } = await turboDownload(tasks, totalBytes, (p) => tap({ instanceName, versionNumber, ...p, done: false }));
          if (!failed?.length) writeCompleteMarker(dir, versionNumber, assetIndexId);
        } else {
          writeCompleteMarker(dir, versionNumber, assetIndexId);
        }
      }
      // mclc looks for the vanilla client jar inside the CUSTOM version dir
      // when a loader profile is used — hard-link/copy it over so it isn't
      // re-downloaded through mclc's 2-socket path
      const vanillaJar = path.join(dir, 'versions', versionNumber, `${versionNumber}.jar`);
      const customJar = path.join(dir, 'versions', customVersionId, `${customVersionId}.jar`);
      if (fs.existsSync(vanillaJar) && !fs.existsSync(customJar)) {
        fs.mkdirSync(path.dirname(customJar), { recursive: true });
        try { fs.linkSync(vanillaJar, customJar); } catch { fs.copyFileSync(vanillaJar, customJar); }
      }
    }

    await prewarmState.promise; // usually already resolved by now
  } catch (err) {
    runningLaunches.delete(launchId);
    err.launchId = launchId;
    throw err;
  } finally {
    prewarmTaps.delete(tap);
  }
  send('Verifying files…', 91);

  // Faster launch needs a recent mod. The cached release info can be up to
  // 15 minutes old, so look again before deciding the mod is too old.
  if (entry.fastLaunch && !solarModSupportsPreload(dir, versionNumber)) {
    solarModMetaCache = { fetchedAt: 0, byMc: Object.create(null) };
    try { solarModJar = await ensureSolarMod(dir, versionNumber, loader, (line) => emitLog(launchId, line, 'debug')); } catch { /* checked below */ }
  }
  if (preload) {
    if (entry.stopRequested) { runningLaunches.delete(launchId); return { launchId, stopped: true }; }
    // Without the mod the window can't start hidden and would pop up uninvited.
    if (!solarModSupportsPreload(dir, versionNumber)) {
      runningLaunches.delete(launchId);
      const err = new Error(`Faster launch needs SolarClient mod ${PRELOAD_MIN_MOD} or newer in this instance.`);
      err.code = 'PRELOAD_UNSUPPORTED';
      err.launchId = launchId;
      throw err;
    }
  } else if (entry.fastLaunch && !solarModSupportsPreload(dir, versionNumber)) {
    entry.fastLaunch = false;
  }

  const freshAuthorization = await authPromise;
  const javaPath = await javaPromise;

  const launcher = new (getClient())();
  const opts = {
    authorization: freshAuthorization,
    root: dir,
    javaPath,
    version: customVersionId
      ? { number: versionNumber, type: 'release', custom: customVersionId }
      : { number: versionNumber, type: 'release' },
    memory: { max: `${memoryMaxGB || 4}G`, min: `${memoryMinGB || 2}G` },
    // safety net only — the turbo downloader has already fetched everything,
    // this just covers any straggler mclc's verification finds
    overrides: { maxSockets: 24 },
  };
  if (performanceMode) {
    opts.customArgs = perfJvmArgs(versionNumber, Number(memoryMaxGB) || 4);
    // Start at the full heap. Growing 1 GB → 8 GB during play is the slow
    // FPS climb and a lot of the up-and-down.
    const maxGB = Number(memoryMaxGB) || 4;
    opts.memory.min = `${maxGB}G`;
  }
  if (process.platform === 'win32') {
    opts.customArgs = [...WINDOWS_SSL_JVM_ARGS, ...(opts.customArgs || [])];
  }
  const hiddenModArgs = hiddenSolarModArgs(solarModJar, loader);
  if (hiddenModArgs.length) opts.customArgs = [...(opts.customArgs || []), ...hiddenModArgs];
  if (preload) opts.customArgs = [...(opts.customArgs || []), '-Dsolarclient.preload=true'];
  else if (entry.fastLaunch) opts.customArgs = [...(opts.customArgs || []), '-Dsolarclient.fastlaunch=true'];

  // Accepting an invite launches straight into the target rather than
  // dropping the player on the main menu to type an address.
  //
  // 1.20+ takes --quickPlayMultiplayer host:port. Older versions only
  // understand the separate --server/--port pair, so both are emitted
  // based on the version being launched.
  if (joinServer) {
    const [host, port] = String(joinServer).split(':');
    const major = parseInt(String(versionNumber).split('.')[1] || '0', 10);
    const modern = /^\d+\.\d+/.test(versionNumber) && major >= 20;
    opts.quickPlay = modern
      ? { type: 'multiplayer', identifier: `${host}:${port || 25565}` }
      : undefined;
    if (!modern) {
      opts.customLaunchArgs = [...(opts.customLaunchArgs || []), '--server', host, '--port', String(port || 25565)];
    }
  }

  let logBuffer = '';
  const LOG_CAP = 200 * 1024; // keep last 200KB for crash-pattern matching only
  let firstGameLog = false;
  const goodModsKey = `crashFix.goodMods.${versionNumber}|${instanceName}`;
  let crashAnalyzed = false;
  let liveCrashTimer = null;
  const runCrashAnalysis = () => {
    if (crashAnalyzed) return;
    crashAnalyzed = true;
    const ctx = { dir, versionNumber, loader: loader || 'vanilla' };
    const base = { launchId, instanceName, versionNumber, loader: ctx.loader };
    // Checking candidate builds takes a few seconds — open the dialog now.
    surfaceMainWindow();
    broadcast('launch:crash-analysis', { ...base, pending: true, fixes: [] });
    crashFixer.analyze({
      ...ctx,
      log: logBuffer,
      memoryMaxGB: memoryMaxGB || 4,
      startedAt: entry.startedAt || Date.now(),
      javaMajor: requiredJavaFor(versionNumber),
      goodMods: store.get(goodModsKey, null),
      onProgress: (label) => broadcast('fix:progress', { label, percent: null }),
    }).then(({ summary, fixes, reportPath }) => {
      pendingCrashFixes.set(launchId, { fixes, reportPath, ctx });
      broadcast('launch:crash-analysis', {
        ...base, summary,
        fixes: fixes.map(f => ({ id: f.id, label: f.label, detail: f.detail })),
        hasReport: !!reportPath,
      });
    }).catch(err => {
      console.error('[SolarClient] crash analysis failed:', err);
      broadcast('launch:crash-analysis', { ...base, summary: `SolarClient couldn't check this crash: ${err.message}`, fixes: [], hasReport: false });
    });
  };
  // Fabric/Quilt show their "Incompatible mods found!" window and keep the
  // JVM alive until it's closed, so waiting for the exit code never fires.
  const LIVE_CRASH = /Incompatible mods found|Some of your mods are incompatible|Mod resolution (?:failed|encountered)|Found duplicate mods|ModResolutionException/i;
  const appendLog = (line) => {
    logBuffer += line + '\n';
    if (logBuffer.length > LOG_CAP) logBuffer = logBuffer.slice(-LOG_CAP);
    if (!crashAnalyzed && !liveCrashTimer && LIVE_CRASH.test(line)) {
      if (entry.preload) { preloadFailed(launchId); return; }
      liveCrashTimer = setTimeout(runCrashAnalysis, 1500); // let the rest of the report arrive
    }
  };
  launcher.on('debug', (line) => { appendLog(line); emitLog(launchId, line, 'debug'); });
  launcher.on('data', (line) => {
    appendLog(line);
    emitLog(launchId, line, 'data');
    noteGameLogForDiscord(line);
    if (entry.preload && String(line).includes('SOLARCLIENT_PRELOAD_READY')) preloadReady(launchId);
    if (entry.fastLaunch && String(line).includes('SOLARCLIENT_HIDDEN')) onGameHidden(launchId);
    if (!firstGameLog && !entry.preload) {
      firstGameLog = true;
      send('Game running — have fun!', 100);
      setPresence({
        kind: 'playing', edition: 'java', since: Date.now(), instanceName, versionNumber,
        gamePid: runningLaunches.get(launchId)?.child?.pid || null,
      });
      setGameMode(true);
      // Essential sets its status once the game reaches the title screen.
      reassertDiscordLater(25000);
      reassertDiscordLater(75000);
    }
  });
  launcher.on('progress', (e) => {
    const pct = e.total ? (e.task / e.total) * 100 : null;
    send(`Checking ${e.type}…`, pct != null ? 91 + pct * 0.06 : null);
  });
  launcher.on('close', (code) => {
    flushLogs();          // deliver anything still queued before we report exit
    flushProgressIpc();
    const entry = runningLaunches.get(launchId);
    if (entry) {
      clearTimeout(entry.stopWatchdog);
      clearInterval(entry.statsTimer);
      flushPlaytime(entry);
    }
    runningLaunches.delete(launchId);
    logBuffers.delete(launchId);
    if (entry?.preload) {
      // Nobody was playing it: no presence change, no crash dialog.
      clearTimeout(liveCrashTimer);
      logBuffer = '';
      preloadExited(launchId, !entry.userStopped);
      return;
    }
    const mon = monitorWindows.get(launchId);
    if (mon && !mon.isDestroyed()) {
      try { mon.close(); } catch { /* ok */ }
    }
    monitorWindows.delete(launchId);
    if (!playerGameRunning()) {
      setPresence({ kind: 'idle', edition: 'java', since: Date.now(), instanceName: null, versionNumber: null, gamePid: null });
      setGameMode(false);
    }
    // Without this a clean quit left presence stuck on "in game" until the
    // launcher itself was closed — the only exit path that was missing it.
    clearFriendsActivity();
    broadcast('launch:closed', { launchId, code });
    // Faster launch: warm the next game up once this one has closed. The
    // launch may have just installed a mod that supports it.
    preloadUnsupported = null;
    schedulePreload(PRELOAD_AFTER_CLOSE_MS);
    clearTimeout(liveCrashTimer);
    if (liveCrashTimer && !crashAnalyzed) {
      runCrashAnalysis();
    } else if (code === 0 && firstGameLog && !crashAnalyzed) {
      store.set(goodModsKey, crashFixer.listEnabledJars(dir));
    } else if (code !== 0 && code !== null && !entry?.userStopped) {
      runCrashAnalysis();
    }
    logBuffer = '';
  });

  entry.launcher = launcher;
  // Leave NVIDIA threaded optimizations alone. Sodium turns that driver hack
  // off on purpose; forcing it back on does not change the picture and does
  // not raise the frame rate.
  process.env.__GL_SYNC_TO_VBLANK = '0';
  process.env.__GL_SHADER_DISK_CACHE = '1';
  process.env.__GL_SHADER_DISK_CACHE_SKIP_CLEANUP = '1';
  holdHighTimerResolution();
  try {
    const lines = await gpuGuard.inspectBeforeLaunch({
      instanceDir: dir,
      userData: app.getPath('userData'),
    });
    for (const line of lines) emitLog(launchId, line, 'debug');
  } catch (err) {
    emitLog(launchId, `[SolarClient] Graphics check: ${err.message}`, 'debug');
  }
  try { preferDiscreteGpu(javaPath); } catch (err) {
    emitLog(launchId, `[SolarClient] GPU preference: ${err.message}`, 'debug');
  }
  try { disableFullscreenOptimizations(javaPath); } catch { /* non-fatal */ }
  send('Igniting engines…', 96);

  let child;
  try {
    child = await launcher.launch(opts); // resolves with the spawned java process
  } catch (err) {
    runningLaunches.delete(launchId);
    err.launchId = launchId;
    throw err;
  }
  entry.child = child || null;
  raiseGamePriority(child?.pid);
  watchGraphicsLog(dir, launchId);
  entry.startedAt = Date.now();
  entry.spawnedAt = entry.startedAt;
  if (entry.stopRequested) { killLaunch(launchId); return { launchId, stopped: true }; }
  if (entry.preload) return { launchId };
  startStatsPoller(launchId);
  startPlaytimeTicker(launchId);
  // Presence is only ever "in game" because our own launcher said so.
  try { ensureFriends().setActivity({ instanceName, versionNumber, at: Date.now() }); } catch { /* non-fatal */ }
  send('Starting Minecraft…', 98);
  return { launchId };
}

ipcMain.handle('launch:running', async () => {
  return Array.from(runningLaunches.entries()).filter(([, v]) => !v.preload).map(([id, v]) => ({
    id, instanceName: v.instanceName, accountName: v.accountName,
  }));
});

// =====================================================================
// FASTER LAUNCH (beta) — keeps the selected instance loaded to the title
// screen in a hidden window, so Launch only has to show it. The mod does
// the hiding (see Preload.java); a game started without a new enough mod
// is never preloaded.
// =====================================================================
const PRELOAD_MIN_MOD = '0.24.30';
const PRELOAD_AFTER_CLOSE_MS = 5000;
const PRELOAD_RETRY_MS = 60000;
const PRELOAD_MAX_FAILS = 3;
// Sign-in tokens last about a day; restart the hidden game well before that.
const PRELOAD_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// Faster launch is a BETA-only feature: it ships in every build but only ever
// activates on a -beta build. Stable builds keep the code (encrypted) but
// inert, and the renderer hides the chip. This is how beta features stay in
// beta even though both channels are built from the same source.
const FASTER_LAUNCH_BUILD = String(app.getVersion()).includes('-beta');

let preloadWanted = null;   // launch args the renderer wants kept warm, or null
let preloadState = null;    // { key, launchId, ready, startedAt }
let preloadFails = 0;
let preloadUnsupported = null; // key that was refused, so it isn't retried
let preloadTimer = null;

function preloadKey(a) {
  const acc = a.accountId || store.get('activeAccountId') || '';
  return [acc, a.instanceName, a.versionNumber, a.loader || 'vanilla', a.memoryMaxGB, a.memoryMinGB, !!a.performanceMode].join('|');
}

function solarModSupportsPreload(dir, versionNumber) {
  try {
    const want = PRELOAD_MIN_MOD.split('.').map(Number);
    let names;
    if (!HIDDEN_SOLAR_MOD) names = fs.readdirSync(path.join(dir, 'mods'));
    else if (hiddenSolarJars.has(versionNumber)) names = [path.basename(hiddenSolarJars.get(versionNumber))];
    else names = fs.readdirSync(solarModCacheDir());
    return names.some((f) => {
      const m = SOLAR_MOD_RE.exec(f);
      if (!m || m[1] !== versionNumber) return false;
      const have = m[2].split('.').map(Number);
      for (let i = 0; i < want.length; i++) {
        const d = (have[i] || 0) - want[i];
        if (d) return d > 0;
      }
      return true;
    });
  } catch { return false; }
}

function broadcastPreload() {
  let state = 'off';
  if (preloadWanted) {
    if (preloadState?.ready) state = 'ready';
    else if (preloadState) state = 'loading';
    else if (preloadUnsupported === preloadKey(preloadWanted)) state = 'unsupported';
    else if (preloadFails >= PRELOAD_MAX_FAILS) state = 'failed';
    else state = 'waiting';
  }
  broadcast('preload:state', { state });
}

function stopPreload() {
  clearTimeout(preloadTimer);
  if (!preloadState) return;
  const st = preloadState;
  preloadState = null;
  if (st.launchId) killLaunch(st.launchId);
  broadcastPreload();
  launchPendingCold(st);
}

// A Launch was waiting on a preload that won't finish: start it normally.
function launchPendingCold(st) {
  const args = st?.pendingLaunch;
  if (!args) return;
  st.pendingLaunch = null;
  const fastLaunch = !!preloadWanted && preloadKey(args) === preloadKey(preloadWanted);
  doLaunch({ ...args, fastLaunch }).catch((err) => {
    broadcast('launch:closed', { launchId: err.launchId || null, code: null });
  });
}

function schedulePreload(ms) {
  clearTimeout(preloadTimer);
  if (!preloadWanted) return;
  preloadTimer = setTimeout(() => { ensurePreload().catch(() => {}); }, ms);
}

function playerGameRunning() {
  for (const e of runningLaunches.values()) if (!e.preload) return true;
  return false;
}

async function ensurePreload() {
  if (!preloadWanted) { stopPreload(); return; }
  const key = preloadKey(preloadWanted);
  if (preloadState && preloadState.key === key) return;
  stopPreload();
  // A second Minecraft loading behind the one being played would cost frames.
  if (playerGameRunning()) { broadcastPreload(); return; }
  const loader = preloadWanted.loader || 'vanilla';
  if ((loader !== 'fabric' && loader !== 'quilt') || preloadUnsupported === key) {
    preloadUnsupported = key;
    broadcastPreload();
    return;
  }
  if (preloadFails >= PRELOAD_MAX_FAILS) { broadcastPreload(); return; }

  const mine = { key, launchId: null, ready: false, startedAt: Date.now() };
  preloadState = mine;
  broadcastPreload();
  try {
    const res = await doLaunch({
      ...preloadWanted, joinServer: undefined, preload: true,
      onLaunchId: (id) => { mine.launchId = id; },
    });
    if (preloadState !== mine && res?.launchId && runningLaunches.get(res.launchId)?.preload) killLaunch(res.launchId);
  } catch (err) {
    if (preloadState === mine) preloadState = null;
    launchPendingCold(mine);
    if (err.code === 'PRELOAD_UNSUPPORTED') {
      preloadUnsupported = key;
    } else {
      console.warn('[SolarClient] Faster launch preload failed:', err.message);
      preloadFails++;
      schedulePreload(PRELOAD_RETRY_MS);
    }
    broadcastPreload();
  }
}

function preloadReady(launchId) {
  if (preloadState?.launchId !== launchId || preloadState.ready) return;
  preloadState.ready = true;
  preloadFails = 0;
  broadcastPreload();
  const waiting = preloadState.pendingLaunch;
  if (waiting) {
    preloadState.pendingLaunch = null;
    if (!revealPreload(waiting)) {
      stopPreload();
      launchPendingCold({ pendingLaunch: waiting });
    }
  }
}

function preloadFailed(launchId) {
  if (preloadState?.launchId !== launchId) return;
  const st = preloadState;
  preloadState = null;
  preloadFails++;
  killLaunch(launchId);
  broadcastPreload();
  launchPendingCold(st);
  schedulePreload(PRELOAD_RETRY_MS);
}

function preloadExited(launchId, unexpected) {
  if (preloadState?.launchId !== launchId) return;
  const st = preloadState;
  preloadState = null;
  if (unexpected) preloadFails++;
  broadcastPreload();
  launchPendingCold(st);
  schedulePreload(unexpected ? PRELOAD_RETRY_MS : 1000);
}

// The player closed a Faster launch game: the mod hid it on the title screen
// instead of quitting. To everything else it's closed; it waits for Launch.
function onGameHidden(launchId) {
  const entry = runningLaunches.get(launchId);
  if (!entry || entry.preload) return;
  clearTimeout(entry.hideWatchdog);
  clearInterval(entry.statsTimer);
  entry.statsTimer = null;
  flushPlaytime(entry);
  entry.lastTick = null;
  entry.preload = true;
  const mon = monitorWindows.get(launchId);
  if (mon && !mon.isDestroyed()) {
    try { mon.close(); } catch { /* ok */ }
  }
  monitorWindows.delete(launchId);
  if (!playerGameRunning()) {
    setPresence({ kind: 'idle', edition: 'java', since: Date.now(), instanceName: null, versionNumber: null, gamePid: null });
    setGameMode(false);
  }
  clearFriendsActivity();
  broadcast('launch:closed', { launchId, code: 0 });

  if (preloadWanted && !preloadState && entry.preloadKey === preloadKey(preloadWanted)) {
    preloadState = { key: entry.preloadKey, launchId, ready: true, startedAt: entry.spawnedAt || Date.now() };
    preloadFails = 0;
    broadcastPreload();
  } else {
    killLaunch(launchId);
    schedulePreload(PRELOAD_AFTER_CLOSE_MS);
  }
}

// Hands the hidden game to the player. Returns null when the preload
// doesn't match what is being launched (or isn't loaded yet).
function revealPreload(args) {
  if (!preloadState?.ready || args.joinServer || preloadState.key !== preloadKey(args)) return null;
  const launchId = preloadState.launchId;
  const entry = runningLaunches.get(launchId);
  if (!entry?.child?.stdin?.writable || entry.child.exitCode != null) return null;
  try { entry.child.stdin.write('solarclient:show\n'); } catch { return null; }

  preloadState = null;
  entry.preload = false;
  entry.startedAt = Date.now();
  broadcastPreload();
  broadcast('launch:started', {
    launchId, instanceName: entry.instanceName, accountName: entry.accountName,
    versionNumber: entry.versionNumber, loader: entry.loader, instant: true,
  });
  emitProgress({ launchId, label: 'Game running — have fun!', percent: 100 });
  setPresence({
    kind: 'playing', edition: 'java', since: Date.now(),
    instanceName: entry.instanceName, versionNumber: entry.versionNumber, gamePid: entry.child.pid || null,
  });
  setGameMode(true);
  reassertDiscordLater(25000);
  reassertDiscordLater(75000);
  startStatsPoller(launchId);
  startPlaytimeTicker(launchId);
  try { ensureFriends().setActivity({ instanceName: entry.instanceName, versionNumber: entry.versionNumber, at: Date.now() }); } catch { /* non-fatal */ }
  return { launchId, instant: true };
}

ipcMain.handle('preload:set', async (_e, args) => {
  // Stable builds never keep a game warm — the feature is beta-only.
  if (!FASTER_LAUNCH_BUILD) { preloadWanted = null; stopPreload(); return true; }
  const next = args && args.instanceName ? args : null;
  const changed = (next ? preloadKey(next) : null) !== (preloadWanted ? preloadKey(preloadWanted) : null);
  preloadWanted = next;
  if (changed) { preloadFails = 0; preloadUnsupported = null; }
  if (!next) {
    stopPreload();
    // A game open right now goes back to quitting normally when closed.
    for (const e of runningLaunches.values()) {
      if (!e.fastLaunch || e.preload) continue;
      e.fastLaunch = false;
      try { e.child?.stdin?.write('solarclient:keepalive off\n'); } catch { /* exits normally anyway */ }
    }
    broadcastPreload();
    return true;
  }
  ensurePreload().catch(() => {});
  broadcastPreload();
  return true;
});

setInterval(() => {
  if (preloadState?.ready && Date.now() - preloadState.startedAt > PRELOAD_MAX_AGE_MS) {
    stopPreload();
    schedulePreload(2000);
  }
}, 10 * 60 * 1000);

app.on('before-quit', () => {
  const id = preloadState?.launchId;
  const pid = id && runningLaunches.get(id)?.child?.pid;
  if (!pid) return;
  preloadState = null;
  try {
    if (process.platform === 'win32') require('child_process').spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid);
  } catch { /* the game also exits on its own when stdin closes */ }
});

// actually kill the game process (whole tree on Windows)
function clearFriendsActivity() {
  try {
    if (!playerGameRunning()) {
      ensureFriends().setActivity(null);
      // A world invite must not outlive the session that hosted it.
      ensureFriends().revokeHostedInvites();
    }
  } catch { /* non-fatal */ }
}

// The SolarClient mod keeps a poll open on the bridge for as long as the game
// runs, so a live poll means a SolarClient game is open — even one this
// launcher didn't start (e.g. the launcher restarted for an update mid-game).
// Count those as "in game" too.
setInterval(() => {
  if (!bridge || !friends) return;
  const live = bridge.modActive();
  // A hidden Faster launch game keeps polling too; nobody is playing it.
  if (live && !friends.activity && !preloadState) {
    friends.setActivity({ instanceName: null, versionNumber: null, detected: true, at: Date.now() });
  } else if (!live && friends.activity?.detected && !playerGameRunning()) {
    friends.setActivity(null);
  }
}, 10000);

function forceCloseLaunch(launchId, code = null) {
  const entry = runningLaunches.get(launchId);
  if (!entry) return;
  clearInterval(entry.statsTimer);
  clearTimeout(entry.stopWatchdog);
  // Only count time if the game actually got as far as spawning — a
  // launch that died during setup isn't playtime.
  flushPlaytime(entry);
  runningLaunches.delete(launchId);
  logBuffers.delete(launchId);
  if (entry.preload) { preloadExited(launchId, false); return; }
  const mon = monitorWindows.get(launchId);
  if (mon && !mon.isDestroyed()) {
    try { mon.close(); } catch { /* ok */ }
  }
  monitorWindows.delete(launchId);
  if (!playerGameRunning()) {
    setPresence({ kind: 'idle', edition: 'java', since: Date.now(), instanceName: null, versionNumber: null, gamePid: null });
  }
  clearFriendsActivity();
  broadcast('launch:closed', { launchId, code });
}

function killLaunch(launchId) {
  const entry = runningLaunches.get(launchId);
  if (!entry) return false;
  entry.userStopped = true; // taskkill exits non-zero; that's not a crash

  // The UI used to sit on "Stopping…" forever whenever the close event
  // never arrived — process already dead, mclc listener detached, crash
  // during startup. Whatever happens to the child, the entry is torn down
  // and a close is broadcast within a few seconds so the button resets.
  if (!entry.stopWatchdog) {
    entry.stopWatchdog = setTimeout(() => forceCloseLaunch(launchId, null), 6000);
  }

  if (!entry.child?.pid) { entry.stopRequested = true; return true; } // spawning — kill right after spawn
  const pid = entry.child.pid;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch { /* fine */ } }, 4000);
  }
  return true;
}
ipcMain.handle('launch:stop', async (_e, { launchId }) => {
  // Faster launch: Stop hides the game like closing it would; only a game
  // that doesn't respond is actually killed.
  const entry = runningLaunches.get(launchId);
  if (entry?.fastLaunch && !entry.preload && preloadWanted && entry.child?.stdin?.writable) {
    try {
      entry.child.stdin.write('solarclient:hide\n');
      clearTimeout(entry.hideWatchdog);
      entry.hideWatchdog = setTimeout(() => {
        const e = runningLaunches.get(launchId);
        if (e && !e.preload) killLaunch(launchId);
      }, 10000);
      return true;
    } catch { /* fall through to a real stop */ }
  }
  return killLaunch(launchId);
});

// =====================================================================
// GAME MONITOR WINDOWS — one small frameless window per launch showing
// live console, CPU/RAM of the actual game process, uptime, and status.
// =====================================================================
ipcMain.handle('monitor:open', async (_e, { launchId }) => {
  const existing = monitorWindows.get(launchId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return true;
  }
  const entry = runningLaunches.get(launchId);
  const win = new BrowserWindow({
    width: 1200, height: 620, minWidth: 720, minHeight: 480,
    backgroundColor: '#0a0714', frame: false,
    icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  monitorWindows.set(launchId, win);
  win.on('closed', () => {
    if (monitorWindows.get(launchId) === win) monitorWindows.delete(launchId);
  });
  routePopupsToBrowser(win.webContents);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'monitor.html'), {
    query: {
      launchId,
      instance: entry?.instanceName || '',
      account: entry?.accountName || '',
    },
  });
  return true;
});

// =====================================================================
// HARDWARE AUTO-TUNE + "BEST SETTINGS" WRITER
// Auto-tune reads real system specs and picks memory + a settings tier.
// The writer merges consensus max-FPS settings (research: Sodium guides,
// PlanetMinecraft/Sportskeeda settings breakdowns) into the instance's
// options.txt and config/sodium-options.json — render distance and
// friends scaled to the hardware tier.
// =====================================================================
const os = require('os');

// GPU model (Windows): PowerShell CIM is reliable; fall back to WMIC.
function detectGpuLinux() {
  return new Promise((resolve) => {
    require('child_process').execFile('lspci', ['-mm'], { timeout: 4000 }, (err, out) => {
      if (err) { resolve(null); return; }
      const gpus = String(out || '').split('\n')
        .map((line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]))
        .filter((f) => /VGA compatible controller|3D controller|Display controller/i.test(f[0] || ''))
        .map(([, vendor = '', device = '']) => {
          const v = /nvidia/i.test(vendor) ? 'NVIDIA' : /amd|ati/i.test(vendor) ? 'AMD' : /intel/i.test(vendor) ? 'Intel' : vendor.split(/\s/)[0];
          const model = (/\[([^\]]+)\]/.exec(device) || [])[1] || device;
          return { name: `${v} ${model}`.trim(), discrete: v === 'NVIDIA' || v === 'AMD' };
        });
      const pick = gpus.find((g) => g.discrete) || gpus[0];
      resolve(pick ? pick.name : null);
    });
  });
}

function detectGpu() {
  if (process.platform === 'linux') return detectGpuLinux();
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const ps = [
      "(Get-CimInstance Win32_VideoController |",
      " Sort-Object -Property AdapterRAM -Descending |",
      " Select-Object -First 1 -ExpandProperty Name)",
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        const name = String(stdout || '').trim().replace(/\r/g, '');
        if (!err && name && name.length > 1 && !/^microsoft\s+basic/i.test(name)) {
          resolve(name);
          return;
        }
        execFile(
          'wmic',
          ['path', 'win32_VideoController', 'get', 'name'],
          { windowsHide: true, timeout: 4000 },
          (err2, out2) => {
            if (err2) { resolve(null); return; }
            const lines = String(out2 || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            const pick = lines.find(l => l && !/^name$/i.test(l) && !/^microsoft\s+basic/i.test(l));
            resolve(pick || null);
          },
        );
      },
    );
  });
}

ipcMain.on('update:state', (sender, state) => {
  broadcast('update:state', state);
});

ipcMain.handle('online:count', async () => {
  try {
    const base = await require('./endpoints').apiBase();
    const url = `${base}/health`;
    const lib = url.startsWith('https') ? require('https') : require('http');
    const data = await new Promise((resolve, reject) => {
      const req = lib.get(url, { timeout: 4000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const n = Number(data?.online);
    if (!Number.isFinite(n)) return null;
    const g = Number(data?.inGame);
    return { online: n, inGame: Number.isFinite(g) ? g : null };
  } catch {
    return null;
  }
});

ipcMain.handle('theme:notify', () => {
  broadcast('theme:changed', { at: Date.now() });
  return true;
});

ipcMain.handle('system:info', async () => {
  const totalMemGB = os.totalmem() / (1024 ** 3);
  const freeMemGB = os.freemem() / (1024 ** 3);
  const cores = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model?.trim() || 'Unknown CPU';
  const gpu = await detectGpu();

  const tier = (totalMemGB >= 16 && cores >= 8) ? 'high' : (totalMemGB >= 8 ? 'mid' : 'low');
  const memMaxGB = totalMemGB >= 24 ? 8 : totalMemGB >= 12 ? 6 : totalMemGB >= 8 ? 4 : 2;

  // NOTE: there used to be an `estimate` field here feeding an "FPS
  // ballpark" gauge. It was a tier lookup table times two fudge factors —
  // nothing was ever benchmarked — and it topped out around 400, so plenty
  // of rigs that comfortably run four figures were shown a number less than
  // half of what they actually get. Rather than tune a guess, it's gone.
  const gpuStr = (gpu || '').toLowerCase();
  const discrete = /nvidia|geforce|rtx|gtx|radeon|rx\s?\d|arc\s?a/.test(gpuStr);

  return {
    totalMemGB: Math.round(totalMemGB), freeMemGB: Math.round(freeMemGB), cores,
    cpuModel, gpu, discrete,
    platform: process.platform, arch: process.arch,
    tier,
    suggested: { memMaxGB, memMinGB: Math.max(2, Math.floor(memMaxGB / 2)) },
  };
});

// Vanilla values are written to options.txt; Sodium's own values go to
// config/sodium-options.json using LOWER_CASE_WITH_UNDERSCORES (Sodium
// serializes with Gson's FieldNamingPolicy.LOWER_CASE_WITH_UNDERSCORES).
// Clouds/render distance/graphics live in VANILLA options — Sodium binds
// its GUI to vanilla's fields for those, which is why writing them only
// into sodium-options.json did nothing.
const TIER_SETTINGS = {
  low:  { renderDistance: 8,  simulationDistance: 6,  graphicsMode: 0, particles: 2, biomeBlendRadius: 0, cloudStatus: 0, entityDistanceScaling: 0.75, mipmap: 0 },
  mid:  { renderDistance: 12, simulationDistance: 8,  graphicsMode: 0, particles: 1, biomeBlendRadius: 1, cloudStatus: 1, entityDistanceScaling: 0.75, mipmap: 4 },
  high: { renderDistance: 16, simulationDistance: 10, graphicsMode: 0, particles: 2, biomeBlendRadius: 0, cloudStatus: 0, entityDistanceScaling: 1.0, mipmap: 0 },
};

// The whole vanilla settings payload for a tier, plus any user overrides.
function buildVanillaOptions(tier, overrides = {}) {
  const t = TIER_SETTINGS[tier] || TIER_SETTINGS.mid;
  const o = { ...t, ...overrides };
  // cloudStatus: 0 = off, 1 = fast, 2 = fancy (vanilla enum order)
  const cloudsStr = o.cloudStatus === 0 ? 'false' : 'true';
  const kv = {
    renderDistance: o.renderDistance,
    simulationDistance: o.simulationDistance,
    maxFps: o.maxFps ?? 260,
    enableVsync: String(o.vsync ?? false),
    graphicsMode: o.graphicsMode,
    particles: o.particles,
    // Modern MC uses BOTH: a boolean `renderClouds` and (1.20.2+) `cloudStatus`.
    // Writing both is what makes "clouds off" actually stick in-game.
    renderClouds: cloudsStr,
    cloudStatus: o.cloudStatus,
    entityShadows: String(o.entityShadows ?? false),
    biomeBlendRadius: o.biomeBlendRadius,
    entityDistanceScaling: Number(o.entityDistanceScaling).toFixed(1),
    mipmapLevels: o.mipmap,
    // 1.21 reads graphicsPreset. graphicsMode alone does not change the picture.
    graphicsPreset: o.graphicsMode === 0 ? '"fast"' : '"fancy"',
    ao: o.ao ?? 'true',
    fullscreen: String(o.fullscreen ?? false),
    guiScale: o.guiScale ?? 0,
  };
  return kv;
}

// =====================================================================
// AUTO-INSTALL RESOURCE PACK — SolarClient ships with its own resource
// pack (resources/SolarResourcePack.zip, bundled via electron-builder's
// extraResources so it sits next to the app rather than inside the asar).
// Every time an instance launches we make sure a copy is sitting in that
// instance's resourcepacks/ folder AND is actually turned on in
// options.txt — installing the file alone isn't enough, Minecraft only
// loads packs that are also listed in the resourcePacks array.
// =====================================================================
const BUNDLED_RESOURCEPACK_FILE = 'SolarResourcePack.zip';

function bundledResourcePackPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'resources', BUNDLED_RESOURCEPACK_FILE)
    : path.join(__dirname, '..', '..', 'resources', BUNDLED_RESOURCEPACK_FILE);
}

function autoInstallResourcePackEnabled() {
  return store.get('autoInstallResourcePack', false) === true;
}

// =====================================================================
// A pack.mcmeta declares which Minecraft versions it supports via
// "pack_format". Mojang has changed how a *range* of versions is declared
// more than once (an old "supported_formats" object, a newer array form,
// and now separate "min_format"/"max_format" fields on very recent
// clients that outright reject the old "supported_formats" key). Rather
// than chase that a second time, we sidestep it: figure out the exact
// pack_format the target version expects and write only that single
// number. A plain "pack_format" integer is the one thing every Minecraft
// release since 1.6.1 has always understood, so an exact match never
// shows as incompatible on any client, old or new.
// Source: https://minecraft.wiki/w/Pack_format (resource pack format
// history) — update this table as new Minecraft versions ship.
// =====================================================================
const RESOURCE_PACK_FORMAT_TABLE = [
  ['1.6.1', '1.8.9', 1], ['1.9', '1.10.2', 2], ['1.11', '1.12.2', 3],
  ['1.13', '1.14.4', 4], ['1.15', '1.16.1', 5], ['1.16.2', '1.16.5', 6],
  ['1.17', '1.17.1', 7], ['1.18', '1.18.2', 8], ['1.19', '1.19.2', 9],
  ['1.19.3', '1.19.3', 12], ['1.19.4', '1.19.4', 13], ['1.20', '1.20.1', 15],
  ['1.20.2', '1.20.2', 18], ['1.20.3', '1.20.4', 22], ['1.20.5', '1.20.6', 32],
  ['1.21', '1.21.1', 34], ['1.21.2', '1.21.3', 42], ['1.21.4', '1.21.4', 46],
  ['1.21.5', '1.21.5', 55], ['1.21.6', '1.21.6', 63], ['1.21.7', '1.21.8', 64],
  ['1.21.9', '1.21.10', 69], ['1.21.11', '1.21.11', 75],
  ['26.1', '26.1.2', 84], ['26.2', '26.2', 88],
];

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function resourcePackFormatFor(versionNumber) {
  for (const [min, max, format] of RESOURCE_PACK_FORMAT_TABLE) {
    if (compareVersions(versionNumber, min) >= 0 && compareVersions(versionNumber, max) <= 0) return format;
  }
  // Outside the table entirely: older than anything listed, or newer than
  // the newest entry (a future version this table hasn't been updated
  // for yet). Clamp to the nearest end rather than guessing — for simple
  // GUI textures like ours, being a handful of formats off is far more
  // likely to still work than picking something wildly wrong.
  const first = RESOURCE_PACK_FORMAT_TABLE[0];
  const last = RESOURCE_PACK_FORMAT_TABLE[RESOURCE_PACK_FORMAT_TABLE.length - 1];
  return compareVersions(versionNumber, first[0]) < 0 ? first[2] : last[2];
}

// Reads the current resourcePacks:[...] line out of options.txt so we can
// add ours without clobbering anything the user already has enabled.
function currentResourcePacks(dir) {
  const optionsPath = path.join(dir, 'options.txt');
  if (!fs.existsSync(optionsPath)) return [];
  for (const line of fs.readFileSync(optionsPath, 'utf-8').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i) === 'resourcePacks') {
      try {
        const parsed = JSON.parse(line.slice(i + 1));
        return Array.isArray(parsed) ? parsed : [];
      } catch { return []; }
    }
  }
  return [];
}

function ensureResourcePackEnabled(dir, packFilename) {
  const entry = `file/${packFilename}`;
  const packs = currentResourcePacks(dir);
  if (!packs.includes(entry)) packs.push(entry);
  writeOptionsTxt(dir, { resourcePacks: JSON.stringify(packs) });
}

// Copies the bundled pack into the instance and patches its pack_format to
// exactly match versionNumber (see resourcePackFormatFor above), then
// enables it in options.txt. `log`, if given, receives human-readable
// status/error lines — callers wire this into the visible launch log so a
// failure here is never silently swallowed.
function installBundledResourcePack(dir, versionNumber, log = () => {}) {
  const src = bundledResourcePackPath();
  if (!fs.existsSync(src)) {
    log('[SolarClient] Resource pack skipped — bundled asset not found (dev checkout without resources/?).');
    return false;
  }

  const rpDir = path.join(dir, 'resourcepacks');
  fs.mkdirSync(rpDir, { recursive: true });
  const dest = path.join(rpDir, BUNDLED_RESOURCEPACK_FILE);

  // Leftover from an earlier version of this feature — harmless, but
  // Minecraft's pack scanner logs a line about any file it doesn't
  // recognize as a pack, so clean it up if it's still there.
  try { fs.unlinkSync(dest + '.sha1'); } catch { /* wasn't there */ }

  const targetFormat = resourcePackFormatFor(versionNumber);
  try {
    // Patch in-memory straight from the bundled source and write the
    // result directly to `dest`. Deliberately NOT "copy, then reopen dest
    // to patch it" — reopening a file that was just written a moment
    // earlier is exactly the kind of thing antivirus / file-lock timing
    // can intermittently break on Windows. `src` has been sitting on disk
    // since install, so reading it is safe.
    const zip = new (getAdmZip())(src);
    const entry = zip.getEntry('pack.mcmeta');
    if (!entry) throw new Error('pack.mcmeta missing from bundled resource pack');
    const meta = JSON.parse(zip.readAsText(entry));
    meta.pack = meta.pack || {};
    meta.pack.pack_format = targetFormat;
    // Drop every range-based field — see the comment above the table.
    delete meta.pack.supported_formats;
    delete meta.pack.min_format;
    delete meta.pack.max_format;
    zip.updateFile(entry, Buffer.from(JSON.stringify(meta, null, 2)));
    zip.writeZip(dest);
    log(`[SolarClient] Resource pack installed — pack_format ${targetFormat} for Minecraft ${versionNumber}.`);
  } catch (err) {
    // Fall back to a plain copy so the pack is at least present — a soft
    // "different version" warning beats no pack at all — but say so loudly
    // rather than eating the error like before.
    try { fs.copyFileSync(src, dest); } catch { /* nothing more we can do */ }
    log(`[SolarClient] WARNING: couldn't set resource pack format for ${versionNumber} (${err.message}). The pack was installed but may show as incompatible until you relaunch.`);
  }

  ensureResourcePackEnabled(dir, BUNDLED_RESOURCEPACK_FILE);
  return true;
}

ipcMain.handle('resourcepack:settings', async () => ({ enabled: autoInstallResourcePackEnabled() }));
ipcMain.handle('resourcepack:setEnabled', async (_e, { enabled }) => {
  store.set('autoInstallResourcePack', !!enabled);
  return { enabled: autoInstallResourcePackEnabled() };
});

// =====================================================================
// SOLARCLIENT MOD — auto-install and auto-update inside each instance.
//
// The mod jar is NOT bundled into the installer. If it were, the only way
// to ship a mod fix would be to ship a whole new launcher. Instead the jar
// lives on a GitHub release under a FIXED tag, and every instance checks
// that tag. Publish a new jar to the tag and everyone picks it up on their
// next launch — no launcher update, no reinstall.
//
// Why a fixed tag instead of "latest release": the launcher's own
// auto-updater prefers the VPS update manifest, and for GitHub fallback
// it reads the *latest* release. If a mod-only release ever became
// "Latest", that fallback would break. The mod release is therefore
// pinned to its own tag AND marked as a prerelease, which GitHub never
// promotes to "Latest".
//
// Asset naming is what makes this multi-version safe:
//     solarclient-<minecraft version>-<mod version>.jar
// e.g. solarclient-1.21.11-0.13.0.jar
// An instance only ever installs the jar whose <minecraft version> matches
// its own, so a 1.21.11 build is never dropped into a 1.20.1 instance.
// =====================================================================
const SOLAR_MOD_REPO = 'sharktoothgaming56-maker/solarclientsite';
const SOLAR_MOD_TAG = 'mod';
const SOLAR_MOD_RE = /^solarclient-(.+)-(\d[^-]*)\.jar$/i;
// Beta builds keep the mod out of the instance's mods folder and hand it to
// Fabric at launch (-Dfabric.addMods) straight from the launcher's cache.
const HIDDEN_SOLAR_MOD = String(app.getVersion()).includes('-beta');
const hiddenSolarJars = new Map(); // versionNumber -> cached jar path last handed to the game

function removeSolarJarsFromMods(modsDir, keep, log) {
  for (const file of fs.readdirSync(modsDir)) {
    if (file !== keep && SOLAR_MOD_RE.test(file)) {
      try {
        fs.unlinkSync(path.join(modsDir, file));
        log(`[SolarClient] Removed old mod ${file}.`);
      } catch { /* locked by a running game — next launch gets it */ }
    }
  }
}

/** JVM args that load the hidden mod, or [] when it isn't in use. */
function hiddenSolarModArgs(jarPath, loader) {
  if (!HIDDEN_SOLAR_MOD || typeof jarPath !== 'string') return [];
  return loader === 'quilt'
    ? [`-Dloader.addMods=${jarPath}`, `-Dfabric.addMods=${jarPath}`]
    : [`-Dfabric.addMods=${jarPath}`];
}
/** In-memory GitHub release asset list — skip network on warm relaunches. */
const SOLAR_MOD_META_TTL_MS = 15 * 60 * 1000;
let solarModMetaCache = { fetchedAt: 0, byMc: Object.create(null) };

async function warmSolarModMeta() {
  if ((Date.now() - solarModMetaCache.fetchedAt) < SOLAR_MOD_META_TTL_MS) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${SOLAR_MOD_REPO}/releases/tags/${SOLAR_MOD_TAG}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SolarClient' },
    });
    if (!res.ok) return;
    const rel = await res.json();
    const byMc = Object.create(null);
    const cmpVer = (a, b) => {
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
      }
      return 0;
    };
    for (const asset of rel.assets || []) {
      const m = SOLAR_MOD_RE.exec(asset.name || '');
      if (!m) continue;
      const mc = m[1], ver = m[2];
      const prev = byMc[mc];
      if (!prev || cmpVer(ver, prev.ver) > 0) {
        byMc[mc] = {
          ver,
          name: asset.name,
          url: asset.browser_download_url,
          size: asset.size,
          digest: asset.digest || '',
        };
      }
    }
    solarModMetaCache = { fetchedAt: Date.now(), byMc };
  } catch { /* offline — launch path still works */ }
}

function autoInstallSolarModEnabled() {
  // Opt-out rather than opt-in: the mod is the reason the launcher exists,
  // so a fresh install should just have it.
  return store.get('autoInstallSolarMod', true) !== false;
}

function solarModCacheDir() {
  const dir = path.join(app.getPath('userData'), 'mod-cache');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Put the right SolarClient mod jar in this instance's mods folder, and
 * remove any older SolarClient jar that's already there.
 *
 * Safe to call on every launch — network is skipped when a jar is already
 * staged and we checked GitHub within SOLAR_MOD_META_TTL_MS. Failures fall
 * back to the cached jar rather than blocking the launch.
 * Returns true if a jar is in place afterwards. In beta builds the jar stays
 * in the cache instead and its path is returned for hiddenSolarModArgs.
 */
async function ensureSolarMod(dir, versionNumber, loader, log = () => {}) {
  if (!autoInstallSolarModEnabled()) return false;
  // Fabric-family only — the mod is a Fabric mod, and dropping a jar into a
  // vanilla or Forge instance would at best do nothing and at worst crash it.
  if (loader !== 'fabric' && loader !== 'quilt') return false;

  const modsDir = path.join(dir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const cacheDir = solarModCacheDir();

  // An unpublished local build (the five-block floor) wins over the GitHub jar
  // when this file is present. Anyone without it still gets the release jar.
  const localOverride = path.join(cacheDir, `solarclient-local-${versionNumber}.jar`);
  if (fs.existsSync(localOverride)) {
    if (HIDDEN_SOLAR_MOD) {
      removeSolarJarsFromMods(modsDir, null, log);
      hiddenSolarJars.set(versionNumber, localOverride);
      return localOverride;
    }
    removeSolarJarsFromMods(modsDir, path.basename(localOverride), log);
    const dest = path.join(modsDir, path.basename(localOverride));
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== fs.statSync(localOverride).size) {
      fs.copyFileSync(localOverride, dest);
    }
    return true;
  }

  const localJars = () => fs.readdirSync(modsDir)
    .filter((f) => { const m = SOLAR_MOD_RE.exec(f); return m && m[1] === versionNumber; })
    .sort();

  // Instant warm path: jar already in mods/, meta still fresh, name matches
  // last known wanted (or we have no newer info yet).
  if (HIDDEN_SOLAR_MOD) {
    const cachedWanted = solarModMetaCache.byMc[versionNumber];
    const metaFresh = (Date.now() - solarModMetaCache.fetchedAt) < SOLAR_MOD_META_TTL_MS;
    const known = hiddenSolarJars.get(versionNumber);
    if (metaFresh && known && fs.existsSync(known)
      && (!cachedWanted || path.basename(known) === cachedWanted.name)) {
      removeSolarJarsFromMods(modsDir, null, log);
      return known;
    }
  } else {
    const local = localJars();
    const newest = local[local.length - 1];
    const cachedWanted = solarModMetaCache.byMc[versionNumber];
    const metaFresh = (Date.now() - solarModMetaCache.fetchedAt) < SOLAR_MOD_META_TTL_MS;
    if (newest && metaFresh && (!cachedWanted || cachedWanted.name === newest)) {
      return true;
    }
  }

  // Which jar does this instance want? Ask GitHub only when meta is stale.
  let wanted = null; // { name, url, size, digest }
  const metaFresh = (Date.now() - solarModMetaCache.fetchedAt) < SOLAR_MOD_META_TTL_MS;
  if (metaFresh && solarModMetaCache.byMc[versionNumber]) {
    wanted = solarModMetaCache.byMc[versionNumber];
  } else {
    try {
      const res = await fetch(`https://api.github.com/repos/${SOLAR_MOD_REPO}/releases/tags/${SOLAR_MOD_TAG}`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'SolarClient' },
      });
      if (res.ok) {
        const rel = await res.json();
        const byMc = Object.create(null);
        const cmpVer = (a, b) => {
          const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
          for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d;
          }
          return 0;
        };
        for (const asset of rel.assets || []) {
          const m = SOLAR_MOD_RE.exec(asset.name || '');
          if (!m) continue;
          const mc = m[1], ver = m[2];
          const prev = byMc[mc];
          if (!prev || cmpVer(ver, prev.ver) > 0) {
            byMc[mc] = {
              ver,
              name: asset.name,
              url: asset.browser_download_url,
              size: asset.size,
              digest: asset.digest || '',
            };
          }
        }
        solarModMetaCache = { fetchedAt: Date.now(), byMc };
        const hit = byMc[versionNumber];
        if (hit) wanted = hit;
        else log(`[SolarClient] No mod build published for Minecraft ${versionNumber} yet — skipping.`);
      } else {
        log(`[SolarClient] Mod check failed (HTTP ${res.status}) — using the cached copy if there is one.`);
      }
    } catch (err) {
      log(`[SolarClient] Mod check failed (${err.message}) — using the cached copy if there is one.`);
    }
  }

  // Offline / lookup failed: fall back to the newest cached jar for this
  // Minecraft version, so a flaky connection doesn't strip the mod out of
  // an instance that was working fine yesterday.
  if (!wanted) {
    const cached = fs.readdirSync(cacheDir)
      .filter(f => { const m = SOLAR_MOD_RE.exec(f); return m && m[1] === versionNumber; })
      .sort();
    const fallback = cached[cached.length - 1];
    if (!fallback) return false;
    wanted = { name: fallback, url: null, size: null, digest: '' };
  }

  const cachePath = path.join(cacheDir, wanted.name);

  // Download only when the cache doesn't already hold this exact file.
  // Size is enough — full sha256 of a multi‑MB jar on every launch was a
  // free stall even when nothing changed.
  let needsDownload = !fs.existsSync(cachePath);
  if (!needsDownload && wanted.size != null) {
    try {
      if (fs.statSync(cachePath).size !== wanted.size) needsDownload = true;
    } catch { needsDownload = true; }
  }

  if (needsDownload && wanted.url) {
    log(`[SolarClient] Downloading mod ${wanted.name}…`);
    await streamToFile(wanted.url, cachePath, { headers: { 'User-Agent': 'SolarClient' } });
  } else if (needsDownload) {
    return false; // wanted a file we can't reach and don't have
  }

  if (HIDDEN_SOLAR_MOD) {
    // Any copy left in mods/ would load twice next to the hidden one.
    removeSolarJarsFromMods(modsDir, null, log);
    hiddenSolarJars.set(versionNumber, cachePath);
    return cachePath;
  }

  // Clear out other SolarClient jars first — this is what makes an update
  // an update rather than two mods fighting over the same mod id.
  removeSolarJarsFromMods(modsDir, wanted.name, log);

  const dest = path.join(modsDir, wanted.name);
  const upToDate = fs.existsSync(dest)
    && (() => { try { return fs.statSync(dest).size === fs.statSync(cachePath).size; } catch { return false; } })();
  if (!upToDate) {
    fs.copyFileSync(cachePath, dest);
    log(`[SolarClient] Mod installed: ${wanted.name}`);
  }
  return true;
}

function writeOptionsTxt(dir, kvNew) {
  fs.mkdirSync(dir, { recursive: true });
  const optionsPath = path.join(dir, 'options.txt');
  const kv = new Map();
  if (fs.existsSync(optionsPath)) {
    for (const line of fs.readFileSync(optionsPath, 'utf-8').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) kv.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  for (const [k, v] of Object.entries(kvNew)) kv.set(k, String(v));
  fs.writeFileSync(optionsPath, Array.from(kv.entries()).map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
  return optionsPath;
}

function writeSodiumOptions(dir, tier, overrides = {}) {
  const cfgDir = path.join(dir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });
  const p = path.join(cfgDir, 'sodium-options.json');
  let s = {};
  if (fs.existsSync(p)) { try { s = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { s = {}; } }

  s.performance = { ...(s.performance || {}),
    chunk_builder_threads: 2,
    always_defer_chunk_updates: false,
    use_no_error_g_l_context: true,
  };
  s.advanced = { ...(s.advanced || {}),
    use_advanced_staging_buffers: true,
    cpu_render_ahead_limit: 3,
  };
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
  return p;
}

// Applied every launch (see applyPerfProfileForLaunch) AND on demand.
ipcMain.handle('perf:applyBestSettings', async (_e, { instanceName, versionNumber, tier, overrides }) => {
  const dir = instancePath(versionNumber, instanceName);
  const t = tier || 'mid';
  // Graphics-preserving: chunk scheduling only. Clouds, leaves, water, lighting,
  // particles, mipmaps, render distance, and entities stay as the instance saved them.
  applySolidFps(dir);
  store.set(`perfProfile.${versionNumber}|${instanceName}`, { tier: t, overrides: overrides || {}, at: Date.now() });
  return {
    applied: [
      'Graphics-preserving mode',
      'Video settings left as this instance saved them',
      'Chunk scheduling only',
    ],
    tier: t,
  };
});

// Read back what's actually on disk, so the UI shows the TRUTH rather than
// what we hoped we wrote.
ipcMain.handle('perf:readSettings', async (_e, { instanceName, versionNumber }) => {
  const dir = instancePath(versionNumber, instanceName);
  const optionsPath = path.join(dir, 'options.txt');
  const out = { exists: fs.existsSync(optionsPath), values: {} };
  if (out.exists) {
    for (const line of fs.readFileSync(optionsPath, 'utf-8').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) out.values[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  const saved = store.get(`perfProfile.${versionNumber}|${instanceName}`, null);
  out.profile = saved;
  return out;
});

ipcMain.handle('perf:getProfile', async (_e, { instanceName, versionNumber }) =>
  store.get(`perfProfile.${versionNumber}|${instanceName}`, null));

ipcMain.handle('perf:setProfile', async (_e, { instanceName, versionNumber, tier, overrides }) => {
  store.set(`perfProfile.${versionNumber}|${instanceName}`, { tier, overrides: overrides || {}, at: Date.now() });
  return true;
});

// THE FIX for "my settings don't apply": Minecraft rewrites options.txt from
// memory when it exits, wiping anything we wrote earlier. So we re-write the
// profile immediately BEFORE every launch — the game then boots from our
// values every single time.
function applyPerfProfileForLaunch(instanceName, versionNumber) {
  const key = `perfProfile.${versionNumber}|${instanceName}`;
  const profile = store.get(key, null);
  if (!profile) return null;
  const dir = instancePath(versionNumber, instanceName);
  try {
    // Video options stay as the instance saved them. Rewriting the high-tier
    // bundle here is what swapped clouds, mipmaps, biome blend and render distance.
    return profile;
  } catch { return null; }
}

// =====================================================================
// PER-MOD AUTO-TUNING — installing the mods is only half the job; each one
// ships defaults that are conservative. This writes a tuned config for every
// mod in the stack, scaled to the detected hardware tier. Every file below
// is the mod's real config path and real key names.
// =====================================================================
function tuneModConfigs(dir, tier, cores) {
  const cfg = path.join(dir, 'config');
  fs.mkdirSync(cfg, { recursive: true });
  const tuned = [];
  const writeJson = (rel, obj) => {
    const p = path.join(cfg, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let existing = {};
    if (fs.existsSync(p)) { try { existing = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { existing = {}; } }
    fs.writeFileSync(p, JSON.stringify({ ...existing, ...obj }, null, 2));
  };

  // --- Entity Culling: tighter culling on weaker machines ---
  try {
    writeJson('entityculling.json', {
      renderNametagsThroughWalls: false,
      tickCulling: true,
      sleepDelay: tier === 'low' ? 5 : 10,
      hitboxLimit: tier === 'low' ? 25 : 50,
      useCustomCulling: true,
    });
    tuned.push('Entity Culling');
  } catch { /* mod not installed */ }

  // --- Dynamic FPS: aggressive background throttling on low tier ---
  try {
    const dfps = [
      '# Tuned by SolarClient',
      'reduce-fps-when-unfocused = true',
      `unfocused-fps = ${tier === 'low' ? 1 : 30}`,
      'reduce-fps-when-hovered = false',
      'run-gc-on-unfocus = false',
      'mute-in-background = true',
      'volume-multiplier = 0.0',
      'idle-timeout = 60',
    ].join('\n');
    fs.writeFileSync(path.join(cfg, 'dynamic_fps.toml'), dfps + '\n');
    tuned.push('Dynamic FPS');
  } catch { /* ignore */ }

  // --- ImmediatelyFast: full fast-path rendering ---
  try {
    writeJson('immediatelyfast.json', {
      font_atlas_resizing: true,
      hud_batching: true,
      map_rendering: true,
      fast_text_lookup: true,
      fast_buffer_upload: true,
      experimental_disable_error_checking: tier !== 'low',
      experimental_screen_batching: true,
      experimental_sign_text_buffering: true,
    });
    tuned.push('ImmediatelyFast');
  } catch { /* ignore */ }

  // --- FerriteCore: every memory optimization on ---
  try {
    const fc = [
      '# Tuned by SolarClient',
      'replaceNeighborLookup = true',
      'useSmallThreadingDetector = true',
      'populateNeighborTable = true',
      'replacePropertyMap = true',
      'cacheMultipartPredicates = true',
      'multipartDeduplication = true',
      'replaceModelCache = true',
      'bakedQuadDeduplication = true',
      'useSmallModelCache = true',
      'compactFastMap = true',
    ].join('\n');
    fs.writeFileSync(path.join(cfg, 'ferritecore.mixin.properties'), fc + '\n');
    tuned.push('FerriteCore');
  } catch { /* ignore */ }

  // --- Lithium: defaults are already optimal; keep all mixins enabled ---
  try {
    fs.writeFileSync(path.join(cfg, 'lithium.properties'),
      '# Tuned by SolarClient — all optimizations enabled (Lithium defaults are optimal)\n');
    tuned.push('Lithium');
  } catch { /* ignore */ }

  // --- Sodium: chunk builder threads matched to the actual CPU ---
  try {
    const p = path.join(cfg, 'sodium-options.json');
    let s = {};
    if (fs.existsSync(p)) { try { s = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { s = {}; } }
    s.performance = { ...(s.performance || {}),
      // leave headroom for the render + main threads; 0 means "auto"
      chunk_build_defer_mode: 'ONE_FRAME',
      chunk_builder_threads: cores >= 8 ? 2 : 1,
      always_defer_chunk_updates: false,
      use_no_error_g_l_context: tier !== 'low',
    };
    s.advanced = { ...(s.advanced || {}), use_advanced_staging_buffers: true, cpu_render_ahead_limit: 3 };
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
    tuned.push('Sodium');
  } catch { /* ignore */ }

  return tuned;
}

ipcMain.handle('perf:tuneMods', async (_e, { instanceName, versionNumber, tier }) => {
  const dir = instancePath(versionNumber, instanceName);
  const cores = os.cpus().length || 4;
  const tuned = tuneModConfigs(dir, tier || 'mid', cores);
  store.set(`modTuning.${versionNumber}|${instanceName}`, { tier, tuned, at: Date.now() });
  return { tuned };
});

// =====================================================================
// CUSTOM BACKGROUND UPLOAD — copies the picked image into app data and
// returns a file:// URL the renderer can use directly.
// =====================================================================
ipcMain.handle('customize:pickBackground', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a background image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const src = result.filePaths[0];
  const bgDir = path.join(app.getPath('userData'), 'backgrounds');
  fs.mkdirSync(bgDir, { recursive: true });
  const dest = path.join(bgDir, `custom-${Date.now()}${path.extname(src).toLowerCase()}`);
  fs.copyFileSync(src, dest);
  const fileUrl = 'file:///' + dest.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
  return { path: dest, fileUrl };
});

bootMark('main.js evaluated');





