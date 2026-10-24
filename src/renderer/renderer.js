// Delegated click handlers on `document` (links, names, report flags,
// spoilers…) are replayed in panels popped out into their own window, so
// the ones registered while this file first runs are kept here.
const SC_DOC_CLICKS = [];
(() => {
  const types = new Set(['click', 'contextmenu', 'dblclick', 'auxclick']);
  document.addEventListener = function (type, fn, opts) {
    if (types.has(type)) SC_DOC_CLICKS.push([type, fn, opts]);
    return EventTarget.prototype.addEventListener.call(this, type, fn, opts);
  };
  setTimeout(() => { delete document.addEventListener; }, 0);
})();

/** Documents of popped-out panel windows, and whichever window was last used. */
const scPop = { docs: new Set(), active: document };
function scActiveDoc() {
  const d = scPop.active;
  return d !== document && scPop.docs.has(d) && !d.defaultView?.closed ? d : document;
}

// ---------- window controls ----------
document.getElementById('win-min').addEventListener('click', () => window.nebula.minimize());
document.getElementById('win-max').addEventListener('click', () => window.nebula.maximize());
document.getElementById('win-close').addEventListener('click', () => window.nebula.closeWindow());

// ---------- level / ore system ----------
// Images are bundled locally — minecraft.wiki returns 403 for hotlinks,
// which is why the remote URLs never loaded.
const ORES = [
  { name: 'Coal',      img: 'ores/coal.png',      color: '#8a8a8a' },
  { name: 'Copper',    img: 'ores/copper.png',    color: '#c46e3c' },
  { name: 'Lapis',     img: 'ores/lapis.png',     color: '#2662c9' },
  { name: 'Redstone',  img: 'ores/redstone.png',  color: '#d21e1e' },
  { name: 'Gold',      img: 'ores/gold.png',      color: '#fcd649' },
  { name: 'Iron',      img: 'ores/iron.png',      color: '#e6e6e6' },
  { name: 'Emerald',   img: 'ores/emerald.png',   color: '#2dd75f' },
  { name: 'Amethyst',  img: 'ores/amethyst.png',  color: '#a86ee6' },
  { name: 'Diamond',   img: 'ores/diamond.png',   color: '#5cebf5' },
  { name: 'Netherite', img: 'ores/netherite.png', color: '#8a7f78' },
];

// One ore tier every 10 levels — Netherite from 91 onward (level 100+ stays there).
const LEVELS_PER_ORE = 10;
function oreForLevel(level) {
  return ORES[Math.min(Math.floor((level - 1) / LEVELS_PER_ORE), ORES.length - 1)];
}

// =====================================================================
// THEME ENGINE — everything on the Customize tab lands here. Saved in
// localStorage so it survives restarts without any main-process round
// trips.
// =====================================================================
// `btn` pins the launch-button gradient; without it the gradient is derived
// from `a` (see accentButtonColors).
const ACCENTS = [
  { id: 'royal',  name: 'Purple',  a: '#835ecd', b: '#b48cff', btn: ['#835ecd', '#3c295c'] },
  { id: 'nebula', name: 'Solar',  a: '#9d6bff', b: '#e561d8' },
  { id: 'aurora', name: 'Aurora',  a: '#3ddc84', b: '#22b8cf' },
  { id: 'ocean',  name: 'Ocean',   a: '#38bdf8', b: '#6366f1' },
  { id: 'ember',  name: 'Ember',   a: '#ff8a3d', b: '#f43f5e' },
  { id: 'rose',   name: 'Rose',    a: '#fb7185', b: '#c084fc' },
  { id: 'gold',   name: 'Gold',    a: '#fbbf24', b: '#f97316' },
  { id: 'frost',  name: 'Frost',   a: '#a5b4fc', b: '#67e8f9' },
];

const defaultTheme = {
  bg: 'nebula', accent: 'royal', customAccent: '#835ecd', blur: 18, alpha: 34, sceneDim: 9,
  animations: true, particles: true, parallax: true, trail: false,
  perfMode: true, memMax: 4, memMin: 2, customBgUrl: null,
  fasterLaunch: false,
  lowGraphics: false,   // auto-enabled by the quality governor on weak GPUs
  customBgPosX: 50, customBgPosY: 50,
  monBgSync: true,
  monBg: 'nebula',
  launchStyle: 'purple', // beta only: 'purple' | 'glass'
  uiMotion: true,        // beta only: pop-downs, nav and button animations
  meteors: true,         // beta only: meteors and shooting stars across the background
};
let theme = { ...defaultTheme };
try { theme = { ...defaultTheme, ...JSON.parse(localStorage.getItem('nebula-theme') || '{}') }; } catch { /* fresh */ }
// One-shot: adopt Shark's tuned glass shell/dim as the new baseline.
if (localStorage.getItem('nebula-glass-defaults-v') !== '3') {
  theme.alpha = 34;
  theme.sceneDim = 9;
  localStorage.setItem('nebula-glass-defaults-v', '3');
  try { localStorage.setItem('nebula-theme', JSON.stringify(theme)); } catch { /* ignore */ }
}
function saveTheme() {
  localStorage.setItem('nebula-theme', JSON.stringify(theme));
  try { window.nebula.notifyThemeChanged?.(); } catch { /* monitor may not be open */ }
  if (typeof syncProfileLook === 'function') syncProfileLook();
  // memory / performance mode are part of what a preloaded game was started with
  if (typeof syncPreload === 'function') syncPreload();
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function currentAccent() {
  if (theme.accent === 'custom' && /^#[0-9a-f]{6}$/i.test(theme.customAccent || '')) {
    const [h, s, l] = hexToHsl(theme.customAccent);
    return { id: 'custom', name: 'Custom', a: theme.customAccent, b: hslToHex((h + 40) % 360, s, Math.min(0.75, l + 0.08)) };
  }
  return ACCENTS.find(x => x.id === theme.accent) || ACCENTS[0];
}

// A rich top-to-bottom fill in the accent's hue, toned so white text stays
// readable on bright colours like gold.
function accentButtonColors(accent) {
  if (accent.btn) return accent.btn;
  const [h, s] = hexToHsl(accent.a);
  return [
    hslToHex(h, Math.max(0.35, Math.min(0.6, s)), 0.55),
    hslToHex(h, Math.max(0.3, Math.min(0.45, s * 0.75)), 0.24),
  ];
}

const sceneCache = {};
function applyTheme() {
  const root = document.documentElement.style;
  const accent = currentAccent();
  root.setProperty('--accent', accent.a);
  root.setProperty('--accent2', accent.b);
  root.setProperty('--accent-glow', hexToRgba(accent.a, 0.5));
  const [btnTop, btnBot] = accentButtonColors(accent);
  root.setProperty('--btn-top', btnTop);
  root.setProperty('--btn-bot', btnBot);
  root.setProperty('--glass-blur', `${theme.blur}px`);
  root.setProperty('--glass-alpha', `${theme.alpha / 100}`);
  // Shell opacity drives liqui tint density (dark theme tokens × alpha).
  const a = theme.alpha / 100;
  root.setProperty('--lq-tint', `rgba(30, 32, 46, ${(0.35 + 0.45 * a).toFixed(3)})`);
  root.setProperty('--lq-tint-deep', `rgba(18, 20, 32, ${(0.18 + 0.35 * a).toFixed(3)})`);

  const isCustom = theme.bg === 'custom' && theme.customBgUrl;
  const bg = isCustom ? { kind: 'scene' } : (window.NEBULA_BACKGROUNDS[theme.bg] || window.NEBULA_BACKGROUNDS.nebula);
  document.body.dataset.bgKind = bg.kind;
  const sceneEl = document.getElementById('bg-scene');
  if (isCustom) {
    sceneEl.style.backgroundImage = `url("${theme.customBgUrl}")`;
    sceneEl.style.imageRendering = 'auto';
    sceneEl.style.backgroundPosition = `${theme.customBgPosX ?? 50}% ${theme.customBgPosY ?? 50}%`;
    sceneEl.classList.add('show');
  } else if (bg.kind === 'scene') {
    if (typeof bg.make !== 'function') {
      ensureBackgrounds().then(() => applyTheme()).catch(() => {});
      return;
    }
    if (!sceneCache[theme.bg]) sceneCache[theme.bg] = bg.make();
    sceneEl.style.backgroundImage = sceneCache[theme.bg];
    sceneEl.style.imageRendering = 'pixelated';
    sceneEl.style.backgroundPosition = 'center bottom';
    sceneEl.classList.add('show');
  } else {
    sceneEl.classList.remove('show');
  }
  document.querySelector('.bg-scene-dark').style.opacity = bg.kind === 'scene' ? (theme.sceneDim / 100) : 0;

  document.body.classList.toggle('no-anim', !theme.animations);
  document.body.classList.toggle('no-ui-motion', document.body.classList.contains('beta-layout') && theme.uiMotion === false);

  // PERF: this used to only set display:none on the canvas, which hides the
  // pixels but leaves the requestAnimationFrame loop running forever burning
  // a core to clearRect() an invisible canvas. Actually stop the loop.
  const sf = document.getElementById('starfield');
  sf.style.display = theme.particles ? '' : 'none';
  if (window.__starfield) {
    theme.particles ? window.__starfield.start() : window.__starfield.stop();
  }
  window.__meteors?.sync();

  // Low-graphics mode strips the remaining blur passes and the nebula. It is
  // separate from theme.perfMode, which is about Java launch flags -- this
  // one is purely about what the launcher's own window costs to draw.
  document.body.classList.toggle('perf-lite', !!theme.lowGraphics);
  if (window.SolarLiquidGlass) window.SolarLiquidGlass.refreshAll();
}
applyTheme();

let _backgroundsPromise = null;
function ensureBackgrounds() {
  if (window.__nebulaBackgroundsFull) return Promise.resolve();
  if (_backgroundsPromise) return _backgroundsPromise;
  _backgroundsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'backgrounds.js';
    s.onload = () => { window.__nebulaBackgroundsFull = true; resolve(); };
    s.onerror = () => reject(new Error('backgrounds.js failed to load'));
    document.head.appendChild(s);
  });
  return _backgroundsPromise;
}

// If the user last used a procedural scene, load generators then re-apply.
(function bootSceneBg() {
  const id = theme.bg;
  if (id === 'custom' || id === 'nebula' || id === 'void' || !id) return;
  ensureBackgrounds().then(() => applyTheme()).catch(() => {});
})();

// ---------- starfield canvas (twinkle + occasional shooting star) ----------
//
// PERF NOTES, because this innocuous-looking canvas was one of the two
// biggest sources of lag in the whole launcher:
//
//   1. It ran requestAnimationFrame FOREVER -- including while particles
//      were switched off (it looped just to call clearRect), while the
//      window was minimised, and while you were in-game with the launcher
//      behind a fullscreen Minecraft. The loop now stops dead and is
//      restarted by an event, so an idle launcher costs literally zero.
//
//   2. It cleared and repainted the ENTIRE window-sized canvas every tick.
//      That canvas sits at the bottom of the stack, so every repaint marked
//      the full viewport dirty -- and every backdrop-filter above it had to
//      re-blur. One ambient star effect was driving ~40 gaussian blur passes
//      30 times a second. Now the twinkle is done by compositing two
//      pre-rendered star layers that are drawn ONCE into offscreen canvases;
//      per frame we only globalAlpha-blit two bitmaps, and only into the
//      strip that actually changed.
//
//   3. Shooting stars are drawn into a small separate canvas region and only
//      when one is actually alive, so the common case (no shooter) does a
//      2-blit frame and nothing else.
(function starfield() {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
  let w = 0, h = 0;
  let layerA = null, layerB = null;    // pre-rendered star fields
  let shooters = [];
  let running = false, rafId = 0, timer = 0;

  // Cheap fixed-point twinkle: instead of Math.sin() per star per frame,
  // the two layers hold interleaved stars and we cross-fade between them.
  function buildLayers() {
    const count = Math.floor((w * h) / 9000);
    const make = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, w); c.height = Math.max(1, h);
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      return { c, g };
    };
    const A = make(), B = make();
    for (let i = 0; i < count; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      const r = Math.random() * 1.3 + 0.3;
      // Each star lands in one layer or the other; cross-fading the layers
      // makes them twinkle out of phase without any per-star math at runtime.
      const g = (i % 2 === 0 ? A : B).g;
      g.globalAlpha = 0.35 + Math.random() * 0.5;
      g.fillRect(x, y, r, r);
    }
    layerA = A.c; layerB = B.c;
  }

  function resize() {
    const nw = window.innerWidth, nh = window.innerHeight;
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    buildLayers();
  }

  // ~10fps ambience — enough twinkle, half the GPU cost under glass. A timer
  // paces it so the page isn't woken on every display refresh in between.
  const tick = () => { timer = 0; rafId = requestAnimationFrame(frame); };
  function frame(t) {
    rafId = 0;
    if (!running) return;
    timer = setTimeout(tick, 100);

    if (!layerA || document.body.classList.contains('skin-grabbing')) return;
    ctx.clearRect(0, 0, w, h);

    if (theme.animations) {
      // one cheap sine for the whole field, not one per star
      const phase = (Math.sin(t / 1400) + 1) / 2;   // 0..1
      ctx.globalAlpha = 0.45 + 0.45 * phase;
      ctx.drawImage(layerA, 0, 0);
      ctx.globalAlpha = 0.9 - 0.45 * phase;
      ctx.drawImage(layerB, 0, 0);
    } else {
      ctx.globalAlpha = 0.7;
      ctx.drawImage(layerA, 0, 0);
      ctx.drawImage(layerB, 0, 0);
    }

    const meteorsOn = theme.meteors !== false && document.body.classList.contains('beta-layout');
    if (theme.animations && !meteorsOn && Math.random() < 0.006 && shooters.length < 2) {
      shooters.push({
        x: Math.random() * w * 0.8, y: Math.random() * h * 0.3,
        vx: 7 + Math.random() * 5, vy: 3 + Math.random() * 2, life: 1,
      });
    }
    if (shooters.length) {
      ctx.strokeStyle = '#cdb8ff';
      ctx.lineWidth = 1.6;
      for (const sh of shooters) {
        sh.x += sh.vx; sh.y += sh.vy; sh.life -= 0.02;
        ctx.globalAlpha = Math.max(0, sh.life) * 0.9;
        ctx.beginPath();
        ctx.moveTo(sh.x, sh.y);
        ctx.lineTo(sh.x - sh.vx * 5, sh.y - sh.vy * 5);
        ctx.stroke();
      }
      shooters = shooters.filter(s => s.life > 0 && s.x < w + 80 && s.y < h + 80);
    }
    ctx.globalAlpha = 1;
  }

  function start() {
    if (running) return;
    if (!theme.particles || document.hidden || !document.hasFocus()) return;
    resize();
    running = true;
    if (!rafId && !timer) rafId = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (timer) { clearTimeout(timer); timer = 0; }
    if (w && h) ctx.clearRect(0, 0, w, h);
  }

  // Anything that can change whether ambience is worth paying for.
  // Rebuilding the star layers is a full-window redraw; do it once the window stops changing size.
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(resize, 150); }, { passive: true });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('focus', start);
  window.addEventListener('blur', () => {
    // Also flag the body so CSS can pause the nebula drift -- a compositor
    // animation keeps running when the window is unfocused unless told not to.
    document.body.classList.add('win-blurred');
    stop();
  });
  window.addEventListener('focus', () => document.body.classList.remove('win-blurred'));

  // applyTheme() flips theme.particles; expose the controls so it can
  // start/stop us instead of us polling a flag every frame.
  window.__starfield = { start, stop };
  // Defer ambience until after the first paint so glass shells win the
  // compositor race on cold start.
  requestAnimationFrame(() => requestAnimationFrame(() => start()));
})();

// ---------- meteors and shooting stars (beta) ----------
// Each streak is one element flown by a compositor animation, so nothing runs
// on the main thread while it crosses the sky. Quick thin shooting stars,
// slower glowing meteors, and now and then a shower of several at once.
(function meteors() {
  const sky = document.getElementById('bg-meteors');
  if (!sky) return;
  let timer = 0;
  const wanted = () => document.body.classList.contains('beta-layout') && theme.meteors !== false
    && theme.animations && !theme.lowGraphics && !document.hidden && document.hasFocus()
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fly(kind, from) {
    if (sky.childElementCount > 9) return;
    const W = sky.clientWidth || window.innerWidth, H = sky.clientHeight || window.innerHeight;
    const big = kind === 'meteor';
    const dir = from?.dir ?? (Math.random() < 0.72 ? 1 : -1);
    const angle = from ? from.angle + (Math.random() * 6 - 3) : (big ? 22 : 16) + Math.random() * 22;
    const rad = angle * Math.PI / 180;
    const dist = Math.hypot(W, H) * (big ? 0.5 + Math.random() * 0.3 : 0.35 + Math.random() * 0.35);
    const x0 = from ? from.x + (Math.random() - 0.5) * 260 : (dir > 0 ? -0.1 + Math.random() * 0.75 : 0.35 + Math.random() * 0.75) * W;
    const y0 = from ? from.y + (Math.random() - 0.5) * 140 : -30 + Math.random() * H * 0.45;
    const x1 = x0 + Math.cos(rad) * dist * dir, y1 = y0 + Math.sin(rad) * dist;
    const rot = dir > 0 ? angle : 180 - angle;
    const el = document.createElement('i');
    el.className = `mt ${kind}`;
    el.style.setProperty('--len', `${Math.round(big ? 260 + Math.random() * 200 : 130 + Math.random() * 110)}px`);
    sky.appendChild(el);
    const at = (x, y) => `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) rotate(${rot.toFixed(1)}deg)`;
    const a = el.animate([
      { transform: at(x0, y0), opacity: 0 },
      { opacity: 1, offset: 0.14 },
      { opacity: big ? 1 : 0.9, offset: 0.7 },
      { transform: at(x1, y1), opacity: 0 },
    ], { duration: big ? 1500 + Math.random() * 800 : 650 + Math.random() * 450, easing: 'cubic-bezier(.3,.1,.6,1)' });
    a.onfinish = a.oncancel = () => el.remove();
    return { x: x0, y: y0, dir, angle };
  }

  function next() {
    timer = 0;
    if (!wanted()) return;
    if (document.body.classList.contains('skin-grabbing')) { timer = setTimeout(next, 800); return; }
    const r = Math.random();
    if (r < 0.08) {
      // Shower: a handful from the same patch of sky, a beat apart.
      const lead = fly('meteor');
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) setTimeout(() => { if (wanted()) fly('star', lead); }, 140 + i * (120 + Math.random() * 200));
    } else {
      fly(r < 0.36 ? 'meteor' : 'star');
    }
    timer = setTimeout(next, 2200 + Math.random() * 4800);
  }

  function sync() {
    if (wanted()) { if (!timer) timer = setTimeout(next, 900 + Math.random() * 1500); }
    else {
      clearTimeout(timer); timer = 0;
      sky.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    }
  }
  window.__meteors = { sync, fly };
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
})();

// Main flips this while Minecraft is running; style.css then freezes every
// animation whenever the game, not the launcher, has focus.
window.nebula.onGameMode(({ active }) => document.body.classList.toggle('game-running', !!active));
window.nebula.getGameMode().then(({ active }) => document.body.classList.toggle('game-running', !!active)).catch(() => {});
// A window that starts unfocused never receives a blur event.
if (!document.hasFocus()) document.body.classList.add('win-blurred');

// ---------- customize tab controls ----------
function renderCustomize() {
  ensureBackgrounds().then(() => renderCustomizeNow());
}
function renderCustomizeNow() {
  // background presets
  const grid = document.getElementById('bg-preset-grid');
  grid.innerHTML = '';
  for (const [id, bg] of Object.entries(window.NEBULA_BACKGROUNDS)) {
    const card = document.createElement('div');
    card.className = 'bg-preset' + (theme.bg === id ? ' active' : '');
    const thumbClass = bg.kind === 'nebula' ? 'thumb nebula-thumb' : bg.kind === 'void' ? 'thumb void-thumb' : 'thumb';
    card.innerHTML = `<div class="${thumbClass}"></div><div class="label">${bg.name}</div>`;
    if (bg.kind === 'scene') {
      if (!sceneCache[id]) sceneCache[id] = bg.make();
      card.querySelector('.thumb').style.backgroundImage = sceneCache[id];
    }
    card.addEventListener('click', () => { theme.bg = id; saveTheme(); applyTheme(); renderCustomize(); });
    grid.appendChild(card);
  }
  // "your own photo" tile
  const custom = document.createElement('div');
  custom.className = 'bg-preset' + (theme.bg === 'custom' ? ' active' : '');
  const hasImg = !!theme.customBgUrl;
  custom.innerHTML = `<div class="thumb custom-thumb${hasImg ? ' has-image' : ''}">＋</div><div class="label">Your photo</div>${hasImg ? '<div class="bg-custom-remove">Remove photo</div><div class="bg-custom-crop">Adjust crop</div>' : ''}`;
  if (hasImg) custom.querySelector('.thumb').style.backgroundImage = `url("${theme.customBgUrl}")`;
  custom.querySelector('.thumb').addEventListener('click', async () => {
    if (theme.customBgUrl && theme.bg !== 'custom') { theme.bg = 'custom'; saveTheme(); applyTheme(); renderCustomize(); return; }
    const picked = await window.nebula.pickBackgroundImage();
    if (!picked) return;
    theme.customBgUrl = picked.fileUrl;
    theme.bg = 'custom';
    theme.customBgPosX = 50; theme.customBgPosY = 50; // reset crop for a new photo
    saveTheme(); applyTheme(); renderCustomize();
    showToast('Background set', 'Your photo is now the launcher background.', 'success');
    openCropModal();
  });
  custom.querySelector('.bg-custom-remove')?.addEventListener('click', () => {
    theme.customBgUrl = null;
    if (theme.bg === 'custom') theme.bg = 'nebula';
    saveTheme(); applyTheme(); renderCustomize();
  });
  custom.querySelector('.bg-custom-crop')?.addEventListener('click', (e) => { e.stopPropagation(); openCropModal(); });
  grid.appendChild(custom);

  // Monitor background presets (+ sync toggle)
  const monSync = document.getElementById('mon-bg-sync');
  const monGrid = document.getElementById('mon-bg-preset-grid');
  if (monSync) {
    monSync.checked = theme.monBgSync !== false;
    monSync.onchange = () => {
      theme.monBgSync = monSync.checked;
      saveTheme();
      renderCustomize();
    };
  }
  if (monGrid) {
    monGrid.innerHTML = '';
    monGrid.style.opacity = theme.monBgSync !== false ? '0.45' : '1';
    monGrid.style.pointerEvents = theme.monBgSync !== false ? 'none' : 'auto';
    const monActive = theme.monBgSync !== false ? theme.bg : (theme.monBg || 'nebula');
    for (const [id, bg] of Object.entries(window.NEBULA_BACKGROUNDS)) {
      const card = document.createElement('div');
      card.className = 'bg-preset' + (monActive === id ? ' active' : '');
      const thumbClass = bg.kind === 'nebula' ? 'thumb nebula-thumb' : bg.kind === 'void' ? 'thumb void-thumb' : 'thumb';
      card.innerHTML = `<div class="${thumbClass}"></div><div class="label">${bg.name}</div>`;
      if (bg.kind === 'scene') {
        if (!sceneCache[id]) sceneCache[id] = bg.make();
        card.querySelector('.thumb').style.backgroundImage = sceneCache[id];
      }
      card.addEventListener('click', () => {
        theme.monBg = id;
        theme.monBgSync = false;
        if (monSync) monSync.checked = false;
        saveTheme();
        renderCustomize();
      });
      monGrid.appendChild(card);
    }
    // Your photo / Remove / Adjust crop for Monitor (same as launcher bg).
    const monCustom = document.createElement('div');
    const monCustomActive = monActive === 'custom' || (!theme.monBgSync && theme.monBg === 'custom');
    monCustom.className = 'bg-preset' + (monCustomActive ? ' active' : '');
    const monHasImg = !!theme.customBgUrl;
    monCustom.innerHTML = `<div class="thumb custom-thumb${monHasImg ? ' has-image' : ''}">＋</div><div class="label">Your photo</div>${monHasImg ? '<div class="bg-custom-remove">Remove photo</div><div class="bg-custom-crop">Adjust crop</div>' : ''}`;
    if (monHasImg) monCustom.querySelector('.thumb').style.backgroundImage = `url("${theme.customBgUrl}")`;
    monCustom.querySelector('.thumb').addEventListener('click', async () => {
      if (theme.customBgUrl && theme.monBg !== 'custom') {
        theme.monBg = 'custom';
        theme.monBgSync = false;
        if (monSync) monSync.checked = false;
        saveTheme();
        renderCustomize();
        return;
      }
      const picked = await window.nebula.pickBackgroundImage();
      if (!picked) return;
      theme.customBgUrl = picked.fileUrl;
      theme.monBg = 'custom';
      theme.monBgSync = false;
      theme.customBgPosX = 50; theme.customBgPosY = 50;
      if (monSync) monSync.checked = false;
      saveTheme();
      renderCustomize();
      showToast('Monitor background set', 'Your photo will show on the Game Monitor.', 'success');
      openCropModal();
    });
    monCustom.querySelector('.bg-custom-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (theme.monBg === 'custom') theme.monBg = 'nebula';
      saveTheme();
      renderCustomize();
    });
    monCustom.querySelector('.bg-custom-crop')?.addEventListener('click', (e) => { e.stopPropagation(); openCropModal(); });
    monGrid.appendChild(monCustom);
  }

  // accents
  const row = document.getElementById('accent-row');
  row.innerHTML = '';
  for (const a of ACCENTS) {
    const sw = document.createElement('div');
    sw.className = 'accent-swatch' + (theme.accent === a.id ? ' active' : '');
    sw.title = a.name;
    sw.dataset.name = a.name;
    sw.style.background = a.btn ? `linear-gradient(135deg, ${a.btn[0]}, ${a.btn[1]})` : `linear-gradient(135deg, ${a.a}, ${a.b})`;
    sw.style.color = a.a;
    sw.addEventListener('click', () => { theme.accent = a.id; saveTheme(); applyTheme(); renderCustomize(); });
    row.appendChild(sw);
  }
  const wheel = document.createElement('label');
  const pickHex = /^#[0-9a-f]{6}$/i.test(theme.customAccent || '') ? theme.customAccent : '#835ecd';
  wheel.className = 'accent-swatch accent-wheel' + (theme.accent === 'custom' ? ' active' : '');
  wheel.title = 'Pick any color';
  wheel.dataset.name = 'Custom';
  wheel.style.color = pickHex;
  wheel.style.setProperty('--wheel-pick', pickHex);
  wheel.innerHTML = `<input type="color" value="${pickHex}" aria-label="Pick any accent color">`;
  const picker = wheel.querySelector('input');
  picker.addEventListener('input', () => {
    theme.accent = 'custom';
    theme.customAccent = picker.value;
    wheel.style.setProperty('--wheel-pick', picker.value);
    row.querySelectorAll('.accent-swatch').forEach((s) => s.classList.toggle('active', s === wheel));
    applyTheme();
    if (betaLayoutOn()) cuPaintTop();
  });
  picker.addEventListener('change', () => { saveTheme(); renderCustomize(); });
  row.appendChild(wheel);
  // sliders/toggles
  document.getElementById('glass-alpha').value = theme.alpha;
  document.getElementById('glass-alpha-label').textContent = theme.alpha;
  document.getElementById('anim-toggle').checked = theme.animations;
  document.getElementById('ui-motion-toggle').checked = theme.uiMotion !== false;
  document.getElementById('particles-toggle').checked = theme.particles;
  document.getElementById('meteors-toggle').checked = theme.meteors !== false;
  document.getElementById('parallax-toggle').checked = theme.parallax;
  document.getElementById('trail-toggle').checked = theme.trail;
  document.getElementById('lowgfx-toggle').checked = !!theme.lowGraphics;
  document.getElementById('scene-dim').value = theme.sceneDim;
  document.getElementById('scene-dim-label').textContent = theme.sceneDim;
  syncLiquidOpticsUI();
  if (betaLayoutOn()) cuPaint();
}

// ---------- background crop tool ----------
// Drag inside the preview to choose which part of the photo stays
// centered once it's scaled to fill the window (cover-fit always crops
// something off the edges — this just lets you pick which part).
function openCropModal() {
  if (!theme.customBgUrl) return;
  const overlay = document.getElementById('crop-modal');
  const box = document.getElementById('crop-box');
  box.style.backgroundImage = `url("${theme.customBgUrl}")`;
  let x = theme.customBgPosX ?? 50, y = theme.customBgPosY ?? 50;
  box.style.backgroundPosition = `${x}% ${y}%`;
  overlay.classList.remove('hidden');

  let dragging = false;
  function setFromEvent(e) {
    const rect = box.getBoundingClientRect();
    x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    box.style.backgroundPosition = `${x}% ${y}%`;
  }
  function onDown(e) { dragging = true; setFromEvent(e); }
  function onMove(e) { if (dragging) setFromEvent(e); }
  function onUp() { dragging = false; }
  box.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  function cleanup() {
    box.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    overlay.classList.add('hidden');
  }
  document.getElementById('crop-save').onclick = () => {
    theme.customBgPosX = Math.round(x);
    theme.customBgPosY = Math.round(y);
    saveTheme(); applyTheme();
    cleanup();
    showToast('Crop saved', 'Your background photo is positioned.', 'success');
  };
  document.getElementById('crop-cancel').onclick = cleanup;
}
document.getElementById('glass-alpha').addEventListener('input', (e) => {
  theme.alpha = Number(e.target.value);
  document.getElementById('glass-alpha-label').textContent = theme.alpha;
  saveTheme(); applyTheme();
});
document.getElementById('anim-toggle').addEventListener('change', (e) => { theme.animations = e.target.checked; saveTheme(); applyTheme(); });
document.getElementById('ui-motion-toggle').addEventListener('change', (e) => { theme.uiMotion = e.target.checked; saveTheme(); applyTheme(); });
document.getElementById('particles-toggle').addEventListener('change', (e) => { theme.particles = e.target.checked; saveTheme(); applyTheme(); });
document.getElementById('meteors-toggle').addEventListener('change', (e) => { theme.meteors = e.target.checked; saveTheme(); applyTheme(); });
document.getElementById('parallax-toggle').addEventListener('change', (e) => { theme.parallax = e.target.checked; saveTheme(); if (!theme.parallax) resetParallax(); });
document.getElementById('trail-toggle').addEventListener('change', (e) => { theme.trail = e.target.checked; saveTheme(); });
// Lightweight graphics. The quality governor sets theme.lowGraphics on its
// own when it measures dropped frames; this is how a user overrides that
// decision in either direction, and turning it OFF also stops the governor
// from silently switching it back on later in the session.
document.getElementById('lowgfx-toggle').addEventListener('change', (e) => {
  theme.lowGraphics = e.target.checked;
  window.__governorOverridden = true;
  saveTheme();
  applyTheme();
});
document.getElementById('scene-dim').addEventListener('input', (e) => {
  theme.sceneDim = Number(e.target.value);
  document.getElementById('scene-dim-label').textContent = theme.sceneDim;
  saveTheme(); applyTheme();
});

// ---------- liquid glass optics (liqui.design dials) ----------
function syncLiquidOpticsUI() {
  if (!window.SolarLiquidGlass) return;
  const o = SolarLiquidGlass.getOptics();
  const set = (id, val, labelFn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    const lab = document.getElementById(id + '-label');
    if (lab) lab.textContent = labelFn ? labelFn(val) : val;
  };
  set('lq-refraction', o.refraction);
  set('lq-bezel', o.bezel);
  set('lq-frost', Math.round(o.frost * 100), () => Number(o.frost).toFixed(2));
  set('lq-blur', o.blur);
  set('lq-specular', Math.round(o.specular * 100), () => Number(o.specular).toFixed(2));
  const dispUi = o.dispersion > 1 ? o.dispersion : Math.round(o.dispersion * 100);
  set('lq-dispersion', dispUi, () => String(dispUi));
  const profile = document.getElementById('lq-profile');
  const material = document.getElementById('lq-material');
  if (profile) profile.value = o.profile || 'squircle';
  if (material) material.value = o.material || 'auto';
}

function wireLiquidOptics() {
  if (!window.SolarLiquidGlass) return;
  // Prior builds' quality governor auto-saved lowGraphics=true / material frost,
  // which killed refraction. Undo that once so liquid glass looks like before.
  if (!localStorage.getItem('nebula-lq-restored-v2')) {
    if (theme.lowGraphics) {
      theme.lowGraphics = false;
      saveTheme();
      applyTheme();
    }
    try {
      const raw = localStorage.getItem('nebula-liquid-optics');
      if (raw) {
        const o = JSON.parse(raw);
        if (o.material === 'frost') {
          o.material = 'auto';
          localStorage.setItem('nebula-liquid-optics', JSON.stringify(o));
        }
      }
    } catch { /* ignore */ }
    localStorage.setItem('nebula-lq-restored-v2', '1');
  }
  SolarLiquidGlass.init();
  syncLiquidOpticsUI();

  const onNum = (id, key, map) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const raw = Number(el.value);
      const val = map ? map(raw) : raw;
      SolarLiquidGlass.setOptics({ [key]: val });
      const lab = document.getElementById(id + '-label');
      if (lab) {
        if (key === 'frost' || key === 'specular') lab.textContent = Number(val).toFixed(2);
        else if (key === 'dispersion') lab.textContent = String(raw);
        else lab.textContent = String(raw);
      }
    });
  };
  onNum('lq-refraction', 'refraction');
  onNum('lq-bezel', 'bezel');
  onNum('lq-frost', 'frost', (v) => v / 100);
  onNum('lq-blur', 'blur');
  onNum('lq-specular', 'specular', (v) => v / 100);
  onNum('lq-dispersion', 'dispersion', (v) => v / 100);

  document.getElementById('lq-profile')?.addEventListener('change', (e) => {
    SolarLiquidGlass.setOptics({ profile: e.target.value });
  });
  document.getElementById('lq-material')?.addEventListener('change', (e) => {
    SolarLiquidGlass.setOptics({ material: e.target.value });
  });
  document.getElementById('lq-reset')?.addEventListener('click', () => {
    SolarLiquidGlass.resetOptics();
    syncLiquidOpticsUI();
  });
}
wireLiquidOptics();

// ---------- customize extras (beta): themes, live preview, share codes ----------
const CU_THEMES = [
  { id: 'solar', name: 'Solar', bg: 'nebula', accent: 'royal', alpha: 34, sceneDim: 9 },
  { id: 'pop', name: 'Nebula Pop', bg: 'nebula', accent: 'nebula', alpha: 34, sceneDim: 9 },
  { id: 'meadow', name: 'Meadow', bg: 'plains', accent: 'aurora', alpha: 48, sceneDim: 34 },
  { id: 'golden', name: 'Golden Hour', bg: 'sunset', accent: 'gold', alpha: 46, sceneDim: 30 },
  { id: 'sakura', name: 'Sakura', bg: 'cherry', accent: 'rose', alpha: 48, sceneDim: 36 },
  { id: 'frostbite', name: 'Frostbite', bg: 'frozen', accent: 'frost', alpha: 48, sceneDim: 36 },
  { id: 'abyss', name: 'Abyss', bg: 'ocean', accent: 'ocean', alpha: 46, sceneDim: 28 },
  { id: 'inferno', name: 'Inferno', bg: 'nether', accent: 'ember', alpha: 46, sceneDim: 30 },
  { id: 'ender', name: 'Ender', bg: 'end', accent: 'nebula', alpha: 42, sceneDim: 16 },
  { id: 'midnight', name: 'Midnight', bg: 'void', accent: 'ocean', alpha: 52, sceneDim: 9 },
];
const CU_KEYS = ['bg', 'accent', 'customAccent', 'alpha', 'sceneDim', 'launchStyle'];
const CU_HEX = /^#[0-9a-f]{6}$/i;
const cuSnapshot = () => Object.fromEntries(CU_KEYS.map((k) => [k, theme[k]]));
const cuMatch = () => CU_THEMES.find((t) => t.bg === theme.bg && t.accent === theme.accent) || null;

// CSS declarations (not a shorthand value): scene images can be several layers.
function cuBgFill(id, accentA) {
  const img = (src, pos) => `background-color:#0c0818;background-image:${src};background-size:cover;background-repeat:no-repeat;background-position:${pos}`;
  if (id === 'custom' && theme.customBgUrl) return img(`url("${theme.customBgUrl}")`, `${theme.customBgPosX ?? 50}% ${theme.customBgPosY ?? 50}%`);
  const bg = window.NEBULA_BACKGROUNDS?.[id];
  if (bg?.kind === 'scene' && typeof bg.make === 'function') {
    if (!sceneCache[id]) sceneCache[id] = bg.make();
    return img(sceneCache[id], 'center bottom');
  }
  if (bg?.kind === 'void') return 'background:#0a0714';
  return `background:radial-gradient(circle at 30% 30%, ${accentA}, #1a1030 70%), #0c0818`;
}

function cuApply(next, label) {
  const before = cuSnapshot();
  Object.assign(theme, next);
  saveTheme();
  applyTheme();
  renderCustomize();
  if (!label) return;
  const el = showToast(escapeHtml(label), '<button type="button" class="cu-undo">Undo</button>', 'success');
  el?.querySelector('.cu-undo')?.addEventListener('click', (e) => {
    e.stopPropagation();
    Object.assign(theme, before);
    saveTheme();
    applyTheme();
    renderCustomize();
    el.remove();
  });
}

function cuPaintTop() {
  const pv = document.getElementById('cu-pv-bg');
  if (!pv) return;
  const accent = currentAccent();
  pv.style.cssText = `${cuBgFill(theme.bg, accent.a)};image-rendering:${theme.bg === 'custom' ? 'auto' : 'pixelated'}`;
  pv.parentElement.style.setProperty('--pv-dim', String((theme.sceneDim || 0) / 100));
  pv.parentElement.style.setProperty('--pv-alpha', String((theme.alpha || 34) / 100));
  const match = cuMatch();
  const bgName = theme.bg === 'custom' ? 'Your photo' : (window.NEBULA_BACKGROUNDS?.[theme.bg]?.name || 'Solar');
  document.getElementById('cu-top-name').textContent = match ? match.name : 'Custom mix';
  document.getElementById('cu-top-sub').textContent = `${bgName} · ${accent.name} accent · ${theme.alpha}% glass`;
  const hex = document.getElementById('cu-hex');
  if (hex && document.activeElement !== hex) hex.value = accent.a;
  document.getElementById('cu-hex-dot')?.style.setProperty('background', `linear-gradient(135deg, ${accent.a}, ${accent.b})`);
}

function cuPaint() {
  cuPaintTop();
  const grid = document.getElementById('cu-theme-grid');
  if (grid) {
    const match = cuMatch();
    grid.innerHTML = CU_THEMES.map((t, i) => {
      const a = ACCENTS.find((x) => x.id === t.accent) || ACCENTS[0];
      return `<button type="button" class="cu-theme${match?.id === t.id ? ' active' : ''}" data-theme="${t.id}" style="--ta:${a.a};--tb:${a.b};--i:${i}">
        <span class="cu-theme-thumb"><i class="cu-theme-glass"><b></b><em></em></i></span>
        <span class="cu-theme-name">${escapeHtml(t.name)}</span>
      </button>`;
    }).join('');
    grid.querySelectorAll('.cu-theme').forEach((card) => {
      const t = CU_THEMES.find((x) => x.id === card.dataset.theme);
      const a = ACCENTS.find((x) => x.id === t.accent) || ACCENTS[0];
      card.querySelector('.cu-theme-thumb').style.cssText = cuBgFill(t.bg, a.a);
    });
  }
  const adv = document.getElementById('cu-adv');
  const open = localStorage.getItem('sc.cu.adv') === '1';
  document.getElementById('cu-glass')?.classList.toggle('cu-adv-open', open);
  if (adv) adv.textContent = open ? 'Hide advanced dials' : 'Show advanced dials';
  requestAnimationFrame(cuSpy);
}

function cuView() { return document.getElementById('view-customize'); }
let cuSpyLock = null;
function cuSpy() {
  const view = cuView();
  const nav = document.getElementById('cu-nav');
  if (!view || !nav || !view.classList.contains('active')) return;
  const top = view.getBoundingClientRect().top + nav.offsetHeight + 60;
  let cur = null;
  let curTop = -Infinity;
  for (const b of nav.querySelectorAll('button[data-cu]')) {
    const sec = document.getElementById(b.dataset.cu);
    const y = sec?.offsetParent ? sec.getBoundingClientRect().top : Infinity;
    if (y <= top && y > curTop + 2) { cur = b; curTop = y; }
  }
  if (view.scrollTop + view.clientHeight >= view.scrollHeight - 4) cur = nav.querySelector('button[data-cu]:last-of-type');
  if (cuSpyLock && performance.now() < cuSpyLock.until) cur = cuSpyLock.btn;
  cur ||= nav.querySelector('button[data-cu]');
  nav.querySelectorAll('button[data-cu]').forEach((b) => b.classList.toggle('on', b === cur));
  const ink = nav.querySelector('.cu-nav-ink');
  if (ink && cur) {
    ink.style.width = `${cur.offsetWidth}px`;
    ink.style.transform = `translateX(${cur.offsetLeft}px)`;
  }
}

function cuReadCode(raw) {
  const s = String(raw || '').trim().replace(/^SC1:/i, '');
  if (!s || s.length > 2000) throw new Error('That code is empty or too long.');
  let o;
  try { o = JSON.parse(atob(s)); } catch { throw new Error("That isn't a SolarClient theme code."); }
  if (!o || typeof o !== 'object') throw new Error("That isn't a SolarClient theme code.");
  const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : undefined);
  const next = {};
  if (typeof o.bg === 'string' && o.bg !== 'custom' && window.NEBULA_BACKGROUNDS?.[o.bg]) next.bg = o.bg;
  if (o.accent === 'custom' && CU_HEX.test(o.customAccent || '')) { next.accent = 'custom'; next.customAccent = o.customAccent; }
  else if (ACCENTS.some((a) => a.id === o.accent)) next.accent = o.accent;
  const alpha = num(o.alpha, 20, 90); if (alpha != null) next.alpha = alpha;
  const dim = num(o.sceneDim, 0, 85); if (dim != null) next.sceneDim = dim;
  if (o.launchStyle === 'purple' || o.launchStyle === 'glass') next.launchStyle = o.launchStyle;
  const optics = {};
  const op = o.optics && typeof o.optics === 'object' ? o.optics : {};
  const f = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : undefined);
  const put = (k, v) => { if (v != null) optics[k] = v; };
  put('refraction', f(op.refraction, 0, 250));
  put('bezel', f(op.bezel, 4, 60));
  put('frost', f(op.frost, 0, 1));
  put('blur', f(op.blur, 0, 20));
  put('specular', f(op.specular, 0, 1));
  put('dispersion', f(op.dispersion, 0, 0.4));
  if (['squircle', 'convex', 'rim'].includes(op.profile)) optics.profile = op.profile;
  if (['auto', 'frost', 'clear'].includes(op.material)) optics.material = op.material;
  if (!Object.keys(next).length && !Object.keys(optics).length) throw new Error('That code has nothing in it to use.');
  return { next, optics };
}

(function wireCustomizeExtras() {
  const view = cuView();
  if (!view) return;
  document.getElementById('cu-theme-grid')?.addEventListener('click', (e) => {
    const card = e.target.closest('.cu-theme');
    const t = card && CU_THEMES.find((x) => x.id === card.dataset.theme);
    if (!t) return;
    cuApply({ bg: t.bg, accent: t.accent, alpha: t.alpha, sceneDim: t.sceneDim }, `${t.name} theme on`);
  });
  document.getElementById('cu-shuffle')?.addEventListener('click', () => {
    const bgs = Object.keys(window.NEBULA_BACKGROUNDS || {}).filter((k) => k !== 'custom');
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    let next;
    for (let n = 0; n < 6; n++) {
      next = { bg: pick(bgs), accent: pick(ACCENTS).id, alpha: 30 + Math.round(Math.random() * 20), sceneDim: 6 + Math.round(Math.random() * 20) };
      if (next.bg !== theme.bg || next.accent !== theme.accent) break;
    }
    cuApply(next, 'Fresh look');
  });
  document.getElementById('cu-export')?.addEventListener('click', () => {
    const payload = { v: 1, ...cuSnapshot(), optics: window.SolarLiquidGlass?.getOptics?.() || undefined };
    if (payload.bg === 'custom') payload.bg = 'nebula';
    csCopy(`SC1:${btoa(JSON.stringify(payload))}`, 'Theme code copied');
  });
  document.getElementById('cu-import')?.addEventListener('click', async () => {
    const raw = await showPrompt('Use a theme code', 'Paste a code that starts with SC1:');
    if (!raw) return;
    try {
      const { next, optics } = cuReadCode(raw);
      if (Object.keys(optics).length && window.SolarLiquidGlass) {
        SolarLiquidGlass.setOptics(optics);
        syncLiquidOpticsUI();
      }
      cuApply(next, 'Theme code applied');
    } catch (err) {
      showToast("Couldn't use that code", escapeHtml(err.message), 'error');
    }
  });
  document.getElementById('cu-reset')?.addEventListener('click', async () => {
    const ok = await showConfirm('Put the background, accent, glass and buttons back to how SolarClient ships?', { title: 'Reset your look?', confirmLabel: 'Reset' });
    if (!ok) return;
    window.SolarLiquidGlass?.resetOptics?.();
    syncLiquidOpticsUI();
    cuApply(Object.fromEntries(CU_KEYS.map((k) => [k, defaultTheme[k]])), 'Look reset');
  });
  const hex = document.getElementById('cu-hex');
  hex?.addEventListener('input', () => {
    let v = hex.value.trim();
    if (v && v[0] !== '#') v = `#${v}`;
    hex.classList.toggle('bad', !!v && v.length >= 7 && !CU_HEX.test(v));
    if (!CU_HEX.test(v)) return;
    theme.accent = 'custom';
    theme.customAccent = v.toLowerCase();
    applyTheme();
    cuPaintTop();
  });
  hex?.addEventListener('change', () => { if (theme.accent === 'custom') { saveTheme(); renderCustomize(); } });
  hex?.addEventListener('keydown', (e) => { if (e.key === 'Enter') hex.blur(); });
  document.getElementById('cu-adv')?.addEventListener('click', () => {
    localStorage.setItem('sc.cu.adv', localStorage.getItem('sc.cu.adv') === '1' ? '0' : '1');
    cuPaint();
  });
  const nav = document.getElementById('cu-nav');
  nav?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cu]');
    const sec = b && document.getElementById(b.dataset.cu);
    if (!sec) return;
    const y = sec.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop - nav.offsetHeight - 14;
    cuSpyLock = { btn: b, until: performance.now() + 900 };
    view.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    cuSpy();
    sec.classList.remove('cu-ping');
    void sec.offsetWidth;
    sec.classList.add('cu-ping');
    setTimeout(() => sec.classList.remove('cu-ping'), 1200);
  });
  let spyRaf = 0;
  view.addEventListener('scroll', () => {
    if (!betaLayoutOn() || spyRaf) return;
    spyRaf = requestAnimationFrame(() => { spyRaf = 0; cuSpy(); });
  }, { passive: true });
  window.addEventListener('resize', () => { if (betaLayoutOn()) cuSpy(); });
})();

// ---------- toast notifications ----------
// ---- sliders: filled track + a value bubble while dragging ----
const RANGE_UNITS = {
  'mem-max': ' GB', 'sd-ram': ' GB', 'lq-refraction': ' px', 'lq-bezel': ' px', 'lq-blur': ' px',
  'glass-alpha': '%', 'scene-dim': '%',
};
function paintRange(el) {
  const min = el.min === '' ? 0 : Number(el.min);
  const max = el.max === '' ? 100 : Number(el.max);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}
(function wireRanges() {
  // Values set from code (saved settings, rebuilt rows) repaint too.
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    ...desc,
    set(v) { desc.set.call(this, v); if (this.type === 'range') paintRange(this); },
  });
  const paintAll = (root) => root.querySelectorAll?.('input[type="range"]').forEach(paintRange);
  paintAll(document);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') { if (m.target.type === 'range') paintRange(m.target); continue; }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.matches('input[type="range"]')) paintRange(n); else paintAll(n);
      }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'value'] });

  const bubble = document.createElement('div');
  bubble.className = 'range-bubble hidden';
  document.body.appendChild(bubble);
  let active = null;
  const text = (el) => {
    const unit = el.dataset.unit ?? RANGE_UNITS[el.id];
    if (unit != null) return `${el.value}${unit}`;
    return document.getElementById(`${el.id}-label`)?.textContent || el.value;
  };
  const place = () => {
    if (!active) return;
    const r = active.getBoundingClientRect();
    const min = active.min === '' ? 0 : Number(active.min);
    const max = active.max === '' ? 100 : Number(active.max);
    const frac = max > min ? (Number(active.value) - min) / (max - min) : 0;
    const thumb = 16;
    bubble.style.left = `${r.left + thumb / 2 + (r.width - thumb) * frac}px`;
    bubble.style.top = `${r.top + r.height / 2 - 12}px`;
    bubble.textContent = text(active);
  };
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest?.('input[type="range"]');
    if (!el || !document.body.classList.contains('beta-layout')) return;
    active = el;
    requestAnimationFrame(() => { place(); bubble.classList.remove('hidden'); });
  }, true);
  document.addEventListener('input', (e) => {
    if (e.target.type !== 'range') return;
    paintRange(e.target);
    if (e.target === active) requestAnimationFrame(place);
  }, true);
  const end = () => { active = null; bubble.classList.add('hidden'); };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('blur', end);
})();

function showToast(title, message, type = 'info') {
  const container = scActiveDoc().getElementById('toast-container') || document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<div class="toast-title">${title}</div>${message ? `<div class="toast-msg">${message}</div>` : ''}`;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 4500);
  return el;
}

// ---------- themed confirm dialog (replaces native confirm()) ----------
// Returns a Promise<boolean> so call sites can `await showConfirm(...)`
// just like they did with the blocking native confirm().
function showConfirm(message, { title = 'Are you sure?', confirmLabel = 'Confirm' } = {}) {
  const overlay = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');
  okBtn.textContent = confirmLabel;
  overlay.classList.remove('hidden');

  return new Promise((resolve) => {
    function cleanup(result) {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onOverlay(e) { if (e.target === overlay) cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
  });
}

// ---------- bottom download progress bars ----------
const downloadBars = new Map();
function showDownloadBar(id, label) {
  const existing = downloadBars.get(id);
  if (existing) {
    const lab = existing.querySelector('.download-bar-label');
    if (lab && label) lab.textContent = label;
    return existing;
  }
  const container = document.getElementById('download-bar-container');
  if (!container) return null;
  const el = document.createElement('div');
  el.className = 'download-bar';
  el.innerHTML = `
    <div class="download-bar-icon"></div>
    <div class="download-bar-info">
      <div class="download-bar-label">${label}</div>
      <div class="download-bar-track"><div class="download-bar-fill" style="width:0%"></div></div>
    </div>
    <div class="download-bar-percent">0%</div>
  `;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  downloadBars.set(id, el);
  return el;
}
function updateDownloadBar(id, percent) {
  const el = downloadBars.get(id);
  if (!el) return;
  el.querySelector('.download-bar-fill').style.width = `${percent}%`;
  el.querySelector('.download-bar-percent').textContent = `${percent}%`;
}
function removeDownloadBar(id) {
  const el = downloadBars.get(id);
  if (!el) return;
  el.classList.remove('show');
  setTimeout(() => el.remove(), 250);
  downloadBars.delete(id);
}

// ---------- minecraft versions ----------
let versionGroups = [];
let versionGroupsFailed = false;
async function loadVersionGroups() {
  try {
    versionGroups = await window.nebula.listVersionsGrouped();
    versionGroupsFailed = false;
  } catch (err) {
    versionGroups = [];
    versionGroupsFailed = true;
    showToast('Versions unavailable', err?.message || 'Could not load Minecraft versions.', 'error');
  }
  renderVersionGrid();
}

// ---------- navigation ----------
let navPrevIdx = 0;
/** Beta: the little bar beside the sidebar slides to the active page. */
function navInk() {
  const side = document.querySelector('.sidebar');
  if (!side) return;
  let ink = document.getElementById('nav-ink');
  if (!ink) {
    ink = document.createElement('i');
    ink.id = 'nav-ink';
    ink.setAttribute('aria-hidden', 'true');
    side.appendChild(ink);
  }
  const on = side.querySelector('.nav-btn.active');
  if (!betaLayoutOn() || !on) { ink.classList.remove('on'); return; }
  // Reading offsetTop mid-click forces a full layout before the view swap
  // does its own; the buttons only move when the window or layout changes.
  navInkMeasure(side);
  if (on._inkY == null) { ink.classList.remove('on'); return; }
  const next = `0px ${on._inkY}px`;
  if (ink.classList.contains('on') && ink.style.translate && ink.style.translate !== next && !scMotionOff()) {
    ink.classList.remove('moving');
    void ink.offsetWidth;
    ink.classList.add('moving');
    clearTimeout(ink._moving);
    ink._moving = setTimeout(() => ink.classList.remove('moving'), 450);
  }
  ink.style.translate = next;
  ink.classList.add('on');
  requestAnimationFrame(() => setTimeout(() => {
    const y = on.offsetParent ? Math.round(on.offsetTop + (on.offsetHeight - 24) / 2) : null;
    if (y !== on._inkY) { side._inkKey = null; navInk(); }
  }));
}
function navInkMeasure(side) {
  const key = `${innerWidth}x${innerHeight}|${document.body.classList.contains('beta-layout')}`;
  if (side._inkKey === key) return;
  side._inkKey = key;
  for (const b of side.querySelectorAll('.nav-btn')) {
    b._inkY = b.offsetParent ? Math.round(b.offsetTop + (b.offsetHeight - 24) / 2) : null;
  }
}
window.addEventListener('resize', scPerFrame(() => navInk()));
(window.requestIdleCallback || setTimeout)(() => {
  const side = document.querySelector('.sidebar');
  if (side) navInkMeasure(side);
});
// Beta: the page name slides out beside the sidebar button under the pointer.
(function navTips() {
  const side = document.querySelector('.sidebar');
  if (!side) return;
  let tip = null, on = null;
  const hide = () => { on = null; tip?.classList.remove('on'); };
  side.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('.nav-btn');
    if (!btn || !betaLayoutOn()) { hide(); return; }
    if (btn === on) return;
    on = btn;
    if (btn.title) {
      btn.dataset.label = btn.title;
      if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', btn.title);
      btn.removeAttribute('title');
    }
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'nav-tip';
      document.body.appendChild(tip);
    }
    tip.textContent = btn.dataset.label || '';
    const r = btn.getBoundingClientRect();
    tip.style.left = `${Math.round(r.right + 14)}px`;
    tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
    tip.classList.remove('on');
    void tip.offsetWidth;
    tip.classList.add('on');
  });
  side.addEventListener('pointerleave', hide);
  side.addEventListener('pointerdown', hide);
  window.addEventListener('blur', hide);
})();
function navFx(btn, view) {
  if (scMotionOff()) return;
  btn.classList.remove('nav-bounce');
  void btn.offsetWidth;
  btn.classList.add('nav-bounce');
  const btns = [...document.querySelectorAll('.sidebar .nav-btn[data-view]')];
  const idx = btns.indexOf(btn);
  const v = document.getElementById(`view-${view}`);
  if (v && idx !== navPrevIdx) {
    v.classList.remove('sc-view-up', 'sc-view-down');
    void v.offsetWidth;
    v.classList.add(idx > navPrevIdx ? 'sc-view-up' : 'sc-view-down');
    document.documentElement.classList.add('sc-viewing');
    clearTimeout(v._viewFx);
    v._viewFx = setTimeout(() => {
      v.classList.remove('sc-view-up', 'sc-view-down');
      document.documentElement.classList.remove('sc-viewing');
    }, 420);
  }
  navPrevIdx = idx;
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const view = btn.dataset.view;
    if (!view) return;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    navFx(btn, view, e);
    navInk();
    if (betaLayoutOn()) closeCommunityStage();
    if (document.getElementById('view-launchpad')?.classList.contains('active') && !launchPreviewSnap) captureLaunchPreview();
    if (view === 'launchpad') queueLaunchPreview();
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`).classList.add('active');
    if (view === 'customize') {
      setTimeout(() => {
        if (document.getElementById('view-customize')?.classList.contains('active')) requestAnimationFrame(renderLaunchPreviews);
      }, scMotionOff() ? 0 : 440);
    }
    if (view === 'instances') { refreshInstances(); renderVersionGrid(); }
    if (view === 'mods') { refreshInstanceSelects(); refreshInstalledContent().then(searchMods); }
    if (view === 'settings') { refreshAccountSettings(); refreshDiscordSettings(); }
    if (view === 'skins') refreshSkins();
    if (view === 'cosmetics') renderCosmetics();
    else if (cosmeticViewer) cosmeticViewer.setShowcase(false);
    if (view === 'friends') renderFriendsView();
    if (view === 'servers') renderServers();
    if (view === 'customize') renderCustomize();
    if (view === 'launchpad') renderPerformance();
  });
});

const COSMETICS = [
  { id: 'cape-plain', kind: 'cape', name: 'Solar cape', blurb: 'A plain purple cape.', img: 'assets/cosmetics/cape_plain.png' },
  { id: 'cape-planet-light', kind: 'cape', name: 'Planet cape', blurb: 'Cape with the planet logo.', img: 'assets/cosmetics/cape_planet_light.png' },
  { id: 'cape-sun-light', kind: 'cape', name: 'Logo cape', blurb: 'Cape with the SolarClient wordmark.', img: 'assets/cosmetics/cape_sun_light.png' },
  { id: 'cape-halloween', kind: 'cape', name: 'Halloween cape', blurb: 'Cape with the Halloween logo.', img: 'assets/cosmetics/cape_halloween.png' },
  { id: 'cloak-gold', kind: 'cloak', name: 'Gold hem cloak', blurb: 'A long cloak with a gold hem.', img: 'assets/cosmetics/cloak_gold.png' },
  { id: 'wings-solar', kind: 'wings', name: 'Solar wings', blurb: 'Gold wings on your back.', img: 'assets/cosmetics/wings_solar.png' },
  { id: 'backpack-crate', kind: 'backpack', name: 'Crate pack', blurb: 'A wooden crate on your back.', img: 'assets/cosmetics/backpack_crate.png' },
  { id: 'bandana-red', kind: 'bandana', name: 'Red bandana', blurb: 'Tied around the head.', img: 'assets/cosmetics/bandana_red.png' },
  { id: 'headphones-purple', kind: 'headphones', name: 'Purple cans', blurb: 'Over-ear headphones.', img: 'assets/cosmetics/headphones_purple.png' },
  { id: 'glasses-gold', kind: 'glasses', name: 'Gold shades', blurb: 'Gold-frame sunglasses.', img: 'assets/cosmetics/glasses_gold.png' },
  { id: 'halo-gold', kind: 'halo', name: 'Solar halo', blurb: 'A gold ring over the head.', img: 'assets/cosmetics/halo_gold.png' },
  { id: 'shoulders-iron', kind: 'shoulders', name: 'Iron pads', blurb: 'Shoulder plates.', img: 'assets/cosmetics/shoulders_iron.png' },
  { id: 'belt-gold', kind: 'belt', name: 'Gold belt', blurb: 'A leather belt with a gold buckle.', img: 'assets/cosmetics/belt_gold.png' },
  { id: 'scarf-green', kind: 'scarf', name: 'Trail scarf', blurb: 'A green scarf around the neck.', img: 'assets/cosmetics/scarf_green.png' },
  { id: 'antenna-red', kind: 'antenna', name: 'Signal antenna', blurb: 'A red-tipped antenna.', img: 'assets/cosmetics/antenna_red.png' },
];

let cosmeticViewer = null;
let cosmeticMounting = false;
let cosmeticPick = '';
let cosmeticWorn = [];

function cosmeticById(id) { return COSMETICS.find((c) => c.id === id) || null; }

function clothKind(kind) { return kind === 'cape' || kind === 'cloak'; }

function wornIds(worn) {
  if (Array.isArray(worn?.ids) && worn.ids.length) return worn.ids.filter(Boolean);
  const one = worn?.id || worn?.cape || '';
  return one ? String(one).split(',').filter(Boolean) : [];
}

function toggleCosmetic(id) {
  const item = cosmeticById(id);
  const next = cosmeticWorn.filter((wornId) => wornId !== id);
  if (next.length === cosmeticWorn.length && item) {
    if (clothKind(item.kind)) {
      return [id, ...cosmeticWorn.filter((wornId) => !clothKind(cosmeticById(wornId)?.kind))];
    }
    return [...cosmeticWorn, id];
  }
  return next;
}

function stageItems() {
  const ids = cosmeticWorn.slice();
  if (cosmeticPick && !ids.includes(cosmeticPick)) ids.push(cosmeticPick);
  return ids.map(cosmeticById).filter(Boolean);
}

function paintCosmeticStage() {
  const item = cosmeticById(cosmeticPick);
  const name = document.getElementById('cosmetics-stage-name');
  const blurb = document.getElementById('cosmetics-stage-blurb');
  const btn = document.getElementById('cosmetics-equip');
  if (name) name.textContent = item ? item.name : (cosmeticWorn.length ? 'Wearing ' + cosmeticWorn.length : 'Nothing equipped');
  if (blurb) blurb.textContent = item ? item.blurb : 'Pick any of them. They stack. A new cape replaces the cape you have on.';
  if (!btn) return;
  if (!item) { btn.disabled = true; btn.textContent = 'Equip'; btn.classList.add('primary'); return; }
  btn.disabled = false;
  const wearing = cosmeticWorn.includes(item.id);
  btn.textContent = wearing ? 'Take off' : 'Equip';
  btn.classList.toggle('primary', !wearing);
}

async function mountCosmeticStage(item) {
  const canvas = document.getElementById('cosmetics-canvas');
  if (!canvas) return;
  await ensureSkin3D();
  if (!window.Skin3D) return;
  if (!cosmeticViewer) {
    cosmeticViewer = new Skin3D(canvas, { yaw: 0.4, zoom: 0.92 });
    cosmeticViewer.setShowcase(true);
  }
  const account = await window.nebula.currentAccount().catch(() => null);
  if (account && account.id) {
    const recent = recentAppliedSkin(account.id);
    const texture = recent ? { dataUrl: recent.dataUrl, model: recent.model } : await loadSkinTexture(account.id);
    if (texture) {
      await cosmeticViewer.setSkin(texture.dataUrl);
      if (texture.model) cosmeticViewer.setSlim(texture.model === 'slim');
    }
  }
  const shown = stageItems();
  cosmeticViewer.setCosmetics(shown.map((entry) => ({ img: entry.img, kind: entry.kind })));
  cosmeticViewer.setShowcase(true);
}

async function renderCosmetics() {
  const grid = document.getElementById('cosmetics-grid');
  if (!grid || !window.nebula.cosmeticsGet) return;
  const worn = await window.nebula.cosmeticsGet().catch(() => ({ ids: [] }));
  cosmeticWorn = wornIds(worn);
  if (!cosmeticPick) cosmeticPick = cosmeticWorn[0] || '';
  grid.innerHTML = COSMETICS.map((item) => {
    const on = cosmeticWorn.includes(item.id);
    const sel = cosmeticPick === item.id;
    return `<button type="button" class="cosmetic-card${on ? ' equipped' : ''}${sel ? ' selected' : ''}" data-id="${item.id}">
      <img src="${item.img}" alt="">
      <h2>${item.name}</h2>
      <p>${item.blurb}</p>
      ${on ? '<span class="cosmetic-worn">Wearing</span>' : ''}
    </button>`;
  }).join('');
  grid.querySelectorAll('.cosmetic-card').forEach((card) => {
    card.addEventListener('click', () => {
      cosmeticPick = card.dataset.id;
      const item = cosmeticById(cosmeticPick);
      if (cosmeticViewer) {
        const shown = stageItems();
        cosmeticViewer.setCosmetics(shown.map((entry) => ({ img: entry.img, kind: entry.kind })));
        cosmeticViewer.setShowcase(true);
      }
      renderCosmetics();
    });
  });
  paintCosmeticStage();
  if (!cosmeticViewer && !cosmeticMounting) {
    cosmeticMounting = true;
    mountCosmeticStage(cosmeticById(cosmeticPick)).finally(() => { cosmeticMounting = false; });
  }
  else cosmeticViewer.setShowcase(true);
  const equip = document.getElementById('cosmetics-equip');
  if (equip && !equip.dataset.bound) {
    equip.dataset.bound = '1';
    equip.addEventListener('click', async () => {
      const next = toggleCosmetic(cosmeticPick);
      await window.nebula.cosmeticsEquip({ ids: next });
      cosmeticWorn = next;
      const shown = stageItems();
      if (cosmeticViewer) cosmeticViewer.setCosmetics(shown.map((entry) => ({ img: entry.img, kind: entry.kind })));
      renderCosmetics();
      applyHeroCosmetic();
    });
  }
  mountCosmeticStage(cosmeticById(cosmeticPick));
}

async function applyHeroCosmetic() {
  if (!heroViewer?.setCosmetic) return;
  const worn = await window.nebula.cosmeticsGet?.().catch(() => ({ ids: [] }));
  const items = wornIds(worn).map(cosmeticById).filter(Boolean);
  if (heroViewer.setCosmetics) heroViewer.setCosmetics(items.map((entry) => ({ img: entry.img, kind: entry.kind })));
  else heroViewer.setCosmetic(items[0] ? items[0].img : null, items[0] ? items[0].kind : '');
}

// ---------- skin image helpers (mc-heads primary, crafatar fallback) ----------
function avatarUrl(uuid) { return `https://mc-heads.net/avatar/${uuid}/32`; }
function avatarUrlFallback(uuid) { return `https://crafatar.com/avatars/${uuid}?size=32&overlay`; }
function renderUrl(uuid) { return `https://mc-heads.net/body/${uuid}/300`; }
function renderUrlFallback(uuid) { return `https://crafatar.com/renders/body/${uuid}?scale=8&overlay`; }

// The hero character is a real 3D model now, not a flat render with a CSS
// tilt on it — so you can spin it right round and look at the back, the
// way NameMC lets you. skinTextureUrl gives the raw 64x64 PNG rather than
// a pre-rendered body shot, because the renderer needs the texture itself.
function skinTextureUrl(uuid) { return `https://mc-heads.net/skin/${uuid}`; }
function skinTextureUrlFallback(uuid) { return `https://crafatar.com/skins/${uuid}`; }

let heroViewer = null;

// Skin textures are fetched through the main process rather than straight
// from the renderer. A cross-origin <img> taints the canvas, and the whole
// point of this renderer is reading pixels back out of it — so loading the
// texture directly would throw a SecurityError the moment we called
// getImageData. The proxy hands back a data: URL, which is same-origin.
async function loadSkinTexture(uuid) {
  // Mojang's session server first — it is the source of truth, and unlike
  // the third-party skin proxies it never silently substitutes a default
  // Steve when it can't resolve someone. It also tells us slim vs classic
  // outright instead of us inferring it from arm transparency.
  try {
    const r = await window.nebula.skinTextureFor(uuid);
    if (r && r.dataUrl) return r;
  } catch (err) {
    console.warn('[SolarClient] Mojang skin lookup failed, falling back:', err);
  }
  for (const url of [skinTextureUrl(uuid), skinTextureUrlFallback(uuid)]) {
    try {
      const dataUrl = await window.nebula.fetchImageBase64(url);
      if (dataUrl) return { dataUrl, model: null };
    } catch { /* try the next source */ }
  }
  return null;
}

// Mojang's profile endpoint keeps serving the previous skin for a while
// after a change, so a skin applied from the launcher is remembered locally
// and preferred over the network copy until that cache has turned over.
const APPLIED_SKIN_KEY = 'sc.appliedSkin';
const APPLIED_SKIN_TTL = 15 * 60 * 1000;
function rememberAppliedSkin(uuid, dataUrl, model) {
  try { localStorage.setItem(APPLIED_SKIN_KEY, JSON.stringify({ uuid: String(uuid).replace(/-/g, ''), dataUrl, model, at: Date.now() })); } catch { /* storage full */ }
}
function recentAppliedSkin(uuid) {
  try {
    const s = JSON.parse(localStorage.getItem(APPLIED_SKIN_KEY) || 'null');
    if (s && s.uuid === String(uuid).replace(/-/g, '') && Date.now() - s.at < APPLIED_SKIN_TTL) return s;
  } catch { /* corrupt */ }
  return null;
}

let heroSkinRun = 0;
async function mountHeroSkin(uuid) {
  const canvas = document.getElementById('skin-canvas');
  const flat = document.getElementById('skin-render');
  if (!canvas) return;
  // Switching accounts can start a second load before the first finishes;
  // only the newest one may touch the stage.
  const run = ++heroSkinRun;
  let upgraded = false;

  // If anything at all goes wrong with the 3D path, fall back to the flat
  // body render. An empty stage is the worst possible outcome here.
  const useFlatFallback = () => {
    canvas.classList.add('hidden');
    flat.onerror = () => { flat.onerror = null; if (run === heroSkinRun && !upgraded) flat.src = renderUrlFallback(uuid); };
    flat.onload = () => { if (run === heroSkinRun && !upgraded) flat.style.display = 'block'; };
    flat.src = renderUrl(uuid);
  };

  // Show flat immediately; upgrade to 3D once skin3d.js is idle-loaded.
  useFlatFallback();
  try {
    await ensureSkin3D();
    const recent = recentAppliedSkin(uuid);
    const texture = recent ? { dataUrl: recent.dataUrl, model: recent.model } : await loadSkinTexture(uuid);
    if (run !== heroSkinRun || !texture || !window.Skin3D) return;
    if (!heroViewer) heroViewer = new Skin3D(canvas, { yaw: 0.5 });
    await heroViewer.setSkin(texture.dataUrl);
    if (run !== heroSkinRun) return;
    if (texture.model) heroViewer.setSlim(texture.model === 'slim');
    upgraded = true;
    flat.style.display = 'none';
    canvas.classList.remove('hidden');
    applyHeroCosmetic();
  } catch (err) {
    console.warn('[SolarClient] skin preview failed, using flat render:', err);
  }
}

let _skin3dPromise = null;
function ensureSkin3D() {
  if (window.Skin3D) return Promise.resolve();
  if (_skin3dPromise) return _skin3dPromise;
  const load = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`${src} failed to load`));
    document.head.appendChild(s);
  });
  _skin3dPromise = load('vendor/skinview3d.bundle.js').then(() => load('skin3d.js'));
  _skin3dPromise.catch(() => { _skin3dPromise = null; });
  return _skin3dPromise;
}

// Beta launch section scales with the window: 1 at the default 1320x840, up to 1.8.
function fitLaunchScale() {
  const z = Math.min(1.8, Math.max(1, Math.min(innerWidth / 1320, innerHeight / 840)));
  document.documentElement.style.setProperty('--lz', z.toFixed(3));
  placeVersionWatermark();
}
fitLaunchScale();
window.addEventListener('resize', () => { fitLaunchScale(); heroViewer?.requestRender(); skinsViewer?.requestRender(); });

// ---------- custom dropdown (progressively enhances a native <select>) ----------
function enhanceSelect(id) {
  const select = document.getElementById(id);
  if (!select || select.dataset.enhanced) return;
  select.dataset.enhanced = '1';
  select.classList.add('native-select-hidden');

  const wrap = document.createElement('div');
  wrap.className = 'custom-select';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'custom-select-btn';
  const panel = document.createElement('div');
  panel.className = 'custom-select-panel hidden';

  function placePanel() {
    if (panel.classList.contains('hidden')) return;
    const r = btn.getBoundingClientRect();
    const pad = 6;
    // Fit to the button — never inherit viewport width from portaled 100% CSS.
    const width = Math.min(Math.max(r.width, 180), 280, window.innerWidth - 24);
    let left = r.left;
    let top = r.bottom + pad;
    left = Math.min(left, window.innerWidth - width - 12);
    left = Math.max(12, left);
    const maxH = Math.min(280, window.innerHeight - top - 12);
    panel.style.position = 'fixed';
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.width = Math.round(width) + 'px';
    panel.style.minWidth = Math.round(width) + 'px';
    panel.style.maxWidth = Math.round(width) + 'px';
    panel.style.maxHeight = Math.round(maxH) + 'px';
    panel.style.zIndex = '1300';
  }

  function closePanel() {
    panel.classList.add('hidden');
    wrap.classList.remove('open');
    if (!document.querySelector('.custom-select.open')) {
      document.body.classList.remove('dropdown-open');
    }
  }

  function openPanel() {
    // Close competing menus so dropdowns never stack/overlap.
    document.querySelectorAll('.account-menu').forEach((m) => m.remove());
    document.querySelectorAll('.custom-select.open').forEach((w) => {
      if (w !== wrap) w.classList.remove('open');
    });
    document.querySelectorAll('.custom-select-panel').forEach((p) => {
      if (p !== panel) p.classList.add('hidden');
    });
    // Portal out of glass / overflow stacking so launchpad art cannot cover it.
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.classList.remove('hidden');
    wrap.classList.add('open');
    document.body.classList.add('dropdown-open');
    requestAnimationFrame(placePanel);
  }

  function renderOptions() {
    panel.innerHTML = '';
    const addOption = (opt) => {
      const item = document.createElement('div');
      item.className = 'custom-select-item' + (opt.value === select.value ? ' active' : '');
      item.textContent = opt.textContent;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        select.value = opt.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncLabel();
        closePanel();
        renderOptions();
      });
      panel.appendChild(item);
    };
    for (const child of Array.from(select.children)) {
      if (child.tagName === 'OPTGROUP') {
        const head = document.createElement('div');
        head.className = 'custom-select-group';
        head.textContent = child.label;
        panel.appendChild(head);
        Array.from(child.children).forEach(addOption);
      } else if (child.tagName === 'OPTION') {
        addOption(child);
      }
    }
  }
  function syncLabel() {
    const selected = select.options[select.selectedIndex];
    const label = selected ? selected.textContent : '';
    btn.innerHTML = `<span class="cs-label"></span><span class="cs-caret" aria-hidden="true"></span>`;
    btn.querySelector('.cs-label').textContent = label;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('hidden')) openPanel();
    else closePanel();
  });
  document.addEventListener('click', (e) => {
    if (wrap.contains(e.target) || panel.contains(e.target)) return;
    closePanel();
  });
  window.addEventListener('resize', () => placePanel());

  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(btn);
  wrap.appendChild(panel);
  renderOptions();
  syncLabel();

  select._refreshCustomSelect = () => { renderOptions(); syncLabel(); };
}

// ---------- account switcher ----------
const accountBox = document.getElementById('account-box');

function betaLayoutOn() {
  return document.body.classList.contains('beta-layout');
}

async function renderAccountBox() {
  const current = await window.nebula.currentAccount();
  accountBox.innerHTML = '';
  const rail = document.getElementById('rail-account');
  if (rail) rail.innerHTML = '';

  if (betaLayoutOn()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-avatar';
    btn.title = current ? current.name : 'Sign in with Microsoft';
    if (!current) {
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
    } else {
      btn.innerHTML = `<img src="${avatarUrl(current.id)}" alt="">`;
      const img = btn.querySelector('img');
      img.onerror = () => { img.onerror = () => { img.style.display = 'none'; }; img.src = avatarUrlFallback(current.id); };
    }
    btn.addEventListener('click', (e) => { e.stopPropagation(); toggleAccountMenu(); });
    rail.appendChild(btn);
    if (current) mountHeroSkin(current.id);
    updateLaunchState();
    return;
  }

  if (!current) {
    const btn = document.createElement('button');
    btn.className = 'login-btn';
    btn.textContent = 'Sign in with Microsoft';
    btn.addEventListener('click', doLogin);
    accountBox.appendChild(btn);
    updateLaunchState();
    return;
  }

  const xpData = await window.nebula.xpGet();
  const ore = oreForLevel(xpData.level);
  const pct = xpPercent(xpData);

  const pill = document.createElement('div');
  pill.className = 'account-pill';
  pill.innerHTML = `
    <img src="${avatarUrl(current.id)}" alt="">
    <div class="pill-info">
      <span class="pill-name">${current.name}</span>
      <div class="pill-level-row">
        <img class="ore-badge" src="${ore.img}" alt="${ore.name}" title="${ore.name}" style="filter:drop-shadow(0 0 4px ${ore.color})">
        <span class="level-num">Lv ${xpData.level}</span>
        <div class="xp-bar"><div class="xp-fill" style="width:${pct}%;background:${ore.color}"></div></div>
      </div>
    </div>
    <span class="chev" aria-hidden="true"></span>
  `;
  const img = pill.querySelector('img');
  img.onerror = () => { img.onerror = () => { img.style.display = 'none'; }; img.src = avatarUrlFallback(current.id); };
  pill.addEventListener('click', (e) => { e.stopPropagation(); toggleAccountMenu(); });
  accountBox.appendChild(pill);

  mountHeroSkin(current.id);
  updateLaunchState();
}

async function toggleAccountMenu() {
  if (betaLayoutOn()) {
    const anchor = document.querySelector('.rail-avatar');
    if (!anchor) return;
    if (document.querySelector('.rail-sheet .acct-hero')) { closeRailSheets(); return; }
  }
  const existing = document.querySelector('.account-menu');
  if (existing) { existing.remove(); document.body.classList.remove('account-menu-open'); return; }
  if (toggleAccountMenu._opening) return;
  toggleAccountMenu._opening = true;

  try {
  // Close other dropdowns so nothing overlaps.
  document.querySelectorAll('.custom-select.open').forEach((w) => w.classList.remove('open'));
  document.querySelectorAll('.custom-select-panel').forEach((p) => p.classList.add('hidden'));
  document.body.classList.remove('dropdown-open');
  document.getElementById('version-popover')?.classList.add('hidden');

  const accounts = await window.nebula.listAccounts();
  const current = await window.nebula.currentAccount();

  // Another click may have opened/closed while we awaited.
  if (document.querySelector('.account-menu')) return;

  if (betaLayoutOn()) {
    openAccountSheet(accounts, current);
    return;
  }

  const menu = document.createElement('div');
  // Plain glass — liquid-glass layers were intercepting clicks on menu items.
  menu.className = 'account-menu glass';
  menu.addEventListener('click', (e) => e.stopPropagation());
  menu.innerHTML = accounts.map(a => `
    <div class="account-menu-item" data-id="${a.id}">
      <img src="${avatarUrl(a.id)}" alt="" onerror="this.src='${avatarUrlFallback(a.id)}'">
      <span>${escapeHtml(a.name)}</span>
      ${current && current.id === a.id
        ? '<span class="check" aria-label="Active"></span>'
        : `<button type="button" class="quick-launch" data-id="${a.id}" title="Launch as this account without switching"></button>`}
    </div>
  `).join('')
    + `<div class="account-menu-item action" id="menu-add-account">+ Add another account</div>`
    + (current
      ? `<div class="account-menu-item action logout" id="menu-logout">Log out</div>`
      : '');

  menu.querySelectorAll('.account-menu-item[data-id]').forEach(item => {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (e.target.classList.contains('quick-launch')) return;
      await window.nebula.switchAccount(item.dataset.id);
      menu.remove();
      document.body.classList.remove('account-menu-open');
      renderAccountBox();
    });
  });
  menu.querySelectorAll('.quick-launch').forEach(qbtn => {
    qbtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      menu.remove();
      document.body.classList.remove('account-menu-open');
      await launchInstance(qbtn.dataset.id);
    });
  });
  menu.querySelector('#menu-add-account')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.remove();
    document.body.classList.remove('account-menu-open');
    await doLogin();
  });
  menu.querySelector('#menu-logout')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    menu.remove();
    document.body.classList.remove('account-menu-open');
    if (!current?.id) return;
    try {
      await window.nebula.removeAccount(current.id);
      showToast('Logged out', `${current.name} signed out.`, 'success');
    } catch (err) {
      showToast('Logout failed', err?.message || String(err), 'error');
    }
    await renderAccountBox();
    try { refreshAccountSettings(); } catch { /* settings tab may be inactive */ }
  });

  document.querySelector('.community-panel')?.remove();
  document.body.appendChild(menu);
  document.body.classList.add('account-menu-open');
  const anchor = betaLayoutOn()
    ? (document.querySelector('.rail-avatar') || document.getElementById('rail-account'))
    : (accountBox.querySelector('.account-pill') || accountBox);
  const r = anchor.getBoundingClientRect();
  const width = 248;
  if (betaLayoutOn()) {
    let left = r.left - width - 10;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    let top = r.top;
    top = Math.max(12, Math.min(top, window.innerHeight - 280));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.classList.add('from-right');
  } else {
    let left = r.right - width;
    left = Math.min(left, window.innerWidth - width - 12);
    left = Math.max(12, left);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(r.bottom + 8)}px`;
  }
  } finally {
    toggleAccountMenu._opening = false;
  }
}

document.addEventListener('click', (e) => {
  const existing = document.querySelector('.account-menu');
  if (!existing) return;
  const rail = document.getElementById('rail-account');
  if (existing.contains(e.target) || accountBox.contains(e.target) || (rail && rail.contains(e.target))) return;
  existing.remove();
  document.body.classList.remove('account-menu-open');
});

const COMMUNITIES_KEY = 'solar.communities';

function newRailId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Communities live on the backend; this is the latest copy from the friends snapshot.
let communityState = [];

function readCommunities() {
  return communityState;
}

function readLegacyCommunities() {
  try {
    const list = JSON.parse(localStorage.getItem(COMMUNITIES_KEY) || '[]');
    return Array.isArray(list) ? list.filter((c) => c && c.id && c.name) : [];
  } catch {
    return [];
  }
}

// Communities made before they moved to the backend are uploaded once,
// with their messages, then dropped from localStorage.
let legacyCommunityUpload = null;
function uploadLegacyCommunities(snap) {
  if (legacyCommunityUpload || !snap?.connected || !snap.communitiesLoaded) return;
  const legacy = readLegacyCommunities();
  if (!legacy.length) return;
  let msgs = {};
  try { msgs = JSON.parse(localStorage.getItem(COMMUNITY_MSG_KEY) || '{}') || {}; } catch { msgs = {}; }
  legacyCommunityUpload = (async () => {
    let allOk = true;
    for (const c of legacy) {
      if (communityState.some((x) => x.id === c.id)) continue;
      const channels = (Array.isArray(c.channels) ? c.channels : []).filter((ch) => ch && ch.id && ch.name);
      const messages = {};
      for (const ch of channels) messages[ch.id] = msgs[msgKey(c.id, ch.id)] || [];
      const r = await window.nebula.communitiesCreate({ id: c.id, name: c.name, channels, messages });
      if (!r?.ok) allOk = false;
    }
    if (allOk) {
      localStorage.removeItem(COMMUNITIES_KEY);
      localStorage.removeItem(COMMUNITY_MSG_KEY);
    }
  })().finally(() => { legacyCommunityUpload = null; });
}

let communityStageKey = '';
function syncCommunitiesFromSnap(snap) {
  if (!snap || !Array.isArray(snap.communities)) return;
  const prevState = communityState;
  communityState = snap.communities;
  uploadLegacyCommunities(snap);
  if (openCommunityId && !communityState.some((c) => c.id === openCommunityId)) closeCommunityStage();
  const channelRemoved = (cid, chid) => {
    const had = prevState.find((c) => c.id === cid);
    const now = communityState.find((c) => c.id === cid);
    return !!had && !!now && (had.channels || []).some((ch) => ch.id === chid)
      && !(now.channels || []).some((ch) => ch.id === chid);
  };
  if (voiceSession && channelRemoved(voiceSession.communityId, voiceSession.channelId)) leaveVoice();
  if (openCommunityId && openChannelId && channelRemoved(openCommunityId, openChannelId)) {
    openChannelId = communityState.find((c) => c.id === openCommunityId)?.channels?.[0]?.id || null;
  }
  if (betaLayoutOn() && prevState.length) csNotifyNew(prevState, communityState);
  renderCommunities();
  if (openCommunityId) {
    const key = JSON.stringify(communityState.find((c) => c.id === openCommunityId));
    if (key !== communityStageKey) renderCommunityStage();
  }
}

function communityFromInviteUrl(url) {
  try {
    const u = new URL(url);
    if (!/^(www\.)?figgysmp\.shop$/i.test(u.hostname)) return null;
    const id = u.searchParams.get('community');
    return id ? { id, code: u.searchParams.get('code') || '' } : null;
  } catch {
    return null;
  }
}

async function joinCommunityFromInvite({ id, code }) {
  if (communityState.some((c) => c.id === id)) { openCommunityStage(id); return; }
  if (!code) {
    showToast('Old invite link', 'Ask for a new invite link to join this community.', 'error');
    return;
  }
  const r = await window.nebula.communitiesJoin({ id, code });
  if (!r?.ok) { showToast("Couldn't join", r?.reason || 'That invite did not work.', 'error'); return; }
  if (r.community && !communityState.some((c) => c.id === id)) communityState = [...communityState, r.community];
  renderCommunities();
  openCommunityStage(id);
  showToast('Joined', `You joined ${r.community?.name || 'the community'}.`, 'success');
}

// Plain-text messages with their web links made clickable.
const MSG_LINK_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
function linkifyText(text) {
  const s = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(MSG_LINK_RE)) {
    const url = m[0].replace(/[.,!?;:)\]}]+$/, '');
    out += escapeHtml(s.slice(last, m.index));
    out += `<a class="msg-link" href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = m.index + url.length;
  }
  return out + escapeHtml(s.slice(last));
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a.msg-link');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const url = a.getAttribute('href');
  const invite = communityFromInviteUrl(url);
  if (invite && betaLayoutOn()) { joinCommunityFromInvite(invite); return; }
  window.nebula.openExternal(url).catch((err) => showToast("Couldn't open link", err?.message || String(err), 'error'));
}, true);

function closeRailSheets() {
  document.querySelectorAll('.rail-sheet').forEach((n) => {
    n.classList.remove('rail-sheet');
    n.classList.add('rail-sheet-leaving');
    setTimeout(() => n.remove(), 240);
  });
  document.querySelectorAll('.rail-avatar.is-open, .rail-plus.is-open, .rail-comm.is-open').forEach((n) => n.classList.remove('is-open'));
  document.querySelector('.account-menu')?.remove();
  document.body.classList.remove('account-menu-open');
}

function mountRailSheet(anchor, fill) {
  closeRailSheets();
  const sheet = document.createElement('div');
  sheet.className = 'rail-sheet liquid-glass rail-sheet-bond';
  sheet.style.visibility = 'hidden';
  sheet.addEventListener('click', (e) => e.stopPropagation());
  const body = document.createElement('div');
  body.className = 'rail-sheet-body';
  sheet.appendChild(body);
  fill(body);
  (document.querySelector('.app') || document.body).appendChild(sheet);
  const place = () => {
    const side = document.getElementById('sidebar-right').getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    const w = sheet.offsetWidth;
    const h = sheet.offsetHeight;
    let top = r.top + 14;
    top = Math.max(12, Math.min(top, window.innerHeight - h - 12));
    const left = Math.max(12, Math.round(side.left - w + 18));
    sheet.style.left = `${left}px`;
    sheet.style.top = `${Math.round(top)}px`;
    sheet.style.visibility = 'visible';
    try { window.SolarLiquidGlass?.attach?.(sheet); } catch { /* glass optional */ }
  };
  requestAnimationFrame(place);
  return sheet;
}

function openAccountSheet(accounts, current) {
  const anchor = document.querySelector('.rail-avatar');
  if (!anchor) return;
  mountRailSheet(anchor, (body) => {
    if (!current) {
      body.innerHTML = `
        <div class="acct-hero">
          <div class="acct-hero-fallback">S</div>
          <div>
            <div class="rail-sheet-user">Welcome</div>
            <div class="rail-sheet-sub">Sign in to play and join communities.</div>
          </div>
        </div>
        <button type="button" class="pill-btn primary acct-signin" id="menu-signin">Sign in with Microsoft</button>
      `;
      body.querySelector('#menu-signin').addEventListener('click', async (e) => {
        e.stopPropagation();
        closeRailSheets();
        await doLogin();
      });
      return;
    }
    body.innerHTML = `
      <div class="acct-hero">
        <img class="acct-hero-img" src="${avatarUrl(current.id)}" alt="" onerror="this.src='${avatarUrlFallback(current.id)}'">
        <div>
          <div class="rail-sheet-user">${escapeHtml(current.name)}</div>
          <div class="rail-sheet-sub" id="rail-account-level">Loading level…</div>
        </div>
      </div>
      <div class="acct-label">Accounts</div>
      <div class="rail-account-list"></div>
      <div class="acct-actions">
        <button type="button" class="pill-btn" id="menu-add-account">Add account</button>
        <button type="button" class="pill-btn acct-logout" id="menu-logout">Log out</button>
      </div>
    `;
    const list = body.querySelector('.rail-account-list');
    accounts.forEach((a) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'rail-account-row';
      const active = current.id === a.id;
      row.innerHTML = `<img src="${avatarUrl(a.id)}" alt="" onerror="this.src='${avatarUrlFallback(a.id)}'"><span>${escapeHtml(a.name)}</span>${active ? '<i class="rail-check"></i>' : ''}`;
      row.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (active) return;
        await window.nebula.switchAccount(a.id);
        closeRailSheets();
        renderAccountBox();
      });
      list.appendChild(row);
    });
    body.querySelector('#menu-add-account').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeRailSheets();
      await doLogin();
    });
    body.querySelector('#menu-logout').addEventListener('click', async (e) => {
      e.stopPropagation();
      closeRailSheets();
      try {
        await window.nebula.removeAccount(current.id);
        showToast('Logged out', `${current.name} signed out.`, 'success');
      } catch (err) {
        showToast('Logout failed', err?.message || String(err), 'error');
      }
      await renderAccountBox();
      try { refreshAccountSettings(); } catch { /* settings tab may be inactive */ }
    });
    window.nebula.xpGet().then((d) => {
      const el = body.querySelector('#rail-account-level');
      if (!el || !d) return;
      const ore = oreForLevel(d.level);
      el.textContent = `${ore.name} · Level ${d.level}`;
    }).catch(() => {});
  });
}

const COMMUNITY_MSG_KEY = 'solar.community.messages';
let openCommunityId = null;
let openChannelId = null;
let voiceSession = null;
let communityOpenedAt = 0;
// Which channel the stage last painted, which messages it has already shown,
// and where the active-channel highlight sat, so repaints only animate what changed.
let csPaintedChannel = '';
let csSeenMsgIds = new Set();
let csIndicator = null;
let csMentionAuto = null;
let csReply = null;
let csUnreadFrom = 0;
let csBelow = 0;
let csSearch = null;

function msgKey(communityId, channelId) {
  return `${communityId}:${channelId}`;
}

// Community extras (beta): read markers, mutes, notification levels, saved
// messages, drafts and folded categories. The server only stores plain
// messages, so all of this lives on this PC.
const CS_STORE = 'sc.cs.state';
const CS_KEEP_MS = 3 * 24 * 60 * 60 * 1000;
let csStore = null;
let csSaveTimer = 0;
function csState() {
  if (!csStore) {
    try { csStore = JSON.parse(localStorage.getItem(CS_STORE) || '{}') || {}; } catch { csStore = {}; }
    for (const k of ['read', 'mute', 'notify', 'drafts', 'collapsed', 'sent', 'nick', 'ignore', 'lastCh']) {
      if (!csStore[k] || typeof csStore[k] !== 'object' || Array.isArray(csStore[k])) csStore[k] = {};
    }
    if (!Array.isArray(csStore.saved)) csStore.saved = [];
    if (!Array.isArray(csStore.pinned)) csStore.pinned = [];
    csStore.prefs = { compact: false, times: true, ping: true, size: 'm', words: [], ...(csStore.prefs || {}) };
    if (!Array.isArray(csStore.prefs.words)) csStore.prefs.words = [];
  }
  return csStore;
}
function csSave() {
  clearTimeout(csSaveTimer);
  csSaveTimer = setTimeout(() => { try { localStorage.setItem(CS_STORE, JSON.stringify(csStore)); } catch { /* full */ } }, 150);
}
function csMsgs(c, ch) {
  const cutoff = Date.now() - CS_KEEP_MS;
  return (c?.messages?.[ch?.id] || []).filter((m) => !m.at || m.at >= cutoff);
}
const csMsgId = (m) => String(m.id || `${m.at}|${m.from}`);
const csIsMine = (m) => normVoiceId(m.from) === myVoiceId();
function csReadAt(c, ch) {
  const st = csState();
  const k = msgKey(c.id, ch.id);
  if (st.read[k] == null) {
    const ms = csMsgs(c, ch);
    st.read[k] = ms.length ? (ms[ms.length - 1].at || Date.now()) : Date.now();
    csSave();
  }
  return st.read[k];
}
function csMarkRead(c, ch) {
  if (!c || !ch) return;
  const st = csState();
  const k = msgKey(c.id, ch.id);
  const ms = csMsgs(c, ch);
  const latest = ms.length ? Math.max(...ms.map((m) => m.at || 0)) : 0;
  if ((st.read[k] || 0) >= latest && st.read[k] != null) return false;
  st.read[k] = Math.max(Date.now(), latest);
  csSave();
  return true;
}
function csMentionsMe(m) {
  const me = myName();
  if (!me || csIgnored(m.from)) return false;
  const reply = scParseReply(m.text);
  const body = reply ? reply.body : String(m.text || '');
  return scMentionsMe(body, me) || reply?.to?.toLowerCase() === me.toLowerCase() || csWordHit(body);
}
/** Your own alert words count like a mention. */
function csWordHit(text) {
  const words = csState().prefs.words;
  if (!words.length) return false;
  const low = String(text || '').toLowerCase();
  return words.some((w) => {
    const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${safe}($|[^\\p{L}\\p{N}_])`, 'iu').test(low);
  });
}
const csIgnored = (uuid) => !!csState().ignore[normVoiceId(uuid)];
/** The name you see for someone: your private nickname for them, or their real name. */
const csName = (uuid, name) => csState().nick[normVoiceId(uuid)] || name || 'Someone';
const csMuted = (c, ch) => !!csState().mute[msgKey(c.id, ch.id)];
const csNotifyLevel = (c) => csState().notify[c.id] || 'mentions';
/** New messages since you last looked: { n, at } where at counts the ones that mention you. */
function csUnread(c, ch) {
  if (!c || !ch || ch.kind !== 'text') return { n: 0, at: 0 };
  const read = csReadAt(c, ch);
  let n = 0;
  let at = 0;
  for (const m of csMsgs(c, ch)) {
    if ((m.at || 0) <= read || csIsMine(m) || csIgnored(m.from)) continue;
    n++;
    if (csMentionsMe(m)) at++;
  }
  return { n, at };
}
function csCommunityUnread(c) {
  if (csNotifyLevel(c) === 'none') return { n: 0, at: 0 };
  let n = 0;
  let at = 0;
  for (const ch of c.channels || []) {
    const u = csUnread(c, ch);
    at += u.at;
    if (!csMuted(c, ch)) n += u.n;
  }
  return { n, at };
}
function csMarkCommunityRead(c) {
  for (const ch of c.channels || []) if (ch.kind === 'text') csMarkRead(c, ch);
  renderCommunities();
  if (openCommunityId === c.id) renderCommunityStage();
}
function csMarkAllRead() {
  for (const c of readCommunities()) for (const ch of c.channels || []) if (ch.kind === 'text') csMarkRead(c, ch);
  csHoldRead = null;
  renderCommunities();
  if (openCommunityId) renderCommunityStage();
  showToast('All caught up', 'Every community is marked as read.', 'success');
}
/** Channel whose read marker you moved back by hand; it isn't cleared again until you leave it. */
let csHoldRead = null;
const csScrollMem = new Map();
const csShowIgnored = new Set();
function csIsSaved(c, chId, m) {
  const id = csMsgId(m);
  return csState().saved.some((s) => s.cid === c.id && s.chid === chId && s.id === id);
}
function csToggleSaved(c, ch, m) {
  const st = csState();
  const id = csMsgId(m);
  const i = st.saved.findIndex((s) => s.cid === c.id && s.chid === ch.id && s.id === id);
  if (i >= 0) { st.saved.splice(i, 1); showToast('Removed from saved', '', 'info'); }
  else {
    st.saved.unshift({ cid: c.id, chid: ch.id, chName: ch.name, id, from: m.from, name: m.name, text: m.text, at: m.at, savedAt: Date.now() });
    st.saved = st.saved.slice(0, 200);
    showToast('Saved', 'Find it under Saved in the channel header. It stays on this PC even after the message expires.', 'success');
  }
  csSave();
}
async function csCopy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); showToast(what, '', 'success'); }
  catch { showToast("Couldn't copy", 'Clipboard is not available.', 'error'); }
}

function closeCommunityStage() {
  document.getElementById('community-stage')?.classList.add('hidden');
  document.getElementById('cs-addbar')?.classList.add('hidden');
  document.getElementById('cs-invite-pop')?.classList.add('hidden');
  csToggleMembers(false);
  openCommunityId = null;
  openChannelId = null;
  document.body.classList.remove('community-open');
  document.querySelectorAll('.rail-comm, .rail-comm-wrap').forEach((b) => b.classList.remove('active'));
  document.querySelector('.cs-saved')?.remove();
  csMentionAuto?.destroy();
  csMentionAuto = null;
  requestAnimationFrame(navInk);
}

function communityInviteLink(community) {
  if (!community.code) return '';
  return `https://figgysmp.shop/?community=${encodeURIComponent(community.id)}&code=${encodeURIComponent(community.code)}`;
}

// ---- community voice: Opus over the SolarClient connection -------------
// Mic -> AudioWorklet (20ms frames) -> WebCodecs Opus -> backend relay ->
// each listener's AudioDecoder -> scheduled playback with a small jitter buffer.
const VOICE_RATE = 48000;
const VOICE_FRAME = 960;
const voiceRooms = new Map(); // "communityId:channelId" -> [{ uuid, name }]
let voiceSfxCtx = null;
const VOICE_GATE_RMS = 0.008;
const VOICE_GATE_HOLD_MS = 350;

// Posts 20ms frames for the server relay, and outputs the same mic with the
// mute and noise gate applied (per 128-sample block) for direct WebRTC audio.
const VOICE_WORKLET = `
class SolarMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${VOICE_FRAME}); this.n = 0;
    this.muted = false; this.gate = true; this.openUntil = 0; this.g = 0;
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.muted === 'boolean') this.muted = d.muted;
      if (typeof d.gate === 'boolean') this.gate = d.gate;
    };
  }
  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0];
    const out = outputs[0] && outputs[0][0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, ${VOICE_FRAME} - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === ${VOICE_FRAME}) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(${VOICE_FRAME});
          this.n = 0;
        }
      }
      if (out) {
        let sum = 0;
        for (let k = 0; k < ch.length; k++) sum += ch[k] * ch[k];
        if (Math.sqrt(sum / ch.length) > ${VOICE_GATE_RMS}) this.openUntil = currentTime + ${VOICE_GATE_HOLD_MS / 1000};
        const target = this.muted ? 0 : (!this.gate || currentTime < this.openUntil ? 1 : 0);
        const step = target > this.g ? 1 / 240 : 1 / 1920;
        for (let k = 0; k < ch.length; k++) {
          if (this.g < target) this.g = Math.min(target, this.g + step);
          else if (this.g > target) this.g = Math.max(target, this.g - step);
          out[k] = ch[k] * this.g;
        }
      }
    }
    return true;
  }
}
registerProcessor('solar-mic', SolarMic);
`;

function voiceKey(communityId, channelId) {
  return `${communityId}:${channelId}`;
}

function normVoiceId(u) {
  return String(u || '').replace(/-/g, '').toLowerCase();
}

function myVoiceId() {
  return normVoiceId(friendsState?.self?.id);
}

function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function b64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Send an audio context to the chosen speakers or headphones. */
async function routeOutput(ctx) {
  if (!ctx?.setSinkId) return;
  const want = voicePrefs().outputId;
  if ((ctx.sinkId || '') === want) return;
  try { await ctx.setSinkId(want); }
  catch {
    // Unplugged since it was picked: fall back to the system default.
    saveVoicePrefs({ outputId: '' });
    try { await ctx.setSinkId(''); } catch { /* keep whatever it had */ }
  }
}

/** Short two-note chime: rising for a join, falling for a leave, a little tune for a test. */
function playVoiceSfx(kind) {
  try {
    if (!voiceSfxCtx) {
      voiceSfxCtx = new AudioContext();
      routeOutput(voiceSfxCtx);
    }
    const ctx = voiceSfxCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const notes = kind === 'join' ? [659.25, 987.77] : kind === 'test' ? [523.25, 659.25, 783.99] : [783.99, 523.25];
    const t0 = ctx.currentTime + 0.02;
    const peak = Math.max(0.0002, 0.2 * (voicePrefs().outputVolume / 100));
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.11;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.19);
    });
  } catch { /* no audio device */ }
}

const VOICE_PREFS_KEY = 'solar.voice.prefs';

function voicePrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(VOICE_PREFS_KEY) || '{}') || {}; } catch { p = {}; }
  const vol = Number(p.micVolume);
  const outVol = Number(p.outputVolume);
  return {
    deviceId: typeof p.deviceId === 'string' ? p.deviceId : '',
    outputId: typeof p.outputId === 'string' ? p.outputId : '',
    outputVolume: Number.isFinite(outVol) ? Math.min(200, Math.max(0, outVol)) : 100,
    micVolume: Number.isFinite(vol) ? Math.min(200, Math.max(0, vol)) : 100,
    noiseCancel: p.noiseCancel !== false,
    muted: p.muted === true,
    deafened: p.deafened === true,
    peerVolumes: p.peerVolumes && typeof p.peerVolumes === 'object' ? p.peerVolumes : {},
  };
}

function saveVoicePrefs(patch) {
  const next = { ...voicePrefs(), ...patch };
  try { localStorage.setItem(VOICE_PREFS_KEY, JSON.stringify(next)); } catch { /* storage full */ }
  return next;
}

function peerVolume(uuid) {
  const v = Number(voicePrefs().peerVolumes[normVoiceId(uuid)]);
  return Number.isFinite(v) ? Math.min(200, Math.max(0, v)) : 100;
}

function setPeerVolume(uuid, pct) {
  const prefs = voicePrefs();
  prefs.peerVolumes[normVoiceId(uuid)] = pct;
  saveVoicePrefs({ peerVolumes: prefs.peerVolumes });
  const p = voiceSession?.peers.get(uuid);
  if (p && !voiceSession.deafened) p.gain.gain.value = pct / 100;
}

let rnnoiseAssets = null;

function loadRnnoise() {
  if (!rnnoiseAssets) {
    rnnoiseAssets = window.nebula.voiceRnnoise().then((a) => ({ worklet: a.worklet, wasm: new Uint8Array(a.wasm) }));
    rnnoiseAssets.catch(() => { rnnoiseAssets = null; });
  }
  return rnnoiseAssets;
}

/** RNNoise (xiph, built from source) strips keyboard, fan and room noise while keeping the voice. */
async function createDenoiser(ctx) {
  const rn = await loadRnnoise();
  const url = URL.createObjectURL(new Blob([rn.worklet], { type: 'text/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const node = new AudioWorkletNode(ctx, 'solar-rnnoise', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { wasm: rn.wasm.slice().buffer },
  });
  node.port.onmessage = (e) => { if (e.data?.error) console.warn('[voice] RNNoise failed to start', e.data.error); };
  return node;
}

function routeMic(session) {
  const useDenoise = session.noiseCancel && !!session.denoise;
  if (session.routedDenoise === useDenoise) return;
  session.routedDenoise = useDenoise;
  try { session.lowCut.disconnect(); } catch { /* not connected yet */ }
  session.lowCut.connect(useDenoise ? session.denoise : session.micGain);
}

function sendVoiceState() {
  const s = voiceSession;
  if (!s) return;
  window.nebula.voiceState?.({ muted: s.muted, deafened: s.deafened })?.catch?.(() => {});
}

function micConstraints(prefs, { echoCancel = true } = {}) {
  const audio = {
    echoCancellation: echoCancel,
    noiseSuppression: prefs.noiseCancel,
    autoGainControl: true,
    channelCount: 1,
  };
  if (prefs.deviceId) audio.deviceId = { exact: prefs.deviceId };
  return { audio };
}

async function openMic(prefs, opts) {
  try {
    return await navigator.mediaDevices.getUserMedia(micConstraints(prefs, opts));
  } catch (err) {
    if (!prefs.deviceId) throw err;
    // The saved microphone is unplugged or gone; use the system default instead.
    saveVoicePrefs({ deviceId: '' });
    return navigator.mediaDevices.getUserMedia(micConstraints({ ...prefs, deviceId: '' }, opts));
  }
}

/** (Re)open the microphone and plug it into the session's processing chain. */
async function attachMic(session) {
  const stream = await openMic(voicePrefs());
  if (session.closed) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  try { session.src?.disconnect(); } catch { /* ok */ }
  try { session.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ok */ }
  session.stream = stream;
  session.src = session.ctx.createMediaStreamSource(stream);
  session.src.connect(session.lowCut);
}

function applyVoicePrefs(session) {
  const prefs = voicePrefs();
  session.deafened = prefs.deafened;
  session.muted = prefs.muted || prefs.deafened;
  session.noiseCancel = prefs.noiseCancel;
  session.micGain.gain.value = prefs.micVolume / 100;
  if (session.master) session.master.gain.value = prefs.outputVolume / 100;
  // Rumble, fans and desk bumps live below ~100 Hz; voices don't.
  session.lowCut.frequency.value = prefs.noiseCancel ? 100 : 10;
  routeMic(session);
  session.mic?.port.postMessage({ muted: session.muted, gate: session.noiseCancel });
  for (const t of session.rtcOut?.getAudioTracks() || []) t.enabled = !session.muted;
  for (const [uuid, p] of session.peers) {
    p.gain.gain.value = session.deafened ? 0 : peerVolume(uuid) / 100;
  }
}

async function leaveVoice(silent = false) {
  const s = voiceSession;
  if (!s) return;
  voiceSession = null;
  s.closed = true;
  clearInterval(s.timer);
  window.nebula.voiceLeave?.()?.catch?.(() => {});
  try { s.mic.port.onmessage = null; } catch { /* ok */ }
  try { s.denoise?.port.postMessage('destroy'); } catch { /* ok */ }
  try { s.encoder.close(); } catch { /* ok */ }
  for (const p of s.peers.values()) {
    try { p.decoder.close(); } catch { /* ok */ }
    dropRtcAudio(p);
  }
  try { s.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ok */ }
  try { s.rtcOut?.getTracks().forEach((t) => t.stop()); } catch { /* ok */ }
  try { await s.ctx.close(); } catch { /* ok */ }
  window.scMedia?.onVoiceLeave();
  if (!silent) playVoiceSfx('leave');
  syncVoiceHangup();
  if (openCommunityId) renderCommunityStage();
}

async function joinVoice(communityId, channelId) {
  if (voiceSession && voiceSession.communityId === communityId && voiceSession.channelId === channelId) return;
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') {
    throw new Error('Voice chat is not supported on this system.');
  }
  if (!friendsState?.connected) throw new Error('Connect to SolarClient online to use voice chat.');
  await window.scMedia?.beforeVoiceJoin();
  await leaveVoice(true);
  const ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: 'interactive' });
  const session = {
    communityId, channelId, ctx, stream: null, src: null, closed: false,
    muted: false, deafened: false, noiseCancel: true, speaking: false, loudAt: 0, openUntil: 0,
    timer: null, encoder: null, peers: new Map(), ts: 0, paintSig: '',
    denoise: null, routedDenoise: null,
  };
  try {
    const url = URL.createObjectURL(new Blob([VOICE_WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    session.lowCut = ctx.createBiquadFilter();
    session.lowCut.type = 'highpass';
    session.micGain = ctx.createGain();
    session.master = ctx.createGain();
    session.master.connect(ctx.destination);
    await routeOutput(ctx);
    session.mic = new AudioWorkletNode(ctx, 'solar-mic', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit',
    });
    try {
      session.denoise = await createDenoiser(ctx);
      session.denoise.connect(session.micGain);
    } catch (err) {
      console.warn('[voice] RNNoise unavailable', err);
      session.denoise = null;
    }
    // The worklet must be pulled by the graph to run; a silent sink keeps it live.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    session.micGain.connect(session.mic).connect(sink).connect(ctx.destination);
    // The same mic, gated, for people we reach directly over WebRTC (calls.js).
    const rtcDest = ctx.createMediaStreamDestination();
    rtcDest.channelCount = 1;
    session.mic.connect(rtcDest);
    session.rtcOut = rtcDest.stream;
    applyVoicePrefs(session);
    await attachMic(session);
  } catch (err) {
    session.closed = true;
    try { session.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ok */ }
    ctx.close().catch(() => {});
    throw err;
  }

  session.encoder = new AudioEncoder({
    output: (chunk) => {
      if (voiceSession !== session) return;
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      window.nebula.voiceAudio({ d: bytesToB64(bytes), ts: chunk.timestamp });
    },
    error: (err) => console.warn('[voice] encoder', err),
  });
  session.encoder.configure({ codec: 'opus', sampleRate: VOICE_RATE, numberOfChannels: 1, bitrate: 32000 });
  session.mic.port.onmessage = (e) => {
    if (voiceSession !== session || session.encoder.state !== 'configured') return;
    const pcm = e.data;
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const now = performance.now();
    if (Math.sqrt(sum / pcm.length) > VOICE_GATE_RMS) {
      session.loudAt = now;
      session.openUntil = now + VOICE_GATE_HOLD_MS;
    }
    if (session.muted) return;
    // Noise gate: between words, send nothing instead of background hiss.
    if (session.noiseCancel && now > session.openUntil) return;
    // Everyone here hears us directly; the server relay would only add a duplicate.
    if (window.scMedia?.roomAudioCovered()) return;
    if (session.encoder.encodeQueueSize > 10) return;
    const frame = new AudioData({
      format: 'f32-planar', sampleRate: VOICE_RATE, numberOfFrames: pcm.length,
      numberOfChannels: 1, timestamp: session.ts, data: pcm,
    });
    session.ts += Math.round((pcm.length / VOICE_RATE) * 1e6);
    try { session.encoder.encode(frame); } finally { frame.close(); }
  };

  voiceSession = session;
  session.timer = setInterval(() => {
    if (voiceSession !== session) return;
    const now = performance.now();
    for (const p of session.peers.values()) if (p.rtcLevel && rtcLevel(p) > 0.02) p.loudAt = now;
    session.speaking = !session.muted && now - session.loudAt < 300;
    const sig = `${session.speaking}|${session.muted}|${session.deafened}|${[...session.peers].map(([u, p]) => `${u}:${now - p.loudAt < 350}`).join(',')}`;
    if (sig !== session.paintSig) {
      session.paintSig = sig;
      paintVoiceMembers();
    }
  }, 140);
  try {
    await window.nebula.voiceJoin({ id: communityId, channelId, muted: session.muted, deafened: session.deafened });
  } catch (err) {
    await leaveVoice(true);
    throw err;
  }
  syncVoiceHangup();
  renderCommunityStage();
}

function voicePeer(session, uuid) {
  let p = session.peers.get(uuid);
  if (p && p.decoder.state === 'configured') return p;
  if (p) {
    try { p.gain.disconnect(); } catch { /* ok */ }
  }
  const gain = session.ctx.createGain();
  gain.gain.value = session.deafened ? 0 : peerVolume(uuid) / 100;
  gain.connect(session.master);
  p = { gain, nextTime: 0, loudAt: 0, decoder: null };
  const peer = p;
  p.decoder = new AudioDecoder({
    output: (data) => playVoiceFrame(session, peer, data),
    error: (err) => console.warn('[voice] decoder', err),
  });
  p.decoder.configure({ codec: 'opus', sampleRate: VOICE_RATE, numberOfChannels: 1 });
  const old = session.peers.get(uuid);
  if (old?.rtcSrc) {
    Object.assign(p, pickRtc(old));
    p.rtcSrc.connect(p.gain);
  }
  session.peers.set(uuid, p);
  return p;
}

function pickRtc(p) {
  return { rtcStream: p.rtcStream, rtcEl: p.rtcEl, rtcSrc: p.rtcSrc, rtcLevel: p.rtcLevel, rtcBuf: p.rtcBuf };
}

function dropRtcAudio(p) {
  try { p.rtcSrc?.disconnect(); } catch { /* ok */ }
  if (p.rtcEl) { p.rtcEl.srcObject = null; p.rtcEl.remove(); }
  p.rtcStream = p.rtcEl = p.rtcSrc = p.rtcLevel = p.rtcBuf = null;
}

function rtcLevel(p) {
  p.rtcBuf ||= new Float32Array(p.rtcLevel.fftSize);
  p.rtcLevel.getFloatTimeDomainData(p.rtcBuf);
  let sum = 0;
  for (let i = 0; i < p.rtcBuf.length; i += 4) sum += p.rtcBuf[i] * p.rtcBuf[i];
  return Math.sqrt(sum / (p.rtcBuf.length / 4));
}

/**
 * Someone in the voice room reaches us directly over WebRTC (calls.js), or
 * stopped (stream = null). While direct audio is up, their server-relayed
 * frames are ignored; it plays through the same per-person volume and deafen.
 */
function setVoiceRtcAudio(uuid, stream) {
  const s = voiceSession;
  if (!s || s.closed) return;
  const p = stream ? voicePeer(s, uuid) : s.peers.get(uuid);
  if (!p || p.rtcStream === stream) return;
  dropRtcAudio(p);
  if (!stream) return;
  // Chromium only feeds a remote WebRTC stream into Web Audio while a media element holds it.
  const el = document.createElement('audio');
  el.muted = true;
  el.srcObject = stream;
  el.play().catch(() => {});
  p.rtcEl = el;
  p.rtcStream = stream;
  p.rtcSrc = s.ctx.createMediaStreamSource(stream);
  p.rtcLevel = s.ctx.createAnalyser();
  p.rtcLevel.fftSize = 2048;
  p.rtcSrc.connect(p.rtcLevel);
  p.rtcSrc.connect(p.gain);
  p.nextTime = 0;
}

async function fillMicSelect(select) {
  if (!select) return;
  let mics = [];
  try {
    mics = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* no devices */ }
  const current = voicePrefs().deviceId;
  select.innerHTML = '<option value="">System default</option>' + mics.map((d, i) =>
    `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Microphone ${i + 1}`)}</option>`).join('');
  select.value = mics.some((d) => d.deviceId === current) ? current : '';
  select._refreshCustomSelect?.();
}

const VOICE_ICONS = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  headphones: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
  headphonesOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  text: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 6h10v2H7zm0 3.5h10v2H7zM7 13h6v2H7z"/></svg>',
  people: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  hangup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.3 11.3 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>',
};

async function fillOutputSelect(select) {
  if (!select) return;
  let outs = [];
  let fallbackLabel = '';
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    fallbackLabel = all.find((d) => d.deviceId === 'default')?.label.replace(/^Default\s*-\s*/i, '') || '';
    outs = all.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch { /* no devices */ }
  const current = voicePrefs().outputId;
  // Windows can list two outputs with the same name; number the repeats so they can be told apart.
  const seen = new Map();
  const label = (d, i) => {
    const base = String(d.label || `Speaker ${i + 1}`).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} ${n}` : base;
  };
  select.innerHTML = `<option value="">${escapeHtml(fallbackLabel ? `System default (${fallbackLabel})` : 'System default')}</option>`
    + outs.map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(label(d, i))}</option>`).join('');
  select.value = outs.some((d) => d.deviceId === current) ? current : '';
  select._refreshCustomSelect?.();
}

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  fillMicSelect(document.getElementById('cs-mic'));
  fillOutputSelect(document.getElementById('cs-out'));
});

// ---- Mic test: play your own mic back through the same cleanup as voice chat ----
// You're deafened while it runs (so others' voices don't mix in and they
// can't hear the test); stopping puts deafen back to how it was.
let micTest = null;
let repaintVoiceControls = () => {};

async function wireMicTest(t) {
  const prefs = voicePrefs();
  // The test plays your own voice back, and Chromium's echo canceller treats that playback
  // as echo and keeps cancelling your voice out of the mic, so the test chops in and out.
  const stream = await openMic(prefs, { echoCancel: false });
  if (t.closed) { stream.getTracks().forEach((tr) => tr.stop()); return; }
  try { t.src?.disconnect(); } catch { /* ok */ }
  try { t.stream?.getTracks().forEach((tr) => tr.stop()); } catch { /* ok */ }
  t.stream = stream;
  t.src = t.ctx.createMediaStreamSource(stream);
  t.src.connect(t.lowCut);
}

function applyMicTestPrefs(t = micTest) {
  if (!t?.ctx || t.closed) return;
  const prefs = voicePrefs();
  t.micGain.gain.value = prefs.micVolume / 100;
  t.out.gain.value = prefs.outputVolume / 100;
  routeOutput(t.ctx);
}

function teardownMicTest(t) {
  if (!t) return;
  t.closed = true;
  try { t.denoise?.port.postMessage('destroy'); } catch { /* ok */ }
  try { t.stream?.getTracks().forEach((tr) => tr.stop()); } catch { /* ok */ }
  try { t.ctx?.close(); } catch { /* ok */ }
}

async function startMicTest(prevDeafened = voicePrefs().deafened) {
  if (micTest) return;
  const t = { prevDeafened, closed: false };
  micTest = t;
  saveVoicePrefs({ deafened: true });
  if (voiceSession) { applyVoicePrefs(voiceSession); sendVoiceState(); }
  repaintVoiceControls();
  try {
    const prefs = voicePrefs();
    t.ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: 'interactive' });
    t.lowCut = t.ctx.createBiquadFilter();
    t.lowCut.type = 'highpass';
    t.lowCut.frequency.value = prefs.noiseCancel ? 100 : 10;
    t.micGain = t.ctx.createGain();
    t.out = t.ctx.createGain();
    t.analyser = t.ctx.createAnalyser();
    t.analyser.fftSize = 1024;
    t.micGain.connect(t.analyser);
    t.micGain.connect(t.out).connect(t.ctx.destination);
    t.denoise = null;
    if (prefs.noiseCancel) {
      try { t.denoise = await createDenoiser(t.ctx); } catch (err) { console.warn('[mic test] RNNoise unavailable', err); }
    }
    if (t.closed) return;
    t.lowCut.connect(t.denoise || t.micGain);
    if (t.denoise) t.denoise.connect(t.micGain);
    applyMicTestPrefs(t);
    await wireMicTest(t);
  } catch (err) {
    if (t.closed) return;
    stopMicTest();
    throw err;
  }
  if (t.closed) return;
  const buf = new Float32Array(t.analyser.fftSize);
  const tick = () => {
    if (micTest !== t) return;
    const btn = document.getElementById('cs-mictest');
    if (!btn || !btn.isConnected || btn.offsetParent === null) { stopMicTest(); return; }
    t.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
    const bar = document.getElementById('cs-mictest-level');
    if (bar) bar.style.width = `${Math.round(level * 100)}%`;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stopMicTest() {
  const t = micTest;
  if (!t) return;
  micTest = null;
  teardownMicTest(t);
  saveVoicePrefs({ deafened: t.prevDeafened });
  if (voiceSession) { applyVoicePrefs(voiceSession); sendVoiceState(); }
  const bar = document.getElementById('cs-mictest-level');
  if (bar) bar.style.width = '0%';
  repaintVoiceControls();
}

window.addEventListener('beforeunload', () => stopMicTest());

/** Rebuild the test with the current mic / noise cancellation settings. */
async function restartMicTest() {
  const t = micTest;
  if (!t) return;
  micTest = null;
  teardownMicTest(t);
  try { await startMicTest(t.prevDeafened); }
  catch (err) { showToast('Mic test', err?.message || 'Could not open the microphone.', 'error'); }
}

/** Mute, deafen, mic picker, mic volume and noise cancellation on the voice channel page. */
function bindVoiceControls(main) {
  const prefs = voicePrefs();
  const select = main.querySelector('#cs-mic');
  const vol = main.querySelector('#cs-mic-vol');
  const volVal = main.querySelector('#cs-mic-vol-val');
  const nc = main.querySelector('#cs-nc');
  const mute = main.querySelector('#cs-mute');
  const deafen = main.querySelector('#cs-deafen');
  if (select) {
    // The portaled panel from the last render is orphaned once the page is rebuilt.
    document.querySelectorAll('body > .custom-select-panel.cs-mic-panel').forEach((p) => p.remove());
    enhanceSelect('cs-mic');
    select.previousElementSibling?.querySelector?.('.custom-select-panel')?.classList.add('cs-mic-panel');
  }
  fillMicSelect(select);
  if (vol) vol.value = String(prefs.micVolume);
  if (volVal) volVal.textContent = `${prefs.micVolume}%`;
  const outSelect = main.querySelector('#cs-out');
  const outVol = main.querySelector('#cs-out-vol');
  const outVolVal = main.querySelector('#cs-out-vol-val');
  if (outSelect) {
    document.querySelectorAll('body > .custom-select-panel.cs-out-panel').forEach((p) => p.remove());
    enhanceSelect('cs-out');
    outSelect.previousElementSibling?.querySelector?.('.custom-select-panel')?.classList.add('cs-out-panel');
  }
  fillOutputSelect(outSelect);
  if (outVol) outVol.value = String(prefs.outputVolume);
  if (outVolVal) outVolVal.textContent = `${prefs.outputVolume}%`;
  outSelect?.addEventListener('change', async () => {
    saveVoicePrefs({ outputId: outSelect.value || '' });
    voiceSfxCtx ||= new AudioContext();
    applyMicTestPrefs();
    await Promise.all([routeOutput(voiceSession?.ctx), routeOutput(voiceSfxCtx)]);
    playVoiceSfx('test');
  });
  outVol?.addEventListener('input', () => {
    const v = Number(outVol.value);
    saveVoicePrefs({ outputVolume: v });
    if (outVolVal) outVolVal.textContent = `${v}%`;
    if (voiceSession) applyVoicePrefs(voiceSession);
    applyMicTestPrefs();
  });
  main.querySelector('#cs-out-test')?.addEventListener('click', async () => {
    voiceSfxCtx ||= new AudioContext();
    await routeOutput(voiceSfxCtx);
    playVoiceSfx('test');
  });
  if (nc) nc.checked = prefs.noiseCancel;
  const paintMute = () => {
    const p = voicePrefs();
    const muted = p.muted || p.deafened;
    if (mute) {
      mute.innerHTML = muted ? VOICE_ICONS.micOff : VOICE_ICONS.mic;
      mute.classList.toggle('is-on', muted);
      mute.title = muted ? 'Unmute' : 'Mute';
      mute.setAttribute('aria-pressed', String(muted));
    }
    if (deafen) {
      deafen.innerHTML = p.deafened ? VOICE_ICONS.headphonesOff : VOICE_ICONS.headphones;
      deafen.classList.toggle('is-on', p.deafened);
      deafen.title = p.deafened ? 'Undeafen' : 'Deafen';
      deafen.setAttribute('aria-pressed', String(p.deafened));
    }
  };
  paintMute();
  const micTestBtn = main.querySelector('#cs-mictest');
  const paintMicTest = () => {
    if (!micTestBtn) return;
    const on = !!micTest;
    micTestBtn.classList.toggle('on', on);
    micTestBtn.innerHTML = on
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6z"/></svg>Stop test'
      : `${VOICE_ICONS.mic}Test mic`;
    const hint = main.querySelector('#cs-mictest-hint');
    if (hint) {
      hint.textContent = on
        ? "You're hearing your mic now. You're deafened until you stop the test."
        : "Hear yourself to check your mic. You'll be deafened while it runs. Headphones work best.";
    }
  };
  paintMicTest();
  repaintVoiceControls = () => { paintMute(); paintMicTest(); paintVoiceMembers(); };
  micTestBtn?.addEventListener('click', async () => {
    if (micTest) { stopMicTest(); return; }
    try { await startMicTest(); }
    catch (err) { showToast('Mic test', err?.message || 'Could not open the microphone.', 'error'); }
  });
  const voiceStateChanged = () => {
    if (voiceSession) {
      applyVoicePrefs(voiceSession);
      sendVoiceState();
    }
    paintMute();
    paintVoiceMembers();
  };

  select?.addEventListener('change', async () => {
    saveVoicePrefs({ deviceId: select.value });
    if (micTest) restartMicTest();
    const s = voiceSession;
    if (!s) return;
    try { await attachMic(s); }
    catch (err) { showToast('Microphone', err?.message || 'Could not switch microphones.', 'error'); }
  });
  vol?.addEventListener('input', () => {
    const v = Number(vol.value);
    saveVoicePrefs({ micVolume: v });
    if (volVal) volVal.textContent = `${v}%`;
    if (voiceSession) applyVoicePrefs(voiceSession);
    applyMicTestPrefs();
  });
  const paintNc = () => {
    nc?.closest('.cs-nc-card')?.classList.toggle('on', !!nc.checked);
    const sub = main.querySelector('#cs-nc-sub');
    if (sub) sub.textContent = nc?.checked ? 'On: keyboard, fans and background noise are removed' : 'Off: everything your mic hears is sent';
  };
  paintNc();
  nc?.addEventListener('change', async () => {
    saveVoicePrefs({ noiseCancel: nc.checked });
    paintNc();
    if (micTest) restartMicTest();
    const s = voiceSession;
    if (!s) return;
    applyVoicePrefs(s);
    try { await attachMic(s); } catch { /* keep the old stream */ }
  });
  mute?.addEventListener('click', () => {
    stopMicTest();
    const p = voicePrefs();
    // Unmuting while deafened turns hearing back on too.
    if (p.deafened) saveVoicePrefs({ deafened: false, muted: false });
    else saveVoicePrefs({ muted: !p.muted });
    voiceStateChanged();
  });
  deafen?.addEventListener('click', () => {
    if (micTest) { stopMicTest(); return; }
    saveVoicePrefs({ deafened: !voicePrefs().deafened });
    voiceStateChanged();
  });
}

function playVoiceFrame(session, peer, data) {
  if (voiceSession !== session) { data.close(); return; }
  const n = data.numberOfFrames;
  const rate = data.sampleRate;
  const pcm = new Float32Array(n);
  try {
    data.copyTo(pcm, { planeIndex: 0, format: 'f32-planar' });
  } catch {
    try { data.copyTo(pcm, { planeIndex: 0 }); } catch { data.close(); return; }
  }
  data.close();
  let sum = 0;
  for (let i = 0; i < n; i += 4) sum += pcm[i] * pcm[i];
  if (Math.sqrt(sum / Math.max(1, n / 4)) > 0.02) peer.loudAt = performance.now();
  const ctx = session.ctx;
  const buf = ctx.createBuffer(1, n, rate);
  buf.copyToChannel(pcm, 0);
  const node = ctx.createBufferSource();
  node.buffer = buf;
  node.connect(peer.gain);
  const now = ctx.currentTime;
  // Adaptive jitter buffer: starts at 30ms, grows 15ms each time audio runs dry
  // (up to 150ms on a bad connection), and creeps back down while it's smooth.
  peer.jitter ||= 0.03;
  // (A gap longer than 200ms is the noise gate between words, not the network.)
  if (peer.nextTime && peer.nextTime < now + 0.003 && peer.nextTime > now - 0.2) peer.jitter = Math.min(0.15, peer.jitter + 0.015);
  else peer.jitter = Math.max(0.03, peer.jitter - 0.0002);
  if (peer.nextTime < now + 0.003 || peer.nextTime > now + peer.jitter + 0.12) peer.nextTime = now + peer.jitter;
  node.start(peer.nextTime);
  peer.nextTime += buf.duration;
}

function onVoiceRoom(m) {
  const key = voiceKey(m.id, m.channelId);
  const prev = voiceRooms.get(key) || [];
  const next = Array.isArray(m.members) ? m.members : [];
  if (next.length) voiceRooms.set(key, next);
  else voiceRooms.delete(key);
  const s = voiceSession;
  if (s && voiceKey(s.communityId, s.channelId) === key) {
    const me = myVoiceId();
    const before = new Set(prev.map((x) => normVoiceId(x.uuid)));
    const after = new Set(next.map((x) => normVoiceId(x.uuid)));
    if ([...after].some((u) => !before.has(u))) playVoiceSfx('join');
    else if ([...before].some((u) => !after.has(u) && u !== me)) playVoiceSfx('leave');
    for (const [u, p] of [...s.peers]) {
      if (after.has(normVoiceId(u))) continue;
      try { p.decoder.close(); } catch { /* ok */ }
      dropRtcAudio(p);
      try { p.gain.disconnect(); } catch { /* ok */ }
      s.peers.delete(u);
    }
  }
  if (openCommunityId === m.id && openChannelId === m.channelId) paintVoiceMembers();
  if (openCommunityId === m.id) paintVoiceOccupants();
}

window.nebula.onVoiceEvent?.((m) => {
  if (!m) return;
  if (m.t === 'voice_audio') {
    const s = voiceSession;
    if (!s || s.deafened || !m.from || typeof m.d !== 'string') return;
    const p = voicePeer(s, m.from);
    if (p.rtcStream) return;
    try {
      p.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Number(m.ts) || 0, data: b64ToBytes(m.d) }));
    } catch { /* bad frame */ }
    return;
  }
  if (m.t === 'voice_room') { onVoiceRoom(m); return; }
  if (m.t === 'voice_error') {
    showToast('Voice chat', m.reason || 'Could not join voice chat.', 'error');
    leaveVoice(true);
  }
});

// Network back (Wi-Fi switch, cable, VPN): check the online connection right away.
window.addEventListener('online', () => window.nebula.friendsWake?.()?.catch?.(() => {}));

// The server forgets voice rooms when the connection drops; rejoin on reconnect.
window.nebula.onFriendsConnection?.((c) => {
  const s = voiceSession;
  if (!s) return;
  if (c?.connected) window.nebula.voiceJoin({ id: s.communityId, channelId: s.channelId, muted: s.muted, deafened: s.deafened }).catch(() => {});
  else voiceRooms.clear();
});

function syncVoiceHangup() {
  const btn = document.getElementById('rail-hangup');
  if (!btn) return;
  btn.classList.toggle('hidden', !voiceSession);
}

function paintVoiceMembers() {
  const host = document.getElementById('cs-voice-members');
  if (!host || !openCommunityId || !openChannelId) return;
  const key = voiceKey(openCommunityId, openChannelId);
  const s = voiceSession && voiceKey(voiceSession.communityId, voiceSession.channelId) === key ? voiceSession : null;
  const me = myVoiceId();
  let list = voiceRooms.get(key) || [];
  if (s && !list.some((x) => normVoiceId(x.uuid) === me)) list = [{ uuid: me, name: host.dataset.name || 'You' }, ...list];
  // Rebuild rows only when who is here changes, so a volume slider being dragged survives repaints.
  const sig = `${s ? 1 : 0}|${list.map((x) => `${normVoiceId(x.uuid)}:${x.name}`).join(',')}`;
  if (host.dataset.sig !== sig) {
    host.dataset.sig = sig;
    host.innerHTML = list.map((x) => {
      const mine = normVoiceId(x.uuid) === me;
      const vol = peerVolume(x.uuid);
      return `
        <div class="cs-member" data-uuid="${escapeHtml(x.uuid)}">
          <span class="cs-member-face"><img src="${frAvatar(x.uuid)}" alt="" ${personAttr(x.uuid, x.name)}><span class="cs-member-dot"></span></span>
          <span class="cs-member-name" ${personAttr(x.uuid, x.name)}>${escapeHtml(x.name || 'Someone')}</span>
          ${mine ? '<span class="cs-member-you">You</span>' : reportFlag(x.uuid, x.name, { where: 'Community voice chat' })}
          <span class="cs-member-state cs-member-muted" title="Muted">${VOICE_ICONS.micOff}</span>
          <span class="cs-member-state cs-member-deaf" title="Deafened">${VOICE_ICONS.headphonesOff}</span>
          ${s && !mine ? `<span class="cs-member-volwrap"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg><input type="range" class="cs-member-vol" min="0" max="200" step="5" value="${vol}" data-unit="%" title="Volume ${vol}%" aria-label="Volume for ${escapeHtml(x.name || 'Someone')}"></span>` : ''}
        </div>`;
    }).join('');
    host.querySelectorAll('.cs-member-vol').forEach((range) => {
      const uuid = range.closest('.cs-member')?.dataset.uuid;
      range.addEventListener('input', () => {
        const v = Number(range.value);
        range.title = `Volume ${v}%`;
        setPeerVolume(uuid, v);
      });
    });
  }
  const now = performance.now();
  const byId = new Map(list.map((x) => [normVoiceId(x.uuid), x]));
  host.querySelectorAll('.cs-member').forEach((row) => {
    const uuid = row.dataset.uuid;
    const mine = normVoiceId(uuid) === me;
    const info = byId.get(normVoiceId(uuid)) || {};
    const deafened = mine && s ? s.deafened : !!info.deafened;
    const muted = mine && s ? s.muted : (!!info.muted || deafened);
    const peer = s && s.peers.get(uuid);
    const speaking = !muted && (mine ? !!s?.speaking : !!(peer && now - peer.loudAt < 350));
    row.classList.toggle('speaking', speaking);
    row.classList.toggle('muted', muted);
    row.classList.toggle('deafened', deafened);
  });
  host.closest('.cs-voice')?.classList.toggle('is-here', !!s);
  const sub = document.getElementById('cs-voice-sub');
  if (sub) {
    const others = list.filter((x) => normVoiceId(x.uuid) !== me).length;
    sub.textContent = s
      ? (s.deafened ? 'You joined this voice chat. You are deafened, so you can\'t hear anyone and they can\'t hear you.'
        : s.muted ? 'You joined this voice chat. You are muted.'
        : others ? 'You joined this voice chat. Your microphone is on.' : 'You joined this voice chat. Waiting for others to join.')
      : (list.length ? `${list.length} in this voice chat.` : 'Nobody is in this voice chat yet.');
  }
  window.scMedia?.decorateMembers(host);
}

/** Small face stack beside each voice channel showing who is in it right now. */
function paintVoiceOccupants() {
  if (!openCommunityId) return;
  document.querySelectorAll('#cs-channels .cs-ch-occ').forEach((el) => {
    const list = voiceRooms.get(voiceKey(openCommunityId, el.dataset.occ)) || [];
    const sig = list.map((x) => normVoiceId(x.uuid)).join(',');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.innerHTML = list.slice(0, 3).map((x) => `<img src="${frAvatar(x.uuid)}" alt="" title="${escapeHtml(x.name || '')}">`).join('')
      + (list.length > 3 ? `<b>+${list.length - 3}</b>` : '');
    el.classList.toggle('on', list.length > 0);
  });
}

function csClock(at) {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function csDayLabel(at) {
  const d = new Date(at);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function renderCommunities() {
  const host = document.getElementById('rail-communities');
  if (!host) return;
  host.innerHTML = '';
  if (!betaLayoutOn()) return;
  const pinned = csState().pinned;
  const pinRank = (c) => { const i = pinned.indexOf(c.id); return i < 0 ? Infinity : i; };
  readCommunities().map((c, i) => [c, i]).sort((a, b) => (pinRank(a[0]) - pinRank(b[0])) || (a[1] - b[1])).forEach(([c]) => {
    const wrap = document.createElement('div');
    wrap.className = `rail-comm-wrap${pinned.includes(c.id) ? ' pinned' : ''}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-comm';
    btn.dataset.id = c.id;
    btn.setAttribute('aria-label', c.name);
    if (c.id === openCommunityId) btn.classList.add('active');
    paintCommunityIcon(btn, c);
    const u = csCommunityUnread(c);
    wrap.classList.toggle('has-unread', u.n > 0);
    wrap.classList.toggle('active', c.id === openCommunityId);
    wrap.insertAdjacentHTML('beforeend', `<i class="rail-pill" aria-hidden="true"></i>${u.at ? `<i class="rail-badge">${u.at > 9 ? '9+' : u.at}</i>` : ''}`);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeRailSheets();
      railTip();
      if (openCommunityId === c.id) {
        if (performance.now() - communityOpenedAt < 450) return;
        closeCommunityStage();
        return;
      }
      openCommunityStage(c.id);
    });
    btn.addEventListener('mouseenter', () => {
      const n = csCommunityUnread(c);
      railTip(btn, c.name, n.at ? `${n.at} ${n.at === 1 ? 'mention' : 'mentions'}` : n.n ? `${n.n} new ${n.n === 1 ? 'message' : 'messages'}` : `${(c.channels || []).length} channels`);
    });
    btn.addEventListener('mouseleave', () => railTip());
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      railTip();
      communityMenu(c, e.clientX, e.clientY);
    });
    wrap.appendChild(btn);
    host.appendChild(wrap);
  });
  if (!document.getElementById('rail-hangup')) {
    const hang = document.createElement('button');
    hang.type = 'button';
    hang.id = 'rail-hangup';
    hang.className = 'rail-hangup hidden';
    hang.title = 'Hang up';
    hang.textContent = '✕';
    hang.addEventListener('click', (e) => { e.stopPropagation(); leaveVoice(); });
    host.parentElement?.appendChild(hang);
  }
  syncVoiceHangup();
}

/** Name bubble beside a rail button; railTip() with no args hides it. */
function railTip(anchor, title, sub) {
  let tip = document.getElementById('rail-tip');
  if (!anchor) { tip?.classList.remove('show'); return; }
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'rail-tip';
    tip.className = 'rail-tip';
    document.body.appendChild(tip);
  }
  tip.innerHTML = `<b>${escapeHtml(title)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ''}`;
  const r = anchor.getBoundingClientRect();
  tip.style.top = `${Math.round(r.top + r.height / 2)}px`;
  tip.style.left = `${Math.round(r.left - 10)}px`;
  tip.classList.remove('show');
  void tip.offsetWidth;
  tip.classList.add('show');
}

/** Right-click menu for a community on the rail or in its header. */
function communityMenu(c, x, y) {
  const level = csNotifyLevel(c);
  const setLevel = (v) => () => { csState().notify[c.id] = v; csSave(); renderCommunities(); };
  const link = communityInviteLink(c);
  const st = csState();
  const isPinned = st.pinned.includes(c.id);
  scMenu(x, y, [
    ['Mark as read', () => csMarkCommunityRead(c)],
    ['Mark every community as read', () => csMarkAllRead(), { hint: 'Shift+Esc' }],
    [isPinned ? 'Unpin from top' : 'Pin to top', () => {
      st.pinned = isPinned ? st.pinned.filter((id) => id !== c.id) : [...st.pinned, c.id];
      csSave();
      renderCommunities();
    }],
    ['Invite friends', () => { openCommunityStage(c.id); setTimeout(() => openCommunityInvite(c), 60); }],
    ...(link ? [['Copy invite link', () => csCopy(link, 'Invite link copied')]] : []),
    '-',
    ['Notify me for every message', setLevel('all'), { check: true, on: level === 'all' }],
    ['Only when I\'m mentioned', setLevel('mentions'), { check: true, on: level === 'mentions' }],
    ['Never notify me', setLevel('none'), { check: true, on: level === 'none' }],
    '-',
    ...(c.isOwner ? [['Community settings', () => openCommunitySettings(c)]] : []),
    [c.isOwner ? 'Delete community' : 'Leave community', async () => {
      const ok = c.isOwner
        ? await showConfirm(`Delete ${c.name} for everyone in it? This can't be undone.`, { title: 'Delete community?', confirmLabel: 'Delete' })
        : await showConfirm(`Leave ${c.name}? You'll need a new invite link to join again.`, { title: 'Leave community?', confirmLabel: 'Leave' });
      if (!ok) return;
      if (voiceSession && voiceSession.communityId === c.id) await leaveVoice();
      try { await window.nebula.communitiesLeave({ id: c.id }); } catch { /* the snapshot drops it anyway */ }
      communityState = communityState.filter((x) => x.id !== c.id);
      if (openCommunityId === c.id) closeCommunityStage();
      renderCommunities();
    }, { danger: true }],
  ], { title: c.name });
}

/** A community's picture, or its first letter when it has none. */
function paintCommunityIcon(el, community) {
  if (!el) return;
  const icon = typeof community?.icon === 'string' && community.icon.startsWith('data:image/') ? community.icon : null;
  el.classList.toggle('has-pic', !!icon);
  if (icon) {
    if (el.querySelector('img')?.getAttribute('src') !== icon) {
      el.textContent = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = icon;
      el.appendChild(img);
    }
  } else {
    el.textContent = String(community?.name || '').trim().charAt(0).toUpperCase() || 'C';
  }
}

function openCommunitySettings(community) {
  if (!community?.isOwner) return;
  document.querySelector('.cset-modal')?.remove();
  let icon = community.icon || null;
  const wrap = document.createElement('div');
  wrap.className = 'sync-modal cset-modal';
  wrap.innerHTML = `
    <div class="sync-card glass cset-card">
      <div class="sync-title">Community settings</div>
      <div class="cset-pic-row">
        <div class="cs-icon cset-pic" id="cset-pic"></div>
        <div class="cset-pic-btns">
          <button type="button" class="pill-btn" id="cset-upload">Upload picture</button>
          <button type="button" class="pill-btn" id="cset-remove">Remove</button>
          <div class="cset-hint">Square images look best. PNG, JPG or WEBP.</div>
        </div>
        <input type="file" id="cset-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
      </div>
      <label class="cset-label" for="cset-name">Name</label>
      <input class="cset-name" id="cset-name" maxlength="32" autocomplete="off" spellcheck="false">
      <div class="cset-error hidden" id="cset-error"></div>
      <div class="sync-actions cset-actions">
        <button type="button" class="pill-btn" data-act="cancel">Cancel</button>
        <button type="button" class="pill-btn primary" data-act="save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const pic = wrap.querySelector('#cset-pic');
  const nameInput = wrap.querySelector('#cset-name');
  const err = wrap.querySelector('#cset-error');
  const fileInput = wrap.querySelector('#cset-file');
  nameInput.value = community.name || '';
  const paintPic = () => {
    paintCommunityIcon(pic, { name: nameInput.value || community.name, icon });
    wrap.querySelector('#cset-remove').disabled = !icon;
  };
  paintPic();
  nameInput.addEventListener('input', () => { if (!icon) paintPic(); });
  wrap.querySelector('#cset-upload').addEventListener('click', () => fileInput.click());
  wrap.querySelector('#cset-remove').addEventListener('click', () => { icon = null; paintPic(); });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try { icon = await imageFileToIcon(file, 128, 0.85); paintPic(); }
    catch (e) { showToast('Bad image', e.message, 'error'); }
  });
  const close = () => wrap.remove();
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  const save = async () => {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    if (!name) { nameInput.focus(); return; }
    const patch = { id: community.id };
    if (name !== community.name) patch.name = name;
    if (icon !== (community.icon || null)) patch.icon = icon;
    if (Object.keys(patch).length === 1) { close(); return; }
    const btn = wrap.querySelector('[data-act="save"]');
    btn.disabled = true;
    err.classList.add('hidden');
    try {
      const res = await window.nebula.communitiesUpdate(patch);
      if (res && res.ok === false) throw new Error(res.reason || 'That did not work.');
      close();
      showToast('Community updated', escapeHtml(name), 'success');
    } catch (e) {
      err.textContent = String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      err.classList.remove('hidden');
      btn.disabled = false;
    }
  };
  wrap.querySelector('[data-act="save"]').addEventListener('click', save);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') close(); });
  setTimeout(() => nameInput.focus(), 30);
}

function openCommunityStage(communityId, channelId) {
  const community = readCommunities().find((c) => c.id === communityId);
  if (!community) return;
  closeRailSheets();
  const switchedCommunity = openCommunityId !== communityId;
  const prevKey = openCommunityId && openChannelId ? msgKey(openCommunityId, openChannelId) : '';
  openCommunityId = communityId;
  const channels = community.channels || [];
  const pick = channels.find((ch) => ch.id === channelId)
    || channels.find((ch) => ch.id === openChannelId)
    || channels.find((ch) => ch.id === csState().lastCh[communityId])
    || channels.find((ch) => ch.kind === 'text')
    || channels[0]
    || null;
  openChannelId = pick ? pick.id : null;
  if (pick && csState().lastCh[communityId] !== pick.id) { csState().lastCh[communityId] = pick.id; csSave(); }
  if (pick && msgKey(communityId, pick.id) !== prevKey) {
    csHoldRead = null;
    csUnreadFrom = pick.kind === 'text' ? csReadAt(community, pick) : 0;
    csBelow = 0;
    csSearch = null;
    if (csReply && csReply.key !== msgKey(communityId, pick.id)) csReply = null;
  }
  csRefreshOnline();
  const stage = document.getElementById('community-stage');
  if (stage?.classList.contains('hidden')) communityOpenedAt = performance.now();
  if (stage && (switchedCommunity || stage.classList.contains('hidden'))) {
    stage.classList.remove('cs-enter');
    void stage.offsetWidth;
    stage.classList.add('cs-enter');
    clearTimeout(stage._enterTimer);
    stage._enterTimer = setTimeout(() => stage.classList.remove('cs-enter'), 1100);
    csIndicator = null;
  }
  stage?.classList.remove('hidden');
  document.body.classList.add('community-open');
  if (stage) {
    try { window.SolarLiquidGlass?.attach?.(stage); } catch { /* glass optional */ }
  }
  renderCommunities();
  renderCommunityStage();
}

let csDragId = null;
function renderCommunityStage() {
  if (csDragId) return;
  const community = readCommunities().find((c) => c.id === openCommunityId);
  const stage = document.getElementById('community-stage');
  if (!community || !stage) return;
  communityStageKey = JSON.stringify(community);
  document.getElementById('cs-title').textContent = community.name;
  paintCommunityIcon(document.getElementById('cs-icon'), community);
  const settingsBtn = document.getElementById('cs-settings');
  if (settingsBtn) {
    settingsBtn.style.display = community.isOwner ? '' : 'none';
    settingsBtn.onclick = (e) => { e.stopPropagation(); openCommunitySettings(community); };
  }
  const channels = community.channels || [];
  const channel = channels.find((ch) => ch.id === openChannelId) || null;
  const list = document.getElementById('cs-channels');
  const main = document.getElementById('cs-main');
  const members = community.members || [];
  const meta = document.getElementById('cs-meta');
  if (meta) {
    const n = members.length;
    meta.textContent = `${n ? `${n} ${n === 1 ? 'member' : 'members'} · ` : ''}${channels.length} ${channels.length === 1 ? 'channel' : 'channels'}`;
  }
  let stagger = 0;
  const st = csState();
  const beta = betaLayoutOn();
  const foldHead = (key, label, count) => `<button type="button" class="cs-kind${st.collapsed[key] ? ' shut' : ''}" data-fold="${escapeHtml(key)}" style="--i:${stagger++}">
      <span><svg class="cs-fold" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3"/></svg>${label}</span><em>${count}</em></button>`;
  const canArrange = beta && community.isOwner;
  const chRow = (ch) => {
      const kind = ch.kind === 'voice' ? 'voice' : 'text';
      const u = csUnread(community, ch);
      const muted = csMuted(community, ch);
      const here = ch.id === openChannelId;
      return `
      <button type="button" class="cs-ch ${here ? 'active' : ''} ${u.n && !muted && !here ? 'unread' : ''} ${muted ? 'muted' : ''}" data-ch="${escapeHtml(ch.id)}" data-kind="${kind}"${canArrange ? ' draggable="true"' : ''} style="--i:${stagger++}">
        <span class="cs-ch-icon">${kind === 'voice' ? VOICE_ICONS.headphones : beta ? VOICE_ICONS.text : '#'}</span><span class="cs-ch-name">${escapeHtml(ch.name)}</span>
        ${muted ? '<svg class="cs-ch-muted" viewBox="0 0 24 24" aria-label="Muted"><path d="M20 18.7 5.3 4 4 5.3l3.1 3.1A6 6 0 0 0 6 12v5l-2 2v1h13.7l1 1 1.3-1.3zM12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6.8V11a6 6 0 0 0-4.5-5.8V4.5a1.5 1.5 0 0 0-3 0v.7c-.5.1-1 .3-1.4.6z"/></svg>' : ''}
        ${u.at && !here ? `<span class="cs-ch-badge">${u.at > 9 ? '9+' : u.at}</span>` : ''}
        ${kind === 'voice' ? `<span class="cs-ch-occ" data-occ="${escapeHtml(ch.id)}"></span>` : ''}
        ${community.isOwner ? `<span class="cs-ch-tools">
          <span class="cs-ch-act" data-act="rename" title="Rename channel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg></span>
          <span class="cs-ch-act" data-act="delete" title="Delete channel"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg></span>
        </span>` : ''}
      </button>
    `;
  };
  const showRow = (shut) => (ch) => !shut || ch.id === openChannelId || csUnread(community, ch).at;
  const group = (kind, label) => {
    const ofKind = channels.filter((ch) => ch.kind === kind);
    const key = `${community.id}:${kind}`;
    const shut = !!st.collapsed[key];
    const head = foldHead(key, label, ofKind.length);
    const rows = ofKind.filter(showRow(shut)).map(chRow).join('');
    return `${head}${rows || (shut ? '' : `<div class="cs-empty" style="--i:${stagger++}">None yet</div>`)}`;
  };
  // Beta: categories (built-in or the owner's own), each a block the owner can drag channels into.
  const catBlocks = () => {
    const L = csLayout(community);
    const loose = L.loose.length ? `<div class="cs-cat" data-cat="">${L.loose.map(chRow).join('')}</div>` : '';
    return loose + L.cats.map((cat) => {
      const chans = L.of.get(cat.id);
      const key = `${community.id}:${cat.id}`;
      const shut = !!st.collapsed[key];
      const rows = chans.filter(showRow(shut)).map(chRow).join('');
      return `<div class="cs-cat" data-cat="${escapeHtml(cat.id)}">
        <div class="cs-cat-head">${foldHead(key, escapeHtml(cat.name), chans.length)}${community.isOwner ? `<button type="button" class="cs-cat-add" data-cat-add="${escapeHtml(cat.id)}" title="Add a channel to ${escapeHtml(cat.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg></button>` : ''}</div>
        ${rows || (shut ? '' : `<div class="cs-empty cs-cat-empty" style="--i:${stagger++}">${community.isOwner ? 'Drag channels here' : 'Nothing here yet'}</div>`)}
      </div>`;
    }).join('');
  };
  const channelBlocks = beta ? catBlocks() : `${group('text', 'Text channels')}${group('voice', 'Voice channels')}`;
  const membersKey = `${community.id}:members`;
  const onlineN = members.filter((p) => csOnline.has(normVoiceId(p.uuid))).length;
  const memberHead = members.length ? foldHead(membersKey, `Members${onlineN ? ` · ${onlineN} online` : ''}`, members.length) : '';
  const sortedMembers = [...members].sort((a, b) => (csOnline.has(normVoiceId(b.uuid)) - csOnline.has(normVoiceId(a.uuid)))
    || ((b.uuid === community.ownerId) - (a.uuid === community.ownerId)) || String(a.name).localeCompare(String(b.name)));
  const memberRow = (p, i) => {
    const on = csOnline.has(normVoiceId(p.uuid));
    return `
      <div class="cs-invited cs-person ${on ? 'online' : 'away'}" data-uuid="${escapeHtml(p.uuid)}" data-name="${escapeHtml(p.name)}" style="--i:${i}">
        <span class="cs-person-face-wrap"><img class="cs-person-face" src="${frAvatar(p.uuid)}" alt="" ${personAttr(p.uuid, p.name)}><i class="cs-person-dot" data-tip="${on ? 'Online' : 'Offline'}"></i></span>
        <span class="cs-person-name" ${personAttr(p.uuid, p.name)}>${escapeHtml(csName(p.uuid, p.name))}${st.nick[normVoiceId(p.uuid)] ? `<em class="cs-real-name">${escapeHtml(p.name)}</em>` : ''}</span>
        ${csIgnored(p.uuid) ? '<span class="cs-person-ignored" title="You ignore their messages">Ignored</span>' : ''}
        ${p.uuid === community.ownerId ? '<span class="cs-person-owner" title="Owner">Owner</span>' : ''}
        ${reportFlag(p.uuid, p.name, { where: `Community: ${community.name}` })}
      </div>`;
  };
  // Beta: members live behind the Members button in the header, not in the channel column.
  const memBtn = document.getElementById('cs-members');
  const memPop = document.getElementById('cs-members-pop');
  if (memBtn) {
    const offN = members.length - onlineN;
    memBtn.innerHTML = `${VOICE_ICONS.people}<span><b>${members.length}</b> ${members.length === 1 ? 'member' : 'members'}</span><span class="cs-mem-on" data-tip="Online"><i></i>${onlineN}</span><span class="cs-mem-on off" data-tip="Offline"><i></i>${offN}</span>`;
    memBtn.title = `${members.length} ${members.length === 1 ? 'member' : 'members'}: ${onlineN} online, ${offN} offline`;
    memBtn.onclick = (e) => { e.stopPropagation(); csToggleMembers(); };
  }
  if (memPop && !memPop.classList.contains('hidden')) {
    const on = sortedMembers.filter((p) => csOnline.has(normVoiceId(p.uuid)));
    const off = sortedMembers.filter((p) => !csOnline.has(normVoiceId(p.uuid)));
    let i = 0;
    const section = (label, people, cls) => (people.length
      ? `<div class="cs-mem-group ${cls}"><i></i>${label}<em>${people.length}</em></div>${people.map((p) => memberRow(p, i++)).join('')}` : '');
    memPop.innerHTML = `
      <div class="cs-mem-head"><span class="cs-mem-title">Members <em>${members.length}</em></span><span class="cs-mem-sub"><i></i>${onlineN}<i class="off"></i>${members.length - onlineN}</span></div>
      <div class="cs-mem-list">${section('Online', on, 'on')}${section('Offline', off, 'off') || ''}${members.length ? '' : '<div class="cs-pop-empty">Nobody here yet.</div>'}</div>`;
  }
  list.innerHTML = `
    <span class="cs-ch-ind" aria-hidden="true"></span>
    ${canArrange ? '<span class="cs-drop-line" aria-hidden="true"></span>' : ''}
    ${channelBlocks}
    ${beta ? '' : `${memberHead}${st.collapsed[membersKey] ? '' : sortedMembers.map((p) => memberRow(p, stagger++)).join('')}`}
    <button type="button" class="cs-leave" id="cs-leave" style="--i:${stagger++}">${community.isOwner ? 'Delete community' : 'Leave community'}</button>
  `;
  const ind = list.querySelector('.cs-ch-ind');
  const activeRow = list.querySelector('.cs-ch.active');
  if (ind && activeRow) {
    const y = activeRow.offsetTop;
    const h = activeRow.offsetHeight;
    const from = csIndicator && csIndicator.community === community.id ? csIndicator : { y, h };
    ind.style.transition = 'none';
    ind.style.transform = `translateY(${from.y}px)`;
    ind.style.height = `${from.h}px`;
    ind.classList.add('on');
    void ind.offsetWidth;
    ind.style.transition = '';
    ind.style.transform = `translateY(${y}px)`;
    ind.style.height = `${h}px`;
    ind.classList.add('on');
    csIndicator = { community: community.id, y, h };
  }
  paintVoiceOccupants();
  const channelEdit = async (ch, act) => {
    try {
      if (act === 'rename') {
        const name = (await showPrompt('Rename channel', ch.kind === 'voice' ? 'Voice channel name' : 'Text channel name', ch.name) || '').trim();
        if (!name || name === ch.name) return;
        await window.nebula.communitiesRenameChannel({ id: community.id, channelId: ch.id, name });
      } else {
        const ok = await showConfirm(
          ch.kind === 'voice'
            ? `Delete the voice channel ${ch.name}? Anyone in it will be disconnected.`
            : `Delete #${ch.name} and all of its messages for everyone? This can't be undone.`,
          { title: 'Delete channel?', confirmLabel: 'Delete' });
        if (!ok) return;
        await window.nebula.communitiesDeleteChannel({ id: community.id, channelId: ch.id });
      }
    } catch (err) {
      showToast("Couldn't update channel", err?.message || String(err), 'error');
    }
  };
  list.querySelectorAll('.cs-ch').forEach((btn) => {
    btn.addEventListener('click', () => openCommunityStage(community.id, btn.dataset.ch));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ch = channels.find((x) => x.id === btn.dataset.ch);
      if (!ch) return;
      const k = msgKey(community.id, ch.id);
      const muted = csMuted(community, ch);
      scMenu(e.clientX, e.clientY, [
        ...(ch.kind === 'text' ? [['Mark as read', () => { csMarkRead(community, ch); renderCommunities(); renderCommunityStage(); }]] : []),
        [muted ? 'Unmute channel' : 'Mute channel', () => {
          if (muted) delete st.mute[k]; else st.mute[k] = true;
          csSave();
          renderCommunities();
          renderCommunityStage();
        }],
        ['Copy channel name', () => csCopy(ch.kind === 'text' ? `#${ch.name}` : ch.name)],
        ...(community.isOwner ? ['-', ['Rename channel', () => channelEdit(ch, 'rename')], ['Delete channel', () => channelEdit(ch, 'delete'), { danger: true }]] : []),
      ], { title: ch.kind === 'text' ? `#${ch.name}` : ch.name });
    });
  });
  list.querySelectorAll('.cs-ch-act').forEach((tool) => {
    tool.addEventListener('click', (e) => {
      e.stopPropagation();
      const ch = channels.find((x) => x.id === tool.closest('.cs-ch')?.dataset.ch);
      if (ch) channelEdit(ch, tool.dataset.act);
    });
  });
  list.querySelectorAll('.cs-kind[data-fold]').forEach((head) => {
    head.addEventListener('click', () => {
      const k = head.dataset.fold;
      if (st.collapsed[k]) delete st.collapsed[k]; else st.collapsed[k] = true;
      csSave();
      csIndicator = null;
      renderCommunityStage();
    });
  });
  [...list.querySelectorAll('.cs-person'), ...(memPop?.querySelectorAll('.cs-person') || [])].forEach((row) => {
    row.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.rflag')) return;
      e.preventDefault();
      e.stopPropagation();
      csPersonMenu({ uuid: row.dataset.uuid, name: row.dataset.name }, e.clientX, e.clientY);
    });
  });
  const addBar = document.getElementById('cs-addbar');
  const addInput = document.getElementById('cs-new-ch');
  let addKind = addBar?.dataset.kind || 'text';
  let addCat = addBar?.dataset.cat || '';
  const showAddBar = (kind, cat = '') => {
    addKind = kind;
    addCat = cat;
    if (addBar) {
      addBar.dataset.kind = kind;
      addBar.dataset.cat = cat;
      addBar.classList.remove('hidden');
    }
    if (addInput) {
      const where = beta && cat ? csLayout(community).cats.find((c) => c.id === cat)?.name : '';
      addInput.placeholder = `${kind === 'voice' ? 'Voice' : 'Text'} channel name${where ? ` in ${where}` : ''}`;
      addInput.focus();
    }
    document.getElementById('cs-invite-pop')?.classList.add('hidden');
  };
  const addCh = () => {
    const name = (addInput?.value || '').trim();
    if (!name) { addInput?.focus(); return; }
    const id = newRailId();
    const kind = addKind === 'voice' ? 'voice' : 'text';
    // Beta: a new channel lands at the end of the category it was added to.
    const L = beta ? csLayout(community) : null;
    const cat = L ? (addCat && L.cats.some((c) => c.id === addCat) ? addCat
      : L.custom ? (L.cats.find((c) => L.of.get(c.id).some((ch) => ch.kind === kind)) || L.cats[0])?.id || null : kind) : null;
    const needsLayout = L && (L.custom ? true : cat !== kind);
    window.nebula.communitiesAddChannel({ id: community.id, channel: { id, name, kind, ...(L?.custom && cat ? { cat } : {}) } })
      .then(() => {
        if (!needsLayout) return;
        const now = communityState.find((c) => c.id === community.id) || community;
        const lay = csLayoutIds(now);
        for (const ids of lay.groups.values()) { const at = ids.indexOf(id); if (at >= 0) ids.splice(at, 1); }
        lay.loose = lay.loose.filter((x) => x !== id);
        (lay.groups.get(cat) || lay.loose).push(id);
        csSaveLayout(now, lay.cats, lay.groups, lay.loose);
      })
      .catch((err) => showToast("Couldn't add channel", err?.message || String(err), 'error'));
    if (addInput) addInput.value = '';
    addBar?.classList.add('hidden');
    openChannelId = id;
  };
  // Beta: one Add button for text channels, voice channels and categories.
  const addBtn = document.getElementById('cs-add');
  if (addBtn) {
    addBtn.style.display = community.isOwner ? '' : 'none';
    addBtn.onclick = (e) => {
      e.stopPropagation();
      const r = scRect(addBtn);
      scMenu(r.left, r.bottom + 6, [
        ['Text channel', () => showAddBar('text')],
        ['Voice channel', () => showAddBar('voice')],
        '-',
        ['Category', () => csNewCategory(community)],
      ], { title: 'Add' });
    };
  }
  list.querySelectorAll('.cs-cat-add').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = scRect(b);
    const cat = b.dataset.catAdd;
    scMenu(r.left, r.bottom + 6, [
      ['Text channel', () => showAddBar('text', cat)],
      ['Voice channel', () => showAddBar('voice', cat)],
    ], { title: 'Add here' });
  }));
  if (canArrange) {
    list.querySelectorAll('.cs-cat-head .cs-kind').forEach((head) => head.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = head.closest('.cs-cat')?.dataset.cat;
      const cat = csLayout(community).cats.find((c) => c.id === id);
      if (!cat) return;
      scMenu(e.clientX, e.clientY, [
        ['Add text channel', () => showAddBar('text', id)],
        ['Add voice channel', () => showAddBar('voice', id)],
        '-',
        ['Rename category', () => csRenameCategory(community, id)],
        ['Delete category', () => csDeleteCategory(community, id), { danger: true }],
      ], { title: cat.name });
    }));
    csWireChannelDrag(list, community);
  }
  const addText = document.getElementById('cs-add-text');
  const addVoice = document.getElementById('cs-add-voice');
  const addGo = document.getElementById('cs-add-go');
  if (addText) addText.style.display = community.isOwner ? '' : 'none';
  if (addVoice) addVoice.style.display = community.isOwner ? '' : 'none';
  if (!community.isOwner) addBar?.classList.add('hidden');
  if (addText) addText.onclick = (e) => { e.stopPropagation(); showAddBar('text'); };
  if (addVoice) addVoice.onclick = (e) => { e.stopPropagation(); showAddBar('voice'); };
  if (addGo) addGo.onclick = (e) => { e.stopPropagation(); addCh(); };
  if (addInput) addInput.onkeydown = (e) => { if (e.key === 'Enter') addCh(); };
  const inviteBtn = document.getElementById('cs-invite');
  if (inviteBtn) inviteBtn.onclick = (e) => { e.stopPropagation(); openCommunityInvite(community); };
  list.querySelector('#cs-leave')?.addEventListener('click', async () => {
    const ok = community.isOwner
      ? await showConfirm(`Delete ${community.name} for everyone in it? This can't be undone.`,
        { title: 'Delete community?', confirmLabel: 'Delete' })
      : await showConfirm(`Leave ${community.name}? You'll need a new invite link to join again.`,
        { title: 'Leave community?', confirmLabel: 'Leave' });
    if (!ok) return;
    if (voiceSession && voiceSession.communityId === community.id) await leaveVoice();
    try { await window.nebula.communitiesLeave({ id: community.id }); } catch { /* the snapshot drops it anyway */ }
    communityState = communityState.filter((c) => c.id !== community.id);
    closeCommunityStage();
    renderCommunities();
  });

  const paintedKey = `${community.id}:${channel ? channel.id : ''}`;
  const switchedChannel = paintedKey !== csPaintedChannel;
  const prevBox = document.getElementById('cs-msgs');
  if (switchedChannel && prevBox && csPaintedChannel) {
    csScrollMem.set(csPaintedChannel, prevBox.scrollHeight - prevBox.scrollTop - prevBox.clientHeight < 80 ? null : prevBox.scrollTop);
  }
  csPaintedChannel = paintedKey;
  if (switchedChannel) {
    main.classList.remove('cs-swap');
    void main.offsetWidth;
    main.classList.add('cs-swap');
    clearTimeout(main._swapTimer);
    main._swapTimer = setTimeout(() => main.classList.remove('cs-swap'), 700);
  }

  if (!channel) {
    main.innerHTML = `
      <div class="cs-hello cs-hello-center">
        <div class="cs-hello-orb">#</div>
        <div class="cs-hello-title">An empty <em>community</em></div>
        <div class="cs-hello-sub">${community.isOwner ? 'Add a text or voice channel from the top bar to get started.' : 'The owner hasn\'t added any channels yet.'}</div>
      </div>`;
    return;
  }
  if (channel.kind === 'voice') {
    const here = voiceSession && voiceSession.communityId === community.id && voiceSession.channelId === channel.id;
    const voiceScroll = switchedChannel ? 0 : (main.querySelector('.cs-voice-scroll')?.scrollTop || 0);
    main.innerHTML = `
      <div class="cs-main-head">
        <span class="cs-main-glyph">${VOICE_ICONS.headphones}</span>
        <b class="cs-main-name">${escapeHtml(channel.name)}</b>
        <span class="cs-main-sub">Voice channel</span>
      </div>
      <div class="cs-voice-scroll">
      <div class="cs-voice ${here ? 'is-here' : ''}">
        <div class="cs-voice-orb" aria-hidden="true">${VOICE_ICONS.headphones}<i></i><i></i></div>
        <div class="cs-voice-title">${escapeHtml(channel.name)}</div>
        <div class="cs-voice-sub" id="cs-voice-sub">${here ? 'You joined this voice chat. Your microphone is on.' : 'Nobody is in this voice chat yet.'}</div>
        <div class="cs-voice-members" id="cs-voice-members"></div>
        <div class="cs-voice-actions">
          <button type="button" class="cs-join-btn ${here ? 'hidden' : ''}" id="cs-join">Join voice</button>
          <button type="button" class="vc-btn ${here ? '' : 'hidden'}" id="cs-mute" title="Mute">${VOICE_ICONS.mic}</button>
          <button type="button" class="vc-btn ${here ? '' : 'hidden'}" id="cs-deafen" title="Deafen">${VOICE_ICONS.headphones}</button>
          <button type="button" class="vc-btn vc-hang ${here ? '' : 'hidden'}" id="cs-hangup" title="Hang up">${VOICE_ICONS.hangup}</button>
        </div>
        <div class="cs-voice-controls">
          <div class="cs-vc-row"><span>Microphone</span><select id="cs-mic" class="cs-vc-select"></select></div>
          <label class="cs-vc-row"><span>Mic volume</span><input type="range" id="cs-mic-vol" min="0" max="200" step="5" data-unit="%"><b id="cs-mic-vol-val">100%</b></label>
          <label class="cs-nc-card" for="cs-nc">
            <span class="cs-nc-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10h2v4H3zm4-3h2v10H7zm4-4h2v18h-2zm4 4h2v10h-2zm4 3h2v4h-2z"/></svg></span>
            <span class="cs-nc-txt"><b>Noise cancellation</b><em id="cs-nc-sub">Removes keyboard, fans and background noise</em></span>
            <span class="toggle"><input type="checkbox" id="cs-nc"><span class="toggle-track"><span class="toggle-thumb"></span></span></span>
          </label>
          <div class="cs-mictest-row">
            <button type="button" class="cs-mictest-btn" id="cs-mictest"></button>
            <div class="cs-mictest-meter" aria-hidden="true"><i id="cs-mictest-level"></i></div>
          </div>
          <div class="cs-mictest-hint" id="cs-mictest-hint"></div>
          <div class="cs-vc-sep"></div>
          <div class="cs-vc-row"><span>Output</span><select id="cs-out" class="cs-vc-select"></select>
            <button type="button" class="cs-vc-test" id="cs-out-test" title="Play a short sound on the selected device">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>Test</button></div>
          <label class="cs-vc-row"><span>Output volume</span><input type="range" id="cs-out-vol" min="0" max="200" step="5" data-unit="%"><b id="cs-out-vol-val">100%</b></label>
        </div>
      </div>
      </div>
    `;
    const scroller = main.querySelector('.cs-voice-scroll');
    if (scroller) scroller.scrollTop = voiceScroll;
    bindVoiceControls(main);
    const members = document.getElementById('cs-voice-members');
    if (here) {
      window.nebula.currentAccount().then((me) => {
        if (members) members.dataset.name = me?.name || 'You';
        paintVoiceMembers();
      }).catch(() => paintVoiceMembers());
    }
    paintVoiceMembers();
    window.scMedia?.bindStage(main);
    main.querySelector('#cs-join')?.addEventListener('click', async () => {
      try { await joinVoice(community.id, channel.id); }
      catch (err) { showToast('Microphone', err?.message || 'Could not use the microphone.', 'error'); }
    });
    main.querySelector('#cs-hangup')?.addEventListener('click', () => leaveVoice());
    return;
  }

  const prefs = st.prefs;
  stage.classList.toggle('cs-compact', !!prefs.compact);
  stage.classList.toggle('cs-times-hover', !prefs.times);
  stage.classList.toggle('cs-size-s', prefs.size === 's');
  stage.classList.toggle('cs-size-l', prefs.size === 'l');
  const msgs = csMsgs(community, channel);
  const draftKey = msgKey(community.id, channel.id);
  const oldInput = document.getElementById('cs-input');
  const sameInput = !!oldInput && oldInput.dataset.key === draftKey;
  const draft = sameInput ? oldInput.value : (st.drafts[draftKey] || '');
  const caret = sameInput ? [oldInput.selectionStart, oldInput.selectionEnd] : null;
  const hadFocus = (!!oldInput && document.activeElement === oldInput) || (switchedChannel && !stage.classList.contains('hidden'));
  const oldSearch = document.getElementById('cs-search');
  const searchFocus = !!oldSearch && document.activeElement === oldSearch;
  const oldBox = document.getElementById('cs-msgs');
  const wasAtBottom = !oldBox || oldBox.scrollHeight - oldBox.scrollTop - oldBox.clientHeight < 80;
  const oldScroll = oldBox ? oldBox.scrollTop : 0;
  const me = myVoiceId();
  const myNm = myName();
  const q = (csSearch || '').trim().toLowerCase();
  const shown = q ? msgs.filter((m) => `${m.name || ''} ${m.text || ''}`.toLowerCase().includes(q)) : msgs;
  const owner = normVoiceId(community.ownerId || '');
  const introFrom = Math.max(0, shown.length - 10);
  let prev = null;
  let lastDay = '';
  let dividerDone = false;
  let newBelow = 0;
  const rows = shown.map((m, i) => {
    const mid = csMsgId(m);
    let out = '';
    const day = m.at ? csDayLabel(m.at) : '';
    if (day && day !== lastDay) {
      out += `<div class="cs-day"><span>${escapeHtml(day)}</span></div>`;
      lastDay = day;
      prev = null;
    }
    const mine = normVoiceId(m.from) === me;
    if (!q && !dividerDone && csUnreadFrom && (m.at || 0) > csUnreadFrom && !mine && !csIgnored(m.from)) {
      out += '<div class="cs-new-line"><span>New</span></div>';
      dividerDone = true;
      prev = null;
    }
    if (csIgnored(m.from) && !csShowIgnored.has(mid)) {
      prev = null;
      return `${out}<div class="cs-msg cs-ignored" data-mid="${escapeHtml(mid)}"><span>Message from someone you ignore</span><button type="button" data-t="unhide">Show</button></div>`;
    }
    const cont = !q && !!(prev && prev.from === m.from && m.at && prev.at && m.at - prev.at < 5 * 60 * 1000);
    let anim = '';
    if (switchedChannel) anim = i >= introFrom ? 'is-intro' : '';
    else if (!csSeenMsgIds.has(mid)) { anim = 'is-new'; if (!mine) newBelow++; }
    const delay = switchedChannel && i >= introFrom ? (i - introFrom) * 32 : 0;
    const reply = scParseReply(m.text);
    const body = reply ? reply.body : String(m.text || '');
    const mention = !mine && csMentionsMe(m);
    const big = SC_EMOJI_ONLY.test(body.trim());
    const saved = csIsSaved(community, channel.id, m);
    const flag = reportFlag(m.from, m.name, { where: `${community.name} #${channel.name}`, text: m.text, at: m.at });
    const full = m.at ? new Date(m.at).toLocaleString() : '';
    out += `
      <div class="cs-msg ${cont ? 'is-cont' : ''} ${mine ? 'is-mine' : ''} ${mention ? 'is-mention' : ''} ${anim}" data-mid="${escapeHtml(mid)}" style="--d:${delay}ms">
        ${cont
          ? `<span class="cs-msg-gutter" title="${escapeHtml(full)}">${m.at ? csClock(m.at) : ''}</span>`
          : `<img class="cs-msg-face" src="${frAvatar(m.from)}" alt="" ${personAttr(m.from, m.name)}>`}
        <div class="cs-msg-body">
          ${reply ? `<button type="button" class="cs-reply-chip" data-jump="${escapeHtml(reply.to)}" data-quote="${escapeHtml(reply.quote)}">${CS_ICON.reply}<b>@${escapeHtml(reply.to)}</b><span>${escapeHtml(reply.quote)}</span></button>` : ''}
          ${cont ? '' : `<div class="cs-msg-head"><b class="cs-msg-name" ${personAttr(m.from, m.name)}${st.nick[normVoiceId(m.from)] ? ` title="${escapeHtml(m.name || '')}"` : ''}>${escapeHtml(csName(m.from, m.name))}</b>${owner && normVoiceId(m.from) === owner ? '<span class="cs-msg-owner" title="Owns this community">Owner</span>' : ''}${m.at ? `<time class="cs-msg-time" title="${escapeHtml(full)}">${csClock(m.at)}</time>` : ''}${saved ? `<span class="cs-msg-saved" title="Saved">${CS_ICON.save}</span>` : ''}</div>`}
          <div class="cs-msg-text${big ? ' big' : ''}">${scRich(body, { me: myNm })}</div>
        </div>
        <div class="cs-mtools">
          <button type="button" data-t="reply" title="Reply">${CS_ICON.reply}</button>
          ${mine ? '' : `<button type="button" data-t="at" title="Mention">${CS_ICON.at}</button>`}
          <button type="button" data-t="copy" title="Copy text">${CS_ICON.copy}</button>
          <button type="button" data-t="save" class="${saved ? 'on' : ''}" title="${saved ? 'Remove from saved' : 'Save message'}">${CS_ICON.save}</button>
          ${flag}
          <button type="button" data-t="more" title="More">${CS_ICON.more}</button>
        </div>
      </div>`;
    prev = m;
    return out;
  }).join('');
  csSeenMsgIds = new Set(msgs.map(csMsgId));
  const savedN = st.saved.filter((s) => s.cid === community.id).length;
  const inboxN = readCommunities().reduce((n, c) => n + csCommunityUnread(c).at, 0);
  const replying = csReply && csReply.key === draftKey ? csReply : null;
  main.innerHTML = `
    <div class="cs-main-head">
      <span class="cs-main-glyph cs-main-hash">${betaLayoutOn() ? VOICE_ICONS.text : '#'}</span>
      <b class="cs-main-name">${escapeHtml(channel.name)}</b>
      <span class="cs-main-sub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 10.6 3.2 1.9-.9 1.5L11 13.5V7h2v5.6z"/></svg>
        Messages are deleted after 3 days
      </span>
      <div class="cs-head-tools">
        <button type="button" class="cs-htool ${csSearch != null ? 'on' : ''}" id="cs-search-btn" title="Search this channel (Ctrl+F)">${CS_ICON.search}</button>
        <button type="button" class="cs-htool" id="cs-inbox-btn" title="Mentions and alert words, every community">${CS_ICON.at}${inboxN ? `<em>${inboxN > 99 ? '99+' : inboxN}</em>` : ''}</button>
        <button type="button" class="cs-htool" id="cs-saved-btn" title="Saved messages">${CS_ICON.save}${savedN ? `<em>${savedN}</em>` : ''}</button>
        <button type="button" class="cs-htool" id="cs-more-btn" title="Channel options">${CS_ICON.more}</button>
        <button type="button" class="note-link cs-main-rules" data-open-rules>Rules</button>
      </div>
    </div>
    ${csSearch != null ? `<div class="cs-searchbar">
      ${CS_ICON.search}
      <input id="cs-search" maxlength="40" placeholder="Search #${escapeHtml(channel.name)}" autocomplete="off" spellcheck="false" value="${escapeHtml(csSearch)}">
      <span class="cs-search-n">${q ? (shown.length ? `${shown.length} found` : 'No matches') : ''}</span>
      <button type="button" class="cs-htool" id="cs-search-x" title="Close search (Esc)">&times;</button>
    </div>` : ''}
    <div class="cs-msgs" id="cs-msgs">${rows || (q ? `
      <div class="cs-hello cs-hello-center cs-hello-search">
        <div class="cs-hello-orb">${CS_ICON.search}</div>
        <div class="cs-hello-title">Nothing matches</div>
        <div class="cs-hello-sub">No message in #${escapeHtml(channel.name)} has "${escapeHtml(csSearch)}" in it.</div>
      </div>` : `
      <div class="cs-hello">
        <div class="cs-hello-orb">#</div>
        <div class="cs-hello-title">Welcome to <em>#${escapeHtml(channel.name)}</em></div>
        <div class="cs-hello-sub">This is the very start of the channel. Say hi and get it going.</div>
      </div>`)}</div>
    <button type="button" class="cs-jump hidden" id="cs-jump">${CS_ICON.down}<span id="cs-jump-n">Jump to latest</span></button>
    <form class="cs-compose" id="cs-compose">
      ${replying ? `<div class="cs-replybar">${CS_ICON.reply}<span>Replying to <b>${escapeHtml(replying.name)}</b><em>${escapeHtml(replying.text.slice(0, 90))}</em></span>
        <button type="button" class="cs-htool" id="cs-reply-x" title="Cancel reply (Esc)">&times;</button></div>` : ''}
      <div class="cs-compose-field" id="cs-compose-field">
        <button type="button" class="cs-cbtn cs-fmt-btn" id="cs-fmt-btn" title="Formatting">Aa</button>
        <input id="cs-input" maxlength="500" placeholder="Message #${escapeHtml(channel.name)}" autocomplete="off" spellcheck="true">
        <span class="cs-count" id="cs-count"></span>
        <button type="button" class="cs-cbtn" id="cs-emoji-btn" title="Emoji">${CS_ICON.emoji}</button>
        <button type="submit" class="cs-send" aria-label="Send" title="Send">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6l-.01 6.53L15 12 3.39 13.87z"/></svg>
        </button>
      </div>
    </form>
  `;
  const box = document.getElementById('cs-msgs');
  const jump = document.getElementById('cs-jump');
  const jumpN = document.getElementById('cs-jump-n');
  const atBottom = () => !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const visible = () => !stage.classList.contains('hidden') && !document.hidden;
  const paintJump = () => {
    if (!jump) return;
    jump.classList.toggle('hidden', atBottom());
    jumpN.textContent = csBelow ? `${csBelow} new ${csBelow === 1 ? 'message' : 'messages'}` : 'Jump to latest';
    jump.classList.toggle('has-new', csBelow > 0);
  };
  if (box) {
    if (q) box.scrollTop = 0;
    else if (switchedChannel) {
      const line = box.querySelector('.cs-new-line');
      const mem = csScrollMem.get(paintedKey);
      box.scrollTop = line && line.offsetTop > box.clientHeight * 0.6 ? line.offsetTop - 40 : (mem != null ? mem : box.scrollHeight);
    } else box.scrollTop = wasAtBottom ? box.scrollHeight : oldScroll;
    if (!switchedChannel && !wasAtBottom) csBelow += newBelow;
    if (atBottom()) csBelow = 0;
    paintJump();
    box.addEventListener('scroll', () => {
      if (atBottom()) {
        csBelow = 0;
        if (visible() && !q && csHoldRead !== draftKey && csMarkRead(community, channel)) renderCommunities();
      }
      paintJump();
    }, { passive: true });
  }
  jump?.addEventListener('click', () => {
    csBelow = 0;
    box?.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
  });
  if (visible() && atBottom() && !q && csHoldRead !== draftKey && csMarkRead(community, channel)) renderCommunities();

  const input = document.getElementById('cs-input');
  const field = document.getElementById('cs-compose-field');
  const count = document.getElementById('cs-count');
  const syncSend = () => {
    const v = input?.value || '';
    field?.classList.toggle('has-text', !!v.trim());
    if (count) {
      count.textContent = v.length >= 400 ? String(500 - v.length) : '';
      count.classList.toggle('warn', v.length >= 470);
    }
  };
  if (input) {
    input.dataset.key = draftKey;
    input.value = draft;
    if (hadFocus && !searchFocus) {
      input.focus({ preventScroll: true });
      if (caret) input.setSelectionRange(caret[0], caret[1]);
    }
    input.addEventListener('input', () => {
      syncSend();
      if (input.value) st.drafts[draftKey] = input.value; else delete st.drafts[draftKey];
      csSave();
    });
    syncSend();
    csMentionAuto?.destroy();
    csMentionAuto = scMentionAuto(input, () => members.map((p) => ({ uuid: p.uuid, name: p.name })).filter((p) => p.name !== myNm));
    const wrap = (mark) => {
      const a = input.selectionStart ?? 0;
      const b = input.selectionEnd ?? 0;
      const sel = input.value.slice(a, b);
      const next = input.value.slice(0, a) + mark + sel + mark + input.value.slice(b);
      if (next.length > 500) return;
      input.value = next;
      input.focus();
      input.setSelectionRange(a + mark.length, b + mark.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (csReply) { e.preventDefault(); csReply = null; renderCommunityStage(); return; }
        if (csSearch != null) { e.preventDefault(); csSearch = null; renderCommunityStage(); return; }
      }
      if (e.key === 'ArrowUp' && !input.value && st.sent[draftKey]) {
        e.preventDefault();
        input.value = st.sent[draftKey];
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); wrap('**'); }
        else if (k === 'i') { e.preventDefault(); wrap('*'); }
        else if (k === 'u') { e.preventDefault(); wrap('__'); }
      }
    });
    document.getElementById('cs-emoji-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      scEmojiPicker(e.currentTarget, (em) => scInsert(input, em));
    });
    document.getElementById('cs-fmt-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      const menu = scMenu(r.left, r.top, [
        ['Bold', () => wrap('**'), { hint: 'Ctrl+B' }],
        ['Italic', () => wrap('*'), { hint: 'Ctrl+I' }],
        ['Underline', () => wrap('__'), { hint: 'Ctrl+U' }],
        ['Strikethrough', () => wrap('~~')],
        ['Spoiler', () => wrap('||')],
        ['Code', () => wrap('`')],
      ], { title: 'Select text, then pick a style' });
      menu.style.top = `${Math.max(6, r.top - menu.offsetHeight - 6)}px`;
    });
  }
  document.getElementById('cs-reply-x')?.addEventListener('click', () => { csReply = null; renderCommunityStage(); input?.focus(); });
  const search = document.getElementById('cs-search');
  if (search) {
    if (searchFocus) {
      search.focus({ preventScroll: true });
      search.setSelectionRange(search.value.length, search.value.length);
    }
    search.addEventListener('input', () => { csSearch = search.value; renderCommunityStage(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); csSearch = null; renderCommunityStage(); input?.focus(); } });
  }
  document.getElementById('cs-search-x')?.addEventListener('click', () => { csSearch = null; renderCommunityStage(); });
  document.getElementById('cs-search-btn')?.addEventListener('click', () => {
    csSearch = csSearch == null ? '' : null;
    renderCommunityStage();
    document.getElementById('cs-search')?.focus();
  });
  document.getElementById('cs-saved-btn')?.addEventListener('click', (e) => { e.stopPropagation(); csSavedPanel(community, e.currentTarget); });
  document.getElementById('cs-inbox-btn')?.addEventListener('click', (e) => { e.stopPropagation(); csInboxPanel(e.currentTarget); });
  document.getElementById('cs-more-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const muted = csMuted(community, channel);
    const level = csNotifyLevel(community);
    const setPref = (k) => () => { prefs[k] = !prefs[k]; csSave(); renderCommunityStage(); };
    const setLevel = (v) => () => { st.notify[community.id] = v; csSave(); renderCommunities(); };
    scMenu(r.right - 230, r.bottom + 6, [
      ['Mark as read', () => { csMarkRead(community, channel); renderCommunities(); renderCommunityStage(); }],
      [muted ? 'Unmute this channel' : 'Mute this channel', () => {
        if (muted) delete st.mute[draftKey]; else st.mute[draftKey] = true;
        csSave();
        renderCommunities();
        renderCommunityStage();
      }],
      '-',
      ['Mark every community as read', () => csMarkAllRead(), { hint: 'Shift+Esc' }],
      '-',
      ['Compact messages', setPref('compact'), { check: true, on: !!prefs.compact }],
      ['Always show times', setPref('times'), { check: true, on: !!prefs.times }],
      ['Sound when mentioned', setPref('ping'), { check: true, on: !!prefs.ping }],
      ['Text size…', () => setTimeout(() => {
        const setSize = (v) => () => { prefs.size = v; csSave(); renderCommunityStage(); };
        scMenu(r.right - 230, r.bottom + 6, [
          ['Small', setSize('s'), { check: true, on: prefs.size === 's' }],
          ['Normal', setSize('m'), { check: true, on: prefs.size !== 's' && prefs.size !== 'l' }],
          ['Large', setSize('l'), { check: true, on: prefs.size === 'l' }],
        ], { title: 'Message text size' });
      }, 0)],
      [`Alert words${prefs.words.length ? ` (${prefs.words.length})` : ''}…`, () => csEditWords()],
      '-',
      ['Notify for every message', setLevel('all'), { check: true, on: level === 'all' }],
      ['Notify only for mentions', setLevel('mentions'), { check: true, on: level === 'mentions' }],
      ['Never notify', setLevel('none'), { check: true, on: level === 'none' }],
      '-',
      ['Save chat as a text file', () => csExport(community, channel)],
      ['Jump to a channel…', () => csQuickSwitch(), { hint: 'Ctrl+J' }],
    ], { title: `#${channel.name}` });
  });
  document.getElementById('cs-compose')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    let text = scShortcodes((input?.value || '').trim());
    if (!text) return;
    const sentReply = csReply && csReply.key === draftKey ? csReply : null;
    if (sentReply) text = scReplyText(sentReply.name, sentReply.text, text, 500);
    const typed = input.value;
    input.value = '';
    delete st.drafts[draftKey];
    st.sent[draftKey] = typed;
    csSave();
    syncSend();
    try {
      await window.nebula.communitiesSend({ id: community.id, channelId: channel.id, text });
      if (sentReply) { csReply = null; renderCommunityStage(); }
      csHoldRead = null;
      csMarkRead(community, channel);
    } catch (err) {
      if (!input.value) { input.value = typed; st.drafts[draftKey] = typed; csSave(); syncSend(); }
      showToast("Couldn't send", err?.message || String(err), 'error');
    }
  });
  if (q && box) csMarkHits(box, q);
}

document.getElementById('cs-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeCommunityStage();
});

const CS_ICON = {
  reply: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
  at: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 5 18.7l-1-1.7A8 8 0 1 1 20 12v1.4c0 .9-.7 1.6-1.5 1.6s-1.5-.7-1.5-1.6V12a5 5 0 1 0-1.5 3.6A3.5 3.5 0 0 0 22 13.4V12A10 10 0 0 0 12 2zm0 13a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3H7a2 2 0 0 0-2 2v16l7-3 7 3V5a2 2 0 0 0-2-2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16.5 5 9.5 6.4 8l5.6 5.6L17.6 8 19 9.5z"/></svg>',
  emoji: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm-3.5-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm7 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 17.5a5.5 5.5 0 0 0 5.1-3.5H6.9a5.5 5.5 0 0 0 5.1 3.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>',
};

// Who in the open community is on the launcher right now (beta).
let csOnline = new Set();
let csOnlineAt = 0;
let csOnlineTimer = null;
async function csRefreshOnline(force = false) {
  if (!betaLayoutOn()) return;
  if (!csOnlineTimer) {
    csOnlineTimer = setInterval(() => {
      if (!openCommunityId || document.hidden) return;
      csRefreshOnline(true);
    }, 30000);
  }
  if (!force && Date.now() - csOnlineAt < 30000) return;
  csOnlineAt = Date.now();
  try {
    const data = await window.nebula.onlineList();
    const next = new Set((data?.people || []).map((p) => normVoiceId(p.uuid)).filter(Boolean));
    const changed = next.size !== csOnline.size || [...next].some((u) => !csOnline.has(u));
    csOnline = next;
    if (changed && openCommunityId) renderCommunityStage();
  } catch { /* offline: keep the last list */ }
}

function csMarkHits(box, q) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.cs-msg-text, .cs-msg-name') && !n.parentElement.closest('mark')
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const hits = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(q)) hits.push(n);
  for (const n of hits) {
    const frag = document.createDocumentFragment();
    const s = n.nodeValue;
    const low = s.toLowerCase();
    let i = 0;
    for (let at = low.indexOf(q); at !== -1; at = low.indexOf(q, i)) {
      frag.append(s.slice(i, at));
      const mk = document.createElement('mark');
      mk.className = 'cs-hit';
      mk.textContent = s.slice(at, at + q.length);
      frag.append(mk);
      i = at + q.length;
    }
    frag.append(s.slice(i));
    n.replaceWith(frag);
  }
}

function csCurrent() {
  const c = readCommunities().find((x) => x.id === openCommunityId);
  const ch = c?.channels?.find((x) => x.id === openChannelId);
  return c && ch ? { c, ch } : null;
}

function csFlash(mid) {
  const box = document.getElementById('cs-msgs');
  const row = box && [...box.querySelectorAll('.cs-msg')].find((r) => r.dataset.mid === mid);
  if (!row) return false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
  setTimeout(() => row.classList.remove('flash'), 1600);
  return true;
}

function csJumpTo(cid, chid, mid) {
  const go = () => {
    if (!csFlash(mid)) showToast('Message gone', 'That message has expired. Community messages only last 3 days.', 'info');
  };
  if (openCommunityId === cid && openChannelId === chid) { csSearch = null; renderCommunityStage(); go(); return; }
  openCommunityStage(cid, chid);
  requestAnimationFrame(() => requestAnimationFrame(go));
}

function csSavedPanel(community, anchor) {
  const old = document.querySelector('.cs-saved');
  if (old) { old.remove(); if (old.dataset.for === community.id) return; }
  const st = csState();
  const pop = document.createElement('div');
  pop.className = 'cs-saved';
  pop.dataset.for = community.id;
  const paint = () => {
    const items = st.saved.filter((s) => s.cid === community.id).sort((a, b) => b.savedAt - a.savedAt);
    pop.innerHTML = `
      <div class="cs-saved-head"><b>Saved messages</b><span>${items.length || 'None yet'}</span></div>
      <div class="cs-saved-list">${items.length ? items.map((s) => {
        const r = scParseReply(s.text);
        return `<div class="cs-saved-item" data-id="${escapeHtml(s.id)}" data-ch="${escapeHtml(s.chid)}">
          <img src="${frAvatar(s.from)}" alt="">
          <div class="cs-saved-body">
            <div class="cs-saved-meta"><b>${escapeHtml(s.name || 'Someone')}</b><span>#${escapeHtml(s.chName || '')}</span><time>${s.at ? scAgo(s.at) : ''}</time></div>
            <div class="cs-saved-text">${scRich(r ? r.body : s.text, { me: myName() })}</div>
          </div>
          <div class="cs-saved-acts">
            <button type="button" data-a="jump" title="Jump to message">Jump</button>
            <button type="button" data-a="drop" title="Remove">${CS_ICON.trash}</button>
          </div>
        </div>`;
      }).join('') : `<div class="cs-saved-empty">${CS_ICON.save}<span>Hover a message and press the bookmark to keep it here. Saved messages stay on this PC.</span></div>`}</div>`;
  };
  paint();
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 8)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)))}px`;
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-a]');
    const item = e.target.closest('.cs-saved-item');
    if (!btn || !item) return;
    if (btn.dataset.a === 'drop') {
      st.saved = st.saved.filter((s) => !(s.cid === community.id && s.id === item.dataset.id));
      csSave();
      paint();
      renderCommunityStage();
    } else {
      pop.remove();
      csJumpTo(community.id, item.dataset.ch, item.dataset.id);
    }
  });
  const off = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    pop.remove();
    document.removeEventListener('mousedown', off, true);
  };
  document.addEventListener('mousedown', off, true);
}

function csMsgMenu(c, ch, m, x, y) {
  const reply = scParseReply(m.text);
  const body = reply ? reply.body : String(m.text || '');
  const mine = csIsMine(m);
  const saved = csIsSaved(c, ch.id, m);
  const input = document.getElementById('cs-input');
  scMenu(x, y, [
    ['Reply', () => csStartReply(c, ch, m)],
    ...(mine ? [] : [['Mention', () => { if (input) { scInsert(input, `@${m.name} `); } }]]),
    ['Copy text', () => csCopy(body, 'Message')],
    ['Quote', () => { if (input) scInsert(input, `> ${body.slice(0, 120)} `); }],
    [saved ? 'Remove from saved' : 'Save message', () => { csToggleSaved(c, ch, m); renderCommunityStage(); }],
    ...(mine ? [] : [['Mark unread from here', () => {
      const st = csState();
      const k = msgKey(c.id, ch.id);
      st.read[k] = Math.max(0, (m.at || Date.now()) - 1);
      csSave();
      csHoldRead = k;
      csUnreadFrom = st.read[k];
      renderCommunities();
      renderCommunityStage();
    }]]),
    '-',
    ...(mine ? [] : [
      ['View profile', () => openProfile({ uuid: m.from, name: m.name })],
      ['Set nickname…', () => csSetNick({ uuid: m.from, name: m.name })],
      [csIgnored(m.from) ? 'Stop ignoring' : 'Ignore in communities', () => csToggleIgnore({ uuid: m.from, name: m.name })],
      ['Player options…', () => showPeopleMenu({ uuid: m.from, name: m.name }, x, y)],
      ['Report message', () => openReport({ uuid: m.from, name: m.name, context: { where: `${c.name} #${ch.name}`, text: m.text, at: m.at } }), { danger: true }],
    ]),
    ...(m.at ? [['Copy time', () => csCopy(new Date(m.at).toLocaleString(), 'Time'), { hint: csClock(m.at) }]] : []),
  ], { title: m.name || 'Message' });
}

function csPersonMenu(p, x, y) {
  const st = csState();
  const mine = normVoiceId(p.uuid) === myVoiceId();
  const input = document.getElementById('cs-input');
  const nick = st.nick[normVoiceId(p.uuid)];
  scMenu(x, y, [
    ['View profile', () => openProfile({ uuid: p.uuid, name: p.name })],
    ...(mine ? [] : [
      ...(input ? [['Mention', () => scInsert(input, `@${p.name} `)]] : []),
      ['Set nickname…', () => csSetNick(p)],
      ...(nick ? [['Clear nickname', () => { delete st.nick[normVoiceId(p.uuid)]; csSave(); renderCommunityStage(); }]] : []),
      [csIgnored(p.uuid) ? 'Stop ignoring' : 'Ignore in communities', () => csToggleIgnore(p)],
      '-',
      ['Player options…', () => showPeopleMenu({ uuid: p.uuid, name: p.name }, x, y)],
    ]),
    ['Copy name', () => csCopy(p.name, 'Name')],
  ], { title: nick ? `${nick} (${p.name})` : p.name });
}

async function csSetNick(p) {
  const st = csState();
  const id = normVoiceId(p.uuid);
  const v = await showPrompt(`Nickname for ${p.name}. Only you see it.`, p.name, st.nick[id] || '', { allowEmpty: true });
  if (v == null) return;
  if (v) st.nick[id] = v.replace(/\s+/g, ' ').slice(0, 32); else delete st.nick[id];
  csSave();
  renderCommunityStage();
}

function csToggleIgnore(p) {
  const st = csState();
  const id = normVoiceId(p.uuid);
  if (st.ignore[id]) {
    delete st.ignore[id];
    showToast(`Not ignoring ${escapeHtml(p.name)}`, 'Their community messages show normally again.', 'info');
  } else {
    st.ignore[id] = true;
    showToast(`Ignoring ${escapeHtml(p.name)}`, 'Their community messages are folded away and never ping you. Only you see this.', 'info');
  }
  csSave();
  renderCommunities();
  renderCommunityStage();
}

async function csEditWords() {
  const st = csState();
  const v = await showPrompt('Alert words: ping me when someone says…', 'smp, raid, diamonds', st.prefs.words.join(', '), { allowEmpty: true });
  if (v == null) return;
  st.prefs.words = [...new Set(v.split(',').map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2))].slice(0, 20).map((w) => w.slice(0, 24));
  csSave();
  renderCommunities();
  renderCommunityStage();
  showToast(st.prefs.words.length ? 'Alert words saved' : 'Alert words cleared',
    st.prefs.words.length ? escapeHtml(st.prefs.words.join(', ')) : '', 'success');
}

function csExport(c, ch) {
  const ms = csMsgs(c, ch);
  if (!ms.length) { showToast('Nothing to save', `#${escapeHtml(ch.name)} has no messages right now.`, 'info'); return; }
  const lines = ms.map((m) => `[${m.at ? new Date(m.at).toLocaleString() : ''}] ${m.name || 'Someone'}: ${String(m.text || '').replace(/\r?\n/g, '\n    ')}`);
  const text = `${c.name} #${ch.name} - saved ${new Date().toLocaleString()}\nCommunity messages only last 3 days.\n\n${lines.join('\n')}\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${c.name} - ${ch.name}.txt`.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/** Everything that mentioned you (or hit an alert word), across every community. */
function csInboxPanel(anchor) {
  const old = document.querySelector('.cs-inbox');
  if (old) { old.remove(); return; }
  const items = [];
  for (const c of readCommunities()) {
    for (const ch of c.channels || []) {
      if (ch.kind !== 'text') continue;
      const read = csReadAt(c, ch);
      for (const m of csMsgs(c, ch)) if (!csIsMine(m) && csMentionsMe(m)) items.push({ c, ch, m, unread: (m.at || 0) > read });
    }
  }
  items.sort((a, b) => (b.m.at || 0) - (a.m.at || 0));
  const fresh = items.filter((it) => it.unread).length;
  const pop = document.createElement('div');
  pop.className = 'cs-saved cs-inbox';
  pop.innerHTML = `
    <div class="cs-saved-head"><b>Mentions</b><span>${items.length ? (fresh ? `${fresh} new` : 'All read') : 'None yet'}</span></div>
    <div class="cs-saved-list">${items.length ? items.slice(0, 60).map((it, i) => {
      const r = scParseReply(it.m.text);
      return `<div class="cs-saved-item${it.unread ? ' unread' : ''}" data-i="${i}">
        <img src="${frAvatar(it.m.from)}" alt="">
        <div class="cs-saved-body">
          <div class="cs-saved-meta"><b>${escapeHtml(csName(it.m.from, it.m.name))}</b><span>${escapeHtml(it.c.name)} · #${escapeHtml(it.ch.name)}</span><time>${it.m.at ? scAgo(it.m.at) : ''}</time></div>
          <div class="cs-saved-text">${scRich(r ? r.body : String(it.m.text || ''), { me: myName() })}</div>
        </div>
        <div class="cs-saved-acts"><button type="button" data-a="jump">Jump</button></div>
      </div>`;
    }).join('') : `<div class="cs-saved-empty">${CS_ICON.at}<span>When someone @mentions you, replies to you or says one of your alert words, it lands here.</span></div>`}</div>`;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom + 8)}px`;
  pop.style.left = `${Math.round(Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8)))}px`;
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = e.target.closest('.cs-saved-item');
    const it = row && items[Number(row.dataset.i)];
    if (!it) return;
    pop.remove();
    csJumpTo(it.c.id, it.ch.id, csMsgId(it.m));
  });
  const off = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    pop.remove();
    document.removeEventListener('mousedown', off, true);
  };
  document.addEventListener('mousedown', off, true);
}

/** Ctrl+J: type part of a channel or community name and go there. */
function csQuickSwitch() {
  if (!betaLayoutOn()) return;
  const old = document.querySelector('.cs-qs');
  if (old) { old.remove(); return; }
  const all = [];
  for (const c of readCommunities()) for (const ch of c.channels || []) all.push({ c, ch });
  const wrap = document.createElement('div');
  wrap.className = 'cs-qs';
  wrap.innerHTML = `<div class="cs-qs-card" role="dialog" aria-label="Jump to a channel">
    <input class="cs-qs-in" placeholder="${all.length ? 'Jump to a channel or community' : 'Join or make a community first'}" maxlength="40" spellcheck="false" autocomplete="off">
    <div class="cs-qs-list"></div>
    <div class="cs-qs-foot"><span><kbd>↑</kbd><kbd>↓</kbd> pick</span><span><kbd>Enter</kbd> go</span><span><kbd>Esc</kbd> close</span></div>
  </div>`;
  document.body.appendChild(wrap);
  const input = wrap.querySelector('.cs-qs-in');
  const listEl = wrap.querySelector('.cs-qs-list');
  let sel = 0;
  let hits = [];
  const score = (it, q) => {
    if (!q) return 1;
    const n = it.ch.name.toLowerCase(), cn = it.c.name.toLowerCase();
    if (n.startsWith(q)) return 5;
    if (n.includes(q)) return 4;
    if (cn.startsWith(q)) return 3;
    if (cn.includes(q)) return 2;
    return `${cn} ${n}`.includes(q) ? 1 : 0;
  };
  const isHere = (it) => it.c.id === openCommunityId && it.ch.id === openChannelId;
  const paint = () => {
    const q = input.value.trim().toLowerCase().replace(/^#/, '');
    hits = all.map((it) => ({ it, s: score(it, q), u: csUnread(it.c, it.ch) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => (b.s - a.s) || (b.u.at - a.u.at) || ((b.u.n > 0) - (a.u.n > 0)) || (isHere(a.it) - isHere(b.it)))
      .slice(0, 12);
    sel = Math.max(0, Math.min(sel, hits.length - 1));
    listEl.innerHTML = hits.length ? hits.map(({ it, u }, i) => `<button type="button" class="cs-qs-row${i === sel ? ' sel' : ''}${isHere(it) ? ' here' : ''}" data-i="${i}">
      <span class="cs-qs-glyph">${it.ch.kind === 'voice' ? VOICE_ICONS.headphones : '#'}</span><b>${escapeHtml(it.ch.name)}</b><em>${escapeHtml(it.c.name)}</em>
      ${u.at ? `<i class="cs-qs-badge">${u.at > 9 ? '9+' : u.at}</i>` : u.n && !csMuted(it.c, it.ch) ? '<i class="cs-qs-dot"></i>' : ''}</button>`).join('')
      : `<div class="cs-qs-none">${all.length ? 'Nothing called that' : 'No communities yet'}</div>`;
  };
  const close = () => wrap.remove();
  const go = (i) => {
    const h = hits[i];
    if (!h) return;
    close();
    openCommunityStage(h.it.c.id, h.it.ch.id);
  };
  const pickRow = (i) => {
    sel = i;
    listEl.querySelectorAll('.cs-qs-row').forEach((b) => b.classList.toggle('sel', Number(b.dataset.i) === sel));
    listEl.querySelector('.cs-qs-row.sel')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; paint(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) pickRow((sel + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === 'Enter') { e.preventDefault(); go(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  listEl.addEventListener('mousemove', (e) => {
    const b = e.target.closest('[data-i]');
    if (b && Number(b.dataset.i) !== sel) pickRow(Number(b.dataset.i));
  });
  listEl.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) go(Number(b.dataset.i)); });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  paint();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  if (!betaLayoutOn() || document.body.classList.contains('is-banned')) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    csQuickSwitch();
  } else if (e.key === 'Escape' && e.shiftKey && !e.ctrlKey && !e.altKey && readCommunities().length) {
    e.preventDefault();
    csMarkAllRead();
  }
});

function csStartReply(c, ch, m) {
  const reply = scParseReply(m.text);
  csReply = { key: msgKey(c.id, ch.id), name: m.name || 'Someone', text: (reply ? reply.body : String(m.text || '')).replace(/\s+/g, ' ').trim() };
  renderCommunityStage();
  document.getElementById('cs-input')?.focus();
}

(function wireCsMain() {
  const main = document.getElementById('cs-main');
  if (!main) return;
  const msgOf = (el) => {
    const row = el.closest('.cs-msg');
    const cur = csCurrent();
    if (!row || !cur) return null;
    const m = csMsgs(cur.c, cur.ch).find((x) => csMsgId(x) === row.dataset.mid);
    return m ? { ...cur, m, row } : null;
  };
  main.addEventListener('click', (e) => {
    const chip = e.target.closest('.cs-reply-chip');
    if (chip) {
      e.stopPropagation();
      const cur = csCurrent();
      if (!cur) return;
      const quote = (chip.dataset.quote || '').replace(/…$/, '').trim().toLowerCase();
      const to = (chip.dataset.jump || '').toLowerCase();
      const row = chip.closest('.cs-msg');
      const msgs = csMsgs(cur.c, cur.ch);
      const before = msgs.slice(0, Math.max(0, msgs.findIndex((x) => csMsgId(x) === row?.dataset.mid)));
      const hit = [...before].reverse().find((x) => (x.name || '').toLowerCase() === to
        && (!quote || (scParseReply(x.text)?.body || x.text || '').replace(/\s+/g, ' ').toLowerCase().startsWith(quote.slice(0, 40))));
      if (!hit || !csFlash(csMsgId(hit))) showToast('Not found', "The original message isn't here anymore.", 'info');
      return;
    }
    const btn = e.target.closest('.cs-mtools button[data-t], .cs-ignored button[data-t]');
    if (!btn) return;
    const hit = msgOf(btn);
    if (!hit) return;
    e.stopPropagation();
    const { c, ch, m } = hit;
    const input = document.getElementById('cs-input');
    switch (btn.dataset.t) {
      case 'reply': csStartReply(c, ch, m); break;
      case 'at': if (input) scInsert(input, `@${m.name} `); break;
      case 'copy': csCopy(scParseReply(m.text)?.body ?? String(m.text || ''), 'Message'); break;
      case 'save': csToggleSaved(c, ch, m); renderCommunityStage(); break;
      case 'unhide': csShowIgnored.add(csMsgId(m)); renderCommunityStage(); break;
      case 'more': { const r = btn.getBoundingClientRect(); csMsgMenu(c, ch, m, r.left - 190, r.bottom + 4); break; }
      default: break;
    }
  });
  main.addEventListener('contextmenu', (e) => {
    if (!betaLayoutOn() || e.target.closest('a, input, textarea, .cs-msg-name, .cs-msg-face')) return;
    const hit = msgOf(e.target);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    csMsgMenu(hit.c, hit.ch, hit.m, e.clientX, e.clientY);
  });
  main.addEventListener('dblclick', (e) => {
    if (!betaLayoutOn() || e.target.closest('a, button, input, .cs-msg-text')) return;
    const hit = msgOf(e.target);
    if (hit) csStartReply(hit.c, hit.ch, hit.m);
  });
})();

// Alt+Up/Down: previous/next channel. Alt+Shift+Up/Down: next unread. Ctrl+F: search.
document.addEventListener('keydown', (e) => {
  if (!betaLayoutOn() || !openCommunityId) return;
  const stage = document.getElementById('community-stage');
  if (!stage || stage.classList.contains('hidden')) return;
  if (document.querySelector('.modal-overlay:not(.hidden), #mod-modal:not(.hidden)')) return;
  const c = readCommunities().find((x) => x.id === openCommunityId);
  if (!c) return;
  if (e.altKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const order = [...document.querySelectorAll('#cs-channels .cs-ch[data-ch]')].map((b) => b.dataset.ch);
    const chans = order.map((id) => c.channels.find((x) => x.id === id)).filter(Boolean);
    if (!chans.length) return;
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    let i = chans.findIndex((x) => x.id === openChannelId);
    for (let n = 0; n < chans.length; n++) {
      i = (i + dir + chans.length) % chans.length;
      if (!e.shiftKey || (chans[i].kind === 'text' && csUnread(c, chans[i]).n)) { openCommunityStage(c.id, chans[i].id); return; }
    }
    if (e.shiftKey) showToast('All caught up', 'No unread channels here.', 'info');
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
    const ch = c.channels?.find((x) => x.id === openChannelId);
    if (ch?.kind !== 'text') return;
    e.preventDefault();
    if (csSearch == null) { csSearch = ''; renderCommunityStage(); }
    const s = document.getElementById('cs-search');
    s?.focus();
    s?.select();
  }
});

// Toasts for new community messages (beta). Respects mutes and notify levels.
function csNotifyNew(prev, next) {
  const me = myVoiceId();
  const st = csState();
  const stage = document.getElementById('community-stage');
  let shown = 0;
  let ping = false;
  for (const c of next) {
    const old = prev.find((p) => p.id === c.id);
    if (!old) continue;
    const level = csNotifyLevel(c);
    if (level === 'none') continue;
    for (const ch of c.channels || []) {
      if (ch.kind !== 'text') continue;
      const viewing = openCommunityId === c.id && openChannelId === ch.id && !document.hidden && !stage?.classList.contains('hidden');
      if (viewing) continue;
      const had = new Set((old.messages?.[ch.id] || []).map(csMsgId));
      const muted = csMuted(c, ch);
      for (const m of csMsgs(c, ch)) {
        if (had.has(csMsgId(m)) || normVoiceId(m.from) === me || csIgnored(m.from)) continue;
        if (m.at && Date.now() - m.at > 2 * 60 * 1000) continue;
        const mention = csMentionsMe(m);
        if (!mention && (level !== 'all' || muted)) continue;
        if (mention) ping = true;
        if (shown >= 3) continue;
        shown++;
        const r = scParseReply(m.text);
        const body = (r ? r.body : String(m.text || '')).replace(/\s+/g, ' ').slice(0, 140);
        const el = showToast(
          `${escapeHtml(csName(m.from, m.name))}${mention ? ' mentioned you' : ''} <span class="cs-toast-where">${escapeHtml(c.name)} · #${escapeHtml(ch.name)}</span>`,
          escapeHtml(body), 'info');
        if (el) {
          el.classList.add('cs-toast');
          el.addEventListener('click', () => openCommunityStage(c.id, ch.id));
        }
      }
    }
  }
  if (ping && st.prefs.ping) scPing();
}

/**
 * Beta: a community's categories and the channels in each, in order. Until the
 * owner customizes it, there are two built-in categories split by channel kind.
 */
function csLayout(community) {
  const channels = community.channels || [];
  const custom = Array.isArray(community.categories) && community.categories.length > 0;
  const cats = custom
    ? community.categories.map((c) => ({ id: String(c.id), name: String(c.name || 'Category') }))
    : [{ id: 'text', name: 'Text channels' }, { id: 'voice', name: 'Voice channels' }];
  const of = new Map(cats.map((c) => [c.id, []]));
  const loose = [];
  for (const ch of channels) {
    const k = custom ? ch.cat : ch.kind === 'voice' ? 'voice' : 'text';
    if (k != null && of.has(k)) of.get(k).push(ch); else loose.push(ch);
  }
  return { custom, cats, of, loose };
}

/** groups: category id -> channel ids in order. Shows the change right away, then tells the server. */
function csSaveLayout(community, cats, groups, loose = []) {
  const order = [
    ...loose.map((id) => ({ id, cat: null })),
    ...cats.flatMap((c) => (groups.get(c.id) || []).map((id) => ({ id, cat: c.id }))),
  ];
  const live = communityState.find((c) => c.id === community.id);
  if (live) {
    const byId = new Map((live.channels || []).map((ch) => [ch.id, ch]));
    const next = order.map((o) => byId.has(o.id) && { ...byId.get(o.id), cat: o.cat }).filter(Boolean);
    for (const ch of live.channels || []) if (!order.some((o) => o.id === ch.id)) next.push(ch);
    live.categories = cats.map(({ id, name }) => ({ id, name }));
    live.channels = next;
  }
  renderCommunityStage();
  Promise.resolve(window.nebula.communitiesSetLayout?.({ id: community.id, categories: cats, order }))
    .catch((err) => showToast("Couldn't save the layout", err?.message || String(err), 'error'));
}

/** The current layout as plain ids, ready to edit and pass to csSaveLayout. */
function csLayoutIds(community) {
  const L = csLayout(community);
  return {
    cats: L.cats.map((c) => ({ ...c })),
    groups: new Map(L.cats.map((c) => [c.id, L.of.get(c.id).map((ch) => ch.id)])),
    loose: L.loose.map((ch) => ch.id),
  };
}

async function csNewCategory(community) {
  const name = (await showPrompt('New category', 'Category name', '') || '').trim().slice(0, 32);
  if (!name) return;
  const now = communityState.find((c) => c.id === community.id) || community;
  const lay = csLayoutIds(now);
  const id = newRailId();
  lay.cats.push({ id, name });
  lay.groups.set(id, []);
  csSaveLayout(now, lay.cats, lay.groups, lay.loose);
}

async function csRenameCategory(community, catId) {
  const now = communityState.find((c) => c.id === community.id) || community;
  const lay = csLayoutIds(now);
  const cat = lay.cats.find((c) => c.id === catId);
  if (!cat) return;
  const name = (await showPrompt('Rename category', 'Category name', cat.name) || '').trim().slice(0, 32);
  if (!name || name === cat.name) return;
  cat.name = name;
  csSaveLayout(now, lay.cats, lay.groups, lay.loose);
}

async function csDeleteCategory(community, catId) {
  const now = communityState.find((c) => c.id === community.id) || community;
  const lay = csLayoutIds(now);
  const cat = lay.cats.find((c) => c.id === catId);
  if (!cat) return;
  const moved = lay.groups.get(catId) || [];
  const ok = await showConfirm(
    moved.length ? `Delete the ${cat.name} category? Its ${moved.length === 1 ? 'channel moves' : `${moved.length} channels move`} to the top of the list.` : `Delete the ${cat.name} category?`,
    { title: 'Delete category?', confirmLabel: 'Delete' });
  if (!ok) return;
  lay.cats = lay.cats.filter((c) => c.id !== catId);
  lay.groups.delete(catId);
  lay.loose.push(...moved);
  csSaveLayout(now, lay.cats, lay.groups, lay.loose);
}

/** Owner, beta: drag a channel onto another channel (above or below it) or onto a category. */
function csWireChannelDrag(list, community) {
  const line = list.querySelector('.cs-drop-line');
  let target = null;   // { cat, before: channel id or null for the end }
  const clear = () => {
    line?.classList.remove('on');
    list.querySelectorAll('.cs-cat.drop-into').forEach((n) => n.classList.remove('drop-into'));
    target = null;
  };
  list.querySelectorAll('.cs-ch[draggable]').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      csDragId = row.dataset.ch;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.querySelector('.cs-ch-name')?.textContent || '');
      requestAnimationFrame(() => row.classList.add('drag-src'));
      list.classList.add('cs-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('drag-src');
      list.classList.remove('cs-dragging');
      clear();
      csDragId = null;
      renderCommunityStage();
    });
  });
  list.addEventListener('dragover', (e) => {
    if (!csDragId) return;
    const block = e.target.closest('.cs-cat');
    if (!block) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const lr = list.getBoundingClientRect();
    const rows = [...block.querySelectorAll('.cs-ch')].filter((r) => r.dataset.ch !== csDragId);
    let before = null, y;
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      if (e.clientY < b.top + b.height / 2) { before = r.dataset.ch; y = b.top - 2; break; }
      y = b.bottom + 1;
    }
    if (y == null) { const h = block.querySelector('.cs-cat-head, .cs-empty') || block; y = h.getBoundingClientRect().bottom + 1; }
    target = { cat: block.dataset.cat, before };
    list.querySelectorAll('.cs-cat.drop-into').forEach((n) => n !== block && n.classList.remove('drop-into'));
    block.classList.add('drop-into');
    if (line) {
      line.style.transform = `translateY(${Math.round(y - lr.top + list.scrollTop)}px)`;
      line.classList.add('on');
    }
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) clear(); });
  list.addEventListener('drop', (e) => {
    if (!csDragId || !target) return;
    e.preventDefault();
    const now = communityState.find((c) => c.id === community.id) || community;
    const lay = csLayoutIds(now);
    for (const ids of [...lay.groups.values(), lay.loose]) { const at = ids.indexOf(csDragId); if (at >= 0) ids.splice(at, 1); }
    const into = target.cat ? lay.groups.get(target.cat) : lay.loose;
    if (!into) return;
    const at = target.before ? into.indexOf(target.before) : -1;
    into.splice(at < 0 ? into.length : at, 0, csDragId);
    clear();
    csDragId = null;
    csIndicator = null;
    csSaveLayout(now, lay.cats, lay.groups, lay.loose);
  });
}

/** Beta: the member list drops down from the Members button and stays out of the way otherwise. */
function csToggleMembers(open) {
  const pop = document.getElementById('cs-members-pop');
  const btn = document.getElementById('cs-members');
  if (!pop || !btn) return;
  const show = open ?? pop.classList.contains('hidden');
  btn.classList.toggle('on', show);
  if (!show) { pop.classList.add('hidden'); return; }
  document.getElementById('cs-invite-pop')?.classList.add('hidden');
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const s = (pop.offsetParent || document.body).getBoundingClientRect();
  pop.style.top = `${Math.round(r.bottom - s.top + 8)}px`;
  pop.style.left = `${Math.round(Math.max(8, r.right - pop.offsetWidth) - s.left)}px`;
  pop.classList.add('fresh');
  clearTimeout(pop._fresh);
  pop._fresh = setTimeout(() => pop.classList.remove('fresh'), 700);
  renderCommunityStage();
}
document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('cs-members-pop');
  if (!pop || pop.classList.contains('hidden')) return;
  if (pop.contains(e.target) || e.target.closest('#cs-members, .sc-menu, .people-menu, .confirm-modal, .modal-scrim, .pf-overlay')) return;
  csToggleMembers(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('cs-members-pop')?.classList.contains('hidden')) csToggleMembers(false);
});
window.addEventListener('resize', () => csToggleMembers(false));

async function openCommunityInvite(community) {
  const pop = document.getElementById('cs-invite-pop');
  if (!pop || !community) return;
  csToggleMembers(false);
  if (!pop.classList.contains('hidden') && pop.dataset.for === community.id) {
    pop.classList.add('hidden');
    return;
  }
  document.getElementById('cs-addbar')?.classList.add('hidden');
  pop.dataset.for = community.id;
  pop.classList.remove('hidden');
  const link = communityInviteLink(community);
  pop.innerHTML = `
    <div class="cs-pop-head">
      <div class="cs-pop-title">Invite</div>
      <button type="button" class="cs-x" id="cs-invite-x" title="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
    </div>
    <div class="cs-link-row">
      <input class="cs-link" readonly value="${escapeHtml(link)}">
      <button type="button" class="cs-tool" id="cs-copy-link">Copy link</button>
    </div>
    <div class="cs-pop-title">Friends</div>
    <div class="cs-pop-empty" id="cs-friend-slot">Loading…</div>
  `;
  pop.querySelector('#cs-invite-x').addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.add('hidden');
  });
  if (!link) {
    pop.querySelector('.cs-link').value = 'Connect to SolarClient online to get a link';
    pop.querySelector('#cs-copy-link').disabled = true;
  }
  pop.querySelector('#cs-copy-link').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Link copied', 'Invite link is on your clipboard.', 'success');
    } catch (err) {
      showToast('Copy failed', err?.message || 'Could not copy that link.', 'error');
    }
  });
  let friends = [];
  try {
    const snap = await window.nebula.friendsSnapshot();
    friends = Array.isArray(snap?.friends) ? snap.friends : [];
  } catch { friends = []; }
  const slot = pop.querySelector('#cs-friend-slot');
  if (!slot || pop.dataset.for !== community.id) return;
  if (!friends.length) {
    slot.textContent = 'No friends to invite yet.';
    return;
  }
  slot.outerHTML = friends.map((p) => `
    <button type="button" class="cs-invite-row" data-uuid="${escapeHtml(p.uuid)}">
      <img src="${avatarUrl(p.uuid)}" alt="" onerror="this.src='${avatarUrlFallback(p.uuid)}'">
      <span>${escapeHtml(p.name)}</span>
    </button>`).join('');
  pop.querySelectorAll('.cs-invite-row').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const person = friends.find((p) => p.uuid === btn.dataset.uuid);
      if (!person) return;
      if (!link) { showToast('Not connected', 'Connect to SolarClient online to send invites.', 'error'); return; }
      try {
        await window.nebula.friendsSendDm({
          uuid: person.uuid,
          text: `You're invited to ${community.name}. ${link}`,
        });
        pop.classList.add('hidden');
        showToast('Invite sent', `${person.name} got the link to ${community.name}.`, 'success');
      } catch (err) {
        showToast('Invite failed', err?.message || 'Could not send that invite.', 'error');
      }
    });
  });
}

function openCommunityCreate() {
  const plus = document.getElementById('community-add');
  if (!plus) return;
  if (document.querySelector('.rail-sheet .community-name')) { closeRailSheets(); return; }
  mountRailSheet(plus, (body) => {
    body.innerHTML = `
      <div class="rail-sheet-user">New community</div>
      <div class="rail-sheet-sub">Text and voice channels can be added after you create it.</div>
      <input class="community-name" maxlength="32" placeholder="Community name">
      <div class="community-actions">
        <button type="button" class="pill-btn primary" data-act="create">Create</button>
      </div>
    `;
    const input = body.querySelector('.community-name');
    const createBtn = body.querySelector('[data-act="create"]');
    const create = async () => {
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (createBtn.disabled) return;
      createBtn.disabled = true;
      const id = newRailId();
      const r = await window.nebula.communitiesCreate({
        id,
        name,
        channels: [
          { id: newRailId(), name: 'general', kind: 'text' },
          { id: newRailId(), name: 'Lobby', kind: 'voice' },
        ],
      });
      createBtn.disabled = false;
      if (!r?.ok) { showToast("Couldn't create community", r?.reason || 'Try again.', 'error'); return; }
      if (r.community && !communityState.some((c) => c.id === id)) communityState = [...communityState, { ...r.community, isOwner: true }];
      closeRailSheets();
      renderCommunities();
      openCommunityStage(id);
    };
    body.querySelector('[data-act="create"]').addEventListener('click', (e) => { e.stopPropagation(); create(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    input.focus();
  });
}

document.getElementById('community-add')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!betaLayoutOn()) return;
  openCommunityCreate();
});

document.getElementById('sidebar-right')?.addEventListener('contextmenu', (e) => {
  if (!betaLayoutOn()) return;
  if (e.target.closest && e.target.closest('.rail-avatar, #rail-hangup')) return;
  e.preventDefault();
  e.stopPropagation();
  openCommunityCreate();
});

document.addEventListener('click', (e) => {
  const sheet = document.querySelector('.rail-sheet');
  if (!sheet) return;
  if (sheet.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.rail-avatar, #community-add, .rail-comm')) return;
  closeRailSheets();
});

function applyBetaLayout(on) {
  document.body.classList.toggle('beta-layout', !!on);
  document.body.classList.toggle('no-ui-motion', !!on && theme.uiMotion === false);
  const lcInput = document.getElementById('live-chat-input');
  if (lcInput) lcInput.placeholder = on ? 'Message everyone' : 'Say something to everyone';
  // Older builds (and the retired quality governor) saved animations/motion off
  // and left the cursor trail and old glass values behind. Move beta profiles
  // onto the beta look once.
  if (on && localStorage.getItem('solar-beta-visuals-v') !== '2') {
    localStorage.setItem('solar-beta-visuals-v', '2');
    Object.assign(theme, {
      animations: true, uiMotion: true, lowGraphics: false, particles: true, parallax: true, meteors: true,
      trail: false, blur: 18, alpha: 48, sceneDim: 34,
    });
    saveTheme();
    applyTheme();
  }
  // Purple became the default accent; move people still on the old default once.
  if (on && localStorage.getItem('solar-accent-default-v') !== '1') {
    localStorage.setItem('solar-accent-default-v', '1');
    if (theme.accent === 'nebula') {
      theme.accent = 'royal';
      saveTheme();
      applyTheme();
      if (document.getElementById('view-customize')?.classList.contains('active')) renderCustomize();
    }
  }
  if (on && document.getElementById('view-servers')?.classList.contains('active')) switchView('launchpad');
  const active = document.querySelector('.view.active');
  const view = active ? active.id.replace(/^view-/, '') : 'launchpad';
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  requestAnimationFrame(navInk);
  renderAccountBox();
  renderCommunities();
  setTimeout(refreshOnlineIndicator, 0);
  // Beta floating panels use the nav rail's glass, a little more frosted since they
  // sit over everything; the stable layout keeps each panel's own blur.
  for (const el of document.querySelectorAll('#live-chat, #online-pop, #updates-menu, #mod-modal .mod-panel')) {
    if (on) {
      if (el.dataset.lqBlurStable == null) el.dataset.lqBlurStable = el.dataset.lqBlur || '';
      el.dataset.lqBlur = '5';
    } else if (el.dataset.lqBlurStable != null) {
      if (el.dataset.lqBlurStable) el.dataset.lqBlur = el.dataset.lqBlurStable; else delete el.dataset.lqBlur;
      delete el.dataset.lqBlurStable;
    }
  }
  try {
    const bar = document.querySelector('.titlebar');
    if (on) { bar.dataset.lqBlur = '5'; window.SolarLiquidGlass?.attach(bar); } else window.SolarLiquidGlass?.detach(bar);
    window.SolarLiquidGlass?.refreshAll?.();
  } catch { /* glass engine optional */ }
}

// ---------- launch-button style previews (beta) ----------
// Each preview is a frozen copy of the real launchpad hero in that style,
// scaled into the Customize card. It has to be copied while the launchpad is
// on screen — a hidden view has no layout to copy.
let launchPreviewSnap = null;
let launchPreviewSvgN = 0;
const LAUNCH_FILL_SEL = ':is(#launch-btn, #launch-another-btn, #bedrock-launch-btn, #version-chip, #perf-chip, #fastlaunch-chip, #monitor-chip, #edition-switch, #bedrock-edition-switch, #level-card)';

function freezeStyle(cs, dst) {
  for (let i = 0; i < cs.length; i++) {
    // Custom properties stay live so the copy follows accent changes.
    if (cs[i].startsWith('--')) continue;
    dst.style.setProperty(cs[i], cs.getPropertyValue(cs[i]), 'important');
  }
  dst.style.setProperty('transition', 'none', 'important');
  dst.style.setProperty('animation', 'none', 'important');
}

function frozenPseudo(src, which) {
  const cs = getComputedStyle(src, which);
  if (!cs || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none') return null;
  const el = document.createElement('span');
  freezeStyle(cs, el);
  if (/^["']/.test(cs.content)) el.textContent = cs.content.slice(1, -1);
  return el;
}

/** Deep copy with every computed style inlined, so no class or id rule is needed. */
function frozenClone(src) {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode();
  if (src.nodeType !== Node.ELEMENT_NODE) return null;
  const cs = getComputedStyle(src);
  if (cs.display === 'none') return null;
  if (src instanceof SVGSVGElement) {
    const svg = src.cloneNode(true);
    svg.removeAttribute('id');
    const tag = `lsp${++launchPreviewSvgN}-`;
    svg.innerHTML = svg.innerHTML.replace(/\bwm\d+-/g, tag);
    freezeStyle(cs, svg);
    return svg;
  }
  let dst;
  if (src.tagName === 'CANVAS') {
    dst = document.createElement('canvas');
    dst.width = src.width;
    dst.height = src.height;
    try { dst.getContext('2d').drawImage(src, 0, 0); } catch { /* tainted or lost context */ }
  } else if (src.tagName === 'IMG') {
    dst = document.createElement('img');
    dst.src = src.currentSrc || src.src;
  } else {
    dst = document.createElement(/^(BUTTON|INPUT|SELECT|TEXTAREA|A|LABEL)$/.test(src.tagName) ? 'div' : src.tagName);
  }
  freezeStyle(cs, dst);
  // Color buttons read the live accent, so the preview follows a new pick.
  if (document.body.classList.contains('launch-style-purple') && src.matches(LAUNCH_FILL_SEL)) {
    dst.style.setProperty('background-image', 'linear-gradient(160deg, var(--btn-top), var(--btn-bot))', 'important');
  }
  const before = frozenPseudo(src, '::before');
  if (before) dst.appendChild(before);
  for (const child of src.childNodes) {
    const c = frozenClone(child);
    if (c) dst.appendChild(c);
  }
  const after = frozenPseudo(src, '::after');
  if (after) dst.appendChild(after);
  return dst;
}

function captureLaunchPreview() {
  if (!betaLayoutOn()) return;
  const hero = document.getElementById('launchpad-hero');
  if (!hero || !hero.offsetWidth) return;
  const r = hero.getBoundingClientRect();
  const sig = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
    + `|${hero.textContent.replace(/\s+/g, ' ')}|${document.body.className}|${document.documentElement.style.cssText}`;
  if (launchPreviewSnap?.sig === sig) return;
  const wasPurple = document.body.classList.contains('launch-style-purple');
  const copies = {};
  for (const style of ['purple', 'glass']) {
    document.body.classList.toggle('launch-style-purple', style === 'purple');
    copies[style] = frozenClone(hero);
  }
  document.body.classList.toggle('launch-style-purple', wasPurple);
  // The main shell's glass sits between the wallpaper and the hero.
  const main = document.querySelector('.main');
  const shell = [...main.children].filter((n) => /^lq-(backdrop|tint|specular|shine)$/.test(n.className))
    .map(frozenClone).filter(Boolean);
  const m = main.getBoundingClientRect();
  launchPreviewSnap = {
    sig, copies, shell, bg: frozenClone(document.querySelector('.bg-stack')),
    hero: { x: r.left, y: r.top, w: r.width, h: r.height },
    main: { x: m.left, y: m.top, w: m.width, h: m.height },
  };
}

// Copying the hero restyles the page twice, far too slow to do in the click
// that leaves the Launchpad. It's re-taken once the Launchpad has settled
// and sat idle, and only when something on it changed.
let launchPreviewIdle = 0;
function queueLaunchPreview() {
  if (launchPreviewIdle) return;
  launchPreviewIdle = setTimeout(() => requestIdleCallback(() => {
    launchPreviewIdle = 0;
    if (document.getElementById('view-launchpad')?.classList.contains('active') && !document.hidden) captureLaunchPreview();
  }, { timeout: 4000 }), 1500);
}

function placeAt(el, x, y, w, h) {
  el.style.setProperty('position', 'absolute', 'important');
  el.style.setProperty('margin', '0', 'important');
  el.style.setProperty('inset', 'auto', 'important');
  el.style.setProperty('left', `${x}px`, 'important');
  el.style.setProperty('top', `${y}px`, 'important');
  el.style.setProperty('width', `${w}px`, 'important');
  el.style.setProperty('height', `${h}px`, 'important');
  el.style.setProperty('transform', 'none', 'important');
}

function renderLaunchPreviews() {
  const snap = launchPreviewSnap;
  document.querySelectorAll('.ls-option').forEach((opt) => {
    const box = opt.querySelector('.ls-preview');
    if (snap && box._snap === snap && box._w === box.clientWidth && box.firstChild) return;
    box._snap = snap;
    box._w = box.clientWidth;
    box.textContent = '';
    box.style.height = '';
    if (!snap) {
      box.classList.add('ls-empty');
      box.textContent = 'Open the Launchpad once to see a preview here.';
      return;
    }
    box.classList.remove('ls-empty');
    const { hero, main } = snap;
    const s = box.clientWidth / hero.w;
    box.style.height = `${Math.round(hero.h * s)}px`;
    const stage = document.createElement('div');
    stage.className = 'ls-stage';
    stage.inert = true;
    stage.style.width = `${hero.w}px`;
    stage.style.height = `${hero.h}px`;
    stage.style.transform = `scale(${s})`;

    const bg = snap.bg?.cloneNode(true);
    if (bg) {
      placeAt(bg, -hero.x, -hero.y, window.innerWidth, window.innerHeight);
      stage.appendChild(bg);
    }
    for (const layer of snap.shell) {
      const l = layer.cloneNode(true);
      placeAt(l, main.x - hero.x, main.y - hero.y, main.w, main.h);
      stage.appendChild(l);
    }
    const copy = snap.copies[opt.dataset.launchStyle];
    if (copy) {
      placeAt(copy, 0, 0, hero.w, hero.h);
      stage.appendChild(copy);
    }
    box.appendChild(stage);
  });
}

function applyLaunchStyle() {
  const style = theme.launchStyle === 'glass' ? 'glass' : 'purple';
  document.body.classList.toggle('launch-style-purple', style === 'purple');
  document.querySelectorAll('[data-launch-style]').forEach((b) => {
    b.classList.toggle('active', b.dataset.launchStyle === style);
  });
}
document.querySelectorAll('[data-launch-style]').forEach((b) => {
  const pick = () => {
    if (theme.launchStyle === b.dataset.launchStyle) return;
    theme.launchStyle = b.dataset.launchStyle;
    saveTheme();
    applyLaunchStyle();
  };
  b.addEventListener('click', pick);
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });
});
window.addEventListener('resize', () => {
  if (document.getElementById('view-customize')?.classList.contains('active')) renderLaunchPreviews();
  else queueLaunchPreview();
});
applyLaunchStyle();
queueLaunchPreview();

async function doLogin() {
  try {
    await window.nebula.login();
    await renderAccountBox();
  } catch (err) {
    showToast('Sign-in failed', err.message, 'error');
  }
}

renderAccountBox();

function fmtMins(m) {
  m = Math.max(0, Math.round(m));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// Playtime is cumulative and never resets — the bar just tracks progress
// through the current level's slice of it. Shared by the account pill and
// the level card so the two can't drift apart.
function xpPercent(d) {
  const span = Math.max(1, d.xpNeeded - d.levelStart);
  const into = Math.max(0, d.totalXp - d.levelStart);
  return Math.min(100, Math.round((into / span) * 100));
}

// Repaint the level bits of the account pill in place, without tearing down
// and rebuilding the whole pill (which would re-request the skin head).
function paintAccountPillXp(d) {
  const row = accountBox.querySelector('.pill-level-row');
  if (!row) return;
  const ore = oreForLevel(d.level);
  const badge = row.querySelector('.ore-badge');
  if (badge) {
    badge.src = ore.img;
    badge.alt = ore.name;
    badge.title = ore.name;
    badge.style.filter = `drop-shadow(0 0 4px ${ore.color})`;
  }
  const num = row.querySelector('.level-num');
  if (num) num.textContent = `Lv ${d.level}`;
  const fill = row.querySelector('.xp-fill');
  if (fill) {
    fill.style.width = `${xpPercent(d)}%`;
    fill.style.background = ore.color;
  }
}

// Single source of truth for every level readout in the window. Both the
// pill and the card are painted from the SAME snapshot, so they always
// agree even if one of them was rendered ages ago.
async function refreshXpUi(data) {
  const d = data || await window.nebula.xpGet();
  paintAccountPillXp(d);
  renderLevelCard(d);
}

function renderLevelCard(d) {
  const card = document.getElementById('level-card');
  if (!card) return;
  if (!d) { window.nebula.xpGet().then(renderLevelCard); return; }
  const ore = oreForLevel(d.level);
  const pct = xpPercent(d);

  const oreEl = document.getElementById('level-card-ore');
  oreEl.innerHTML = `<img src="${ore.img}" alt="${ore.name}" style="width:36px;height:36px;image-rendering:pixelated;filter:drop-shadow(0 0 8px ${ore.color})">`;
  document.getElementById('level-card-name').textContent = ore.name;
  document.getElementById('level-card-name').style.color = ore.color;
  document.getElementById('level-card-num').textContent = `Level ${d.level}`;
  document.getElementById('level-card-bar').style.width = `${pct}%`;
  document.getElementById('level-card-bar').style.background = ore.color;
  document.getElementById('level-card-xp').textContent =
    `${fmtMins(Math.min(d.totalXp, d.xpNeeded))} / ${fmtMins(d.xpNeeded)} played`;
}

refreshXpUi();

// Main grants XP on its own (the launch bonus), so listen rather than
// relying on the renderer remembering to re-render after every action.
window.nebula.onXpChanged?.((d) => {
  if (d && d.leveled) showToast(`Level ${d.level}!`, `You reached ${oreForLevel(d.level).name} rank`, 'success');
  refreshXpUi(d);
});

// Playtime now ticks up every minute while you play, so the badges on the
// instance cards follow along instead of only changing after you quit.
window.nebula.onPlaytimeChanged?.(() => {
  if (document.getElementById('view-instances')?.classList.contains('active')) refreshInstances();
  updateLaunchState();
});

// PERF: this fired every 5s for the lifetime of the app, including while
// the launcher was minimised or sitting behind a fullscreen Minecraft.
// document.hidden costs nothing to check and skips the whole re-render.
const perfPanelEl = document.getElementById("view-launchpad");
setInterval(() => {
  if (document.hidden) return;
  if (perfPanelEl?.classList.contains("active")) renderPerformance();
}, 5000);

// ---------- instances (your created instances) ----------
function fmtPlaytime(ms) {
  const h = ms / 3600000;
  if (h >= 10) return `${Math.round(h)}h played`;
  if (h >= 1) return `${h.toFixed(1)}h played`;
  const m = Math.round(ms / 60000);
  return m >= 1 ? `${m}m played` : '';
}

// Instances are grouped by loader everywhere they're listed — a flat
// mixed list made it far too easy to install a Fabric mod into a vanilla
// instance and wonder why nothing loaded.
const LOADER_ORDER = ['vanilla', 'fabric', 'quilt', 'forge'];
const LOADER_LABEL = { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge' };

function loaderKey(inst) {
  const l = (inst.loader || 'vanilla').toLowerCase();
  return LOADER_ORDER.includes(l) ? l : 'vanilla';
}
function loaderLabel(key) {
  return LOADER_LABEL[key] || (key[0].toUpperCase() + key.slice(1));
}
/** "1.21.8 · Vanilla" / "1.21.11 · Fabric" — version and loader split by a middle dot. */
function versionLoaderLabel(version, key) {
  return `${version} \u00b7 ${loaderLabel(key || 'vanilla')}`;
}

// -> [[loaderKey, instances[]], ...] in a stable, familiar order, with any
// unrecognised loader falling in after the known ones.
function groupByLoader(instances) {
  const buckets = new Map();
  for (const inst of instances) {
    const k = loaderKey(inst);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(inst);
  }
  const keys = Array.from(buckets.keys()).sort((a, b) => {
    const ai = LOADER_ORDER.indexOf(a), bi = LOADER_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b);
  });
  return keys.map(k => [k, buckets.get(k).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))]);
}

const VS_EMPTY = `
  <div class="vs-empty">
    <div class="vs-empty-ghosts" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="vs-empty-body">
      <span class="vs-empty-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg></span>
      <b class="vs-empty-title">No instances yet</b>
      <span class="vs-empty-sub">Pick a version up top, choose a loader and hit Create. Your instances show up right here.</span>
      <button type="button" class="vs-empty-go">Create your first instance</button>
    </div>
  </div>`;
async function refreshInstances() {
  const [list, playtime] = await Promise.all([window.nebula.listInstances(), window.nebula.getPlaytime()]);
  const el = document.getElementById('instance-list');
  el.innerHTML = '';
  const instCount = document.getElementById('vs-inst-count');
  if (instCount) instCount.textContent = list.length;
  if (!list.length) {
    el.innerHTML = betaLayoutOn() ? VS_EMPTY : '<p class="dim">Pick a version below to create your first instance.</p>';
    el.querySelector('.vs-empty-go')?.addEventListener('click', () => {
      const view = document.getElementById('view-instances');
      view.scrollTo({ top: 0, behavior: 'smooth' });
      const btn = document.getElementById('picker-create');
      if (!btn) return;
      btn.classList.remove('vs-flash');
      void btn.offsetWidth;
      btn.classList.add('vs-flash');
      setTimeout(() => btn.classList.remove('vs-flash'), 1700);
    });
    refreshInstanceSelects(list);
    return;
  }

  for (const [key, instances] of groupByLoader(list)) {
    const header = document.createElement('div');
    header.className = `instance-group-label loader-${key}`;
    header.innerHTML = `<span class="igl-dot"></span>${loaderLabel(key)}<span class="igl-count">${instances.length}</span>`;
    el.appendChild(header);

    const row = document.createElement('div');
    row.className = 'instance-group-row';
    for (const inst of instances) {
      const pt = playtime[`${inst.versionNumber}|${inst.name}`];
      const ptStr = pt && pt.ms ? fmtPlaytime(pt.ms) : '';
      const card = document.createElement('div');
      const art = buildArt(inst.versionNumber) || mojangArtFor(inst.group.replace('.x', ''), versionGroups.find((g) => g.group === inst.group)?.versions);
      card.className = `instance-card liquid-glass loader-${key}${art ? ' has-art' : ''}`;
      card.innerHTML = `
        <div class="art">${artImg(art)}<span class="art-label">${inst.group.replace('.x', '')}</span></div>
        <div class="body">
          <div class="name">${escapeHtml(inst.name)}</div>
          <div class="meta">${versionLoaderLabel(inst.versionNumber, key)}${ptStr ? ` · <span class="playtime-badge">${ptStr}</span>` : ''}</div>
          <button class="del">Delete</button>
        </div>
      `;
      card.querySelector('.del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.nebula.deleteInstance({ name: inst.name, versionNumber: inst.versionNumber });
        refreshInstances();
      });
      row.appendChild(card);
    }
    el.appendChild(row);
  }
  refreshInstanceSelects(list);
}

const LAST_INSTANCE_KEY = 'nebula-last-instance';
function rememberInstance(value) {
  if (value) localStorage.setItem(LAST_INSTANCE_KEY, value);
}

/** "1.21.8 · Vanilla" / "1.21.11 · Fabric" — a custom instance name is appended only if it adds something. */
function formatInstanceLabel(i) {
  const l = loaderKey(i);
  let name = i.name.replace(/[\[\]]/g, '').trim();
  const lower = name.toLowerCase();
  if (lower.startsWith(l + ' ')) name = name.substring(l.length + 1).trim();
  if (name.toLowerCase().endsWith(' ' + l)) name = name.substring(0, name.length - l.length - 1).trim();
  let display = versionLoaderLabel(i.versionNumber, l);
  if (name && name !== i.versionNumber) display = `${display} \u00b7 ${name}`;
  return escapeHtml(display);
}

async function refreshInstanceSelects(list) {
  const instances = list || await window.nebula.listInstances();

  // Recent launches (same store the version popover uses), newest first.
  let lastLaunchedHtml = '';
  try {
    const seen = new Set();
    const opts = loadRecentLaunches().map(r => {
      const loader = (r.loader || 'vanilla').toLowerCase();
      const match = instances.find(inst =>
        inst.name === r.name && inst.versionNumber === r.versionNumber
        && (inst.loader || 'vanilla').toLowerCase() === loader)
        || instances.find(inst => inst.versionNumber === r.versionNumber
        && (inst.loader || 'vanilla').toLowerCase() === loader);
      if (!match) return '';
      const val = `${match.name}|${match.versionNumber}|${match.loader}`;
      if (seen.has(val)) return '';
      seen.add(val);
      return `<option value="${escapeHtml(val)}">${formatInstanceLabel(match)}</option>`;
    }).filter(Boolean);
    if (opts.length > 0) {
      lastLaunchedHtml = `<optgroup label="Recent">${opts.join('')}</optgroup>`;
    }
  } catch { /* corrupt entry: fall through to the plain list */ }

  const grouped = groupByLoader(instances);
  const optsHtml = grouped.map(([key, items]) => `
    <optgroup label="${loaderLabel(key)}">
      ${items.map(i => `<option value="${escapeHtml(`${i.name}|${i.versionNumber}|${i.loader}`)}">${formatInstanceLabel(i)}</option>`).join('')}
    </optgroup>
  `).join('');
  const optsHtmlFull = lastLaunchedHtml + optsHtml;

  const valid = new Set(instances.map(i => `${i.name}|${i.versionNumber}|${i.loader}`));
  // Whatever was selected wins; otherwise fall back to the instance the
  // launcher was last closed on, then to the first one in the list.
  const remembered = localStorage.getItem(LAST_INSTANCE_KEY);

  for (const id of ['launch-instance-select', 'mods-instance-select']) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = optsHtmlFull || '<option value="">No instances yet</option>';
    const pick = [prev, remembered].find(v => v && valid.has(v));
    if (pick) sel.value = pick;
    enhanceSelect(id);
    sel._refreshCustomSelect?.();
  }
  rememberInstance(document.getElementById('launch-instance-select').value);
  updateLaunchState();
}

// ---------- version browsing grid ----------
// Deterministic little "planet" palette per version group, so tiles read
// as a starfield instead of a wall of identical purple boxes.
const SPACE_PALETTES = [
  ['#7c3aed', '#2563eb'], // violet / blue nebula
  ['#0ea5e9', '#06b6d4'], // cyan ice giant
  ['#f97316', '#dc2626'], // ember / mars
  ['#22c55e', '#0891b2'], // emerald gas giant
  ['#e11d48', '#7c3aed'], // crimson / violet
  ['#eab308', '#f97316'], // gold sun
  ['#8b5cf6', '#ec4899'], // magenta nebula
  ['#14b8a6', '#3b82f6'], // teal ocean world
];
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function starPositions(seed, count) {
  let s = seed >>> 0;
  const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const pts = [];
  for (let i = 0; i < count; i++) {
    pts.push({ x: Math.round(r() * 100), y: Math.round(r() * 100), o: (0.35 + r() * 0.5).toFixed(2) });
  }
  return pts;
}

// Beta: Mojang's own artwork for each release, from the Java patch notes feed the
// official launcher uses. Cached for a day; releases without art keep the plain tile.
const MJ_ART_KEY = 'sc-mojang-art';
let mojangArt = null;
let mojangArtLoading = false;
function loadMojangArt() {
  if (mojangArt || mojangArtLoading) return;
  try {
    const c = JSON.parse(localStorage.getItem(MJ_ART_KEY) || 'null');
    if (c && Date.now() - c.t < 86400000) { mojangArt = c.map; return; }
  } catch { /* corrupt cache: refetch */ }
  mojangArtLoading = true;
  fetch('https://launchercontent.mojang.com/v2/javaPatchNotes.json')
    .then((r) => r.json())
    .then((j) => {
      const map = {};
      for (const e of j.entries || []) {
        if (e.type === 'release' && e.version && e.image?.url) map[e.version] = `https://launchercontent.mojang.com${e.image.url}`;
      }
      mojangArt = map;
      try { localStorage.setItem(MJ_ART_KEY, JSON.stringify({ t: Date.now(), map })); } catch { /* quota */ }
      if (document.getElementById('view-instances')?.classList.contains('active')) { renderVersionGrid(); refreshInstances(); }
    })
    .catch(() => {})
    .finally(() => { mojangArtLoading = false; });
}
// Bundled 960x540 art (official key art from 1.13 on, era shots before). Preferred
// over the feed, whose images are small squares (240px up to 1.20). Newer drops
// fall back to the feed.
const LOCAL_ART = new Set(['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9', '1.10', '1.11',
  '1.12', '1.13', '1.14', '1.15', '1.16', '1.17', '1.18', '1.19', '1.20', '1.21']);
/** Bundled art for the group, else its own drop art (26.1…), else the newest build in it that has art. */
function mojangArtFor(label, versions = []) {
  if (LOCAL_ART.has(label)) return `img/versions/${label}.jpg`;
  return mojangArt ? (mojangArt[label] || versions.map((v) => mojangArt[v]).find(Boolean) || '') : '';
}
/** One build's art: bundled group art first, then that build's own feed image. */
function buildArt(v) {
  const g = versionGroups.find((x) => x.versions.includes(v));
  const label = g ? g.group.replace('.x', '') : '';
  if (LOCAL_ART.has(label)) return `img/versions/${label}.jpg`;
  return (mojangArt && mojangArt[v]) || (g ? mojangArtFor(label, g.versions) : '');
}
function artImg(url) {
  return url ? `<img class="vt-img beta-only" src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" draggable="false">` : '';
}

function renderVersionGrid() {
  const grid = document.getElementById('version-grid');
  if (!grid) return;
  if (!versionGroups.length) { grid.innerHTML = '<p class="dim">Loading versions…</p>'; return; }
  if (betaLayoutOn()) loadMojangArt();

  grid.innerHTML = versionGroups.map((g, i) => {
    const h = hashStr(g.group);
    const [c1, c2] = SPACE_PALETTES[h % SPACE_PALETTES.length];
    const n = g.versions.length;
    const label = g.group.replace('.x', '');
    const range = n > 1 ? `${g.versions[n - 1]} – ${g.versions[0]}` : (g.versions[0] !== label ? g.versions[0] : '');
    const art = mojangArtFor(label, g.versions);
    return `
    <div class="version-tile space-tile${art ? ' has-art' : ''}" data-group="${g.group}">
      <div class="art" style="background:radial-gradient(ellipse at 30% 25%, ${c1}, ${c2} 70%, #0a0714 130%);">
        <div class="tile-stars"></div>
        ${artImg(art)}
        <span class="art-label">${label}</span>
        ${i === 0 ? '<i class="um-pill vt-latest beta-only">Latest</i>' : ''}
      </div>
      <div class="version-tile-count">
        <span class="vt-n">${n} version${n !== 1 ? 's' : ''}</span>
        ${range ? `<small class="vt-range beta-only">${escapeHtml(range)}</small>` : ''}
        <span class="vt-make beta-only">Create</span>
      </div>
    </div>
  `;
  }).join('');
  const allCount = document.getElementById('vs-all-count');
  if (allCount) allCount.textContent = versionGroups.length;

  // scatter a few CSS-only twinkling stars per tile
  grid.querySelectorAll('.tile-stars').forEach((el, i) => {
    const pts = starPositions(hashStr(versionGroups[i].group) + 1, 14);
    el.style.backgroundImage = pts.map(p => `radial-gradient(1.6px 1.6px at ${p.x}% ${p.y}%, rgba(255,255,255,${p.o}), transparent 60%)`).join(',');
  });

  grid.querySelectorAll('.version-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      if (betaLayoutOn() && tile.dataset.group === pickedGroup && !document.getElementById('version-picker-panel').classList.contains('hidden')) return;
      openVersionPicker(tile.dataset.group);
    });
  });

  // Beta: the picker is always open. Re-renders (art arriving) keep what's open
  // instead of rebuilding it under the user; otherwise it starts on the newest.
  if (betaLayoutOn()) {
    const panel = document.getElementById('version-picker-panel');
    const open = !panel.classList.contains('hidden') && versionGroups.some((g) => g.group === pickedGroup);
    if (open) markPickedTile(pickedGroup);
    else openVersionPicker(versionGroups[0].group, { scroll: false });
  }
}

// The Versions tab has its own loader dropdown, and it had exactly the
// same problem as the launch-page popover: every release was offered for
// every loader. Repopulate the version list whenever the loader changes.
async function wirePickerLoaderFilter(allVersions) {
  const loaderSel = document.getElementById('picker-loader');
  const verSel = document.getElementById('picker-version');
  const nameInput = document.getElementById('picker-name');
  if (!loaderSel || !verSel) return;

  const apply = async () => {
    const loader = loaderSel.value;
    const supported = await ensureLoaderSupport(loader);
    const prev = verSel.value;
    const list = allVersions
      .filter(v => meetsLoaderFloor(loader, v))
      .filter(v => (supported ? supported.has(v) : true));
    verSel.innerHTML = list.length
      ? list.map(v => `<option value="${v}">${v}</option>`).join('')
      : '<option value="">No versions support this loader</option>';
    if (list.includes(prev)) verSel.value = prev;
    verSel._refreshCustomSelect?.();
    verSel.dispatchEvent(new Event('picker-list'));
    const createBtn = document.getElementById('picker-create');
    if (createBtn) createBtn.disabled = !list.length;
    if (nameInput && list.length && !nameInput.dataset.touched) {
      nameInput.value = loader === 'vanilla' ? `My ${verSel.value} world` : `${verSel.value} ${loader}`;
    }
  };

  nameInput?.addEventListener('input', () => { nameInput.dataset.touched = '1'; });
  loaderSel.addEventListener('change', apply);
  verSel.addEventListener('change', () => {
    if (nameInput && !nameInput.dataset.touched) {
      const loader = loaderSel.value;
      nameInput.value = loader === 'vanilla' ? `My ${verSel.value} world` : `${verSel.value} ${loader}`;
    }
  });
  await apply();
}

let pickedGroup = null;
function openVersionPicker(groupKey, { scroll = true } = {}) {
  const group = versionGroups.find(g => g.group === groupKey);
  if (!group) return;
  const panel = document.getElementById('version-picker-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = pickerHtml(`Choose a build from ${groupKey.replace('.x', '')}`);
  document.getElementById('picker-version').innerHTML = group.versions.map(v => `<option value="${v}">${v}</option>`).join('');
  document.getElementById('picker-name').value = `My ${group.versions[0]} world`;
  pickerDefaults(group.versions);
  enhanceSelect('picker-version');
  enhanceSelect('picker-loader');
  wirePickerCreate(panel);
  wirePickerLoaderFilter(group.versions);
  wirePickerExtras(panel, group.versions);
  markPickedTile(groupKey);
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const PICKER_LOADERS = ['vanilla', 'fabric', 'forge', 'quilt'];
/** Shared picker markup. The art, loader buttons and field labels are beta-only;
    .vp-field is display:contents on stable so the old one-row layout is unchanged. */
function pickerHtml(title) {
  return `
    <div class="vp-art beta-only"><img class="vp-art-img" alt="" draggable="false"><span class="vp-art-label"></span></div>
    <div class="vp-main">
      <div class="version-picker-header"><span class="vp-title">${title}</span></div>
      <div class="vp-loaders beta-only">
        ${PICKER_LOADERS.map((l) => `<button type="button" class="vp-ld loader-${l}" data-loader="${l}"><i class="igl-dot"></i>${loaderLabel(l)}</button>`).join('')}
      </div>
      <div class="version-picker-row">
        <div class="vp-field vp-f-ver"><span class="vp-lbl beta-only">Build</span><select id="picker-version"></select></div>
        <div class="vp-field vp-f-name"><span class="vp-lbl beta-only">Name</span><input id="picker-name" placeholder="Instance name"></div>
        <div class="vp-field vp-f-ld"><select id="picker-loader">
          ${PICKER_LOADERS.map((l) => `<option value="${l}">${loaderLabel(l)}</option>`).join('')}
        </select></div>
        <button id="picker-create" class="pill-btn primary">Create instance</button>
      </div>
    </div>
  `;
}
/** Beta: start on Fabric whenever any build in the list can run it. */
function pickerDefaults(versions) {
  if (!betaLayoutOn() || !versions.some((v) => meetsLoaderFloor('fabric', v))) return;
  document.getElementById('picker-loader').value = 'fabric';
}
/** Beta: loader buttons drive the hidden loader select; the art follows the chosen build. */
function wirePickerExtras(panel, versions) {
  const loaderSel = document.getElementById('picker-loader');
  const verSel = document.getElementById('picker-version');
  const btns = [...panel.querySelectorAll('.vp-ld')];
  const syncLoaders = () => btns.forEach((b) => b.classList.toggle('on', b.dataset.loader === loaderSel.value));
  for (const b of btns) {
    b.disabled = !versions.some((v) => meetsLoaderFloor(b.dataset.loader, v));
    b.addEventListener('click', () => {
      if (loaderSel.value === b.dataset.loader) return;
      loaderSel.value = b.dataset.loader;
      loaderSel._refreshCustomSelect?.();
      loaderSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  loaderSel.addEventListener('change', syncLoaders);
  syncLoaders();
  const img = panel.querySelector('.vp-art-img');
  const label = panel.querySelector('.vp-art-label');
  const syncArt = () => {
    const v = verSel.value;
    const url = buildArt(v);
    panel.classList.toggle('vp-has-art', !!url);
    if (url) img.src = url; else img.removeAttribute('src');
    label.textContent = v || '';
  };
  verSel.addEventListener('change', syncArt);
  verSel.addEventListener('picker-list', syncArt);
  syncArt();
}

/** Beta: the tile whose builds are open stays lit. */
function markPickedTile(groupKey) {
  pickedGroup = groupKey;
  document.querySelectorAll('#version-grid .version-tile').forEach((t) => t.classList.toggle('is-picked', t.dataset.group === groupKey));
}

// Opened from the "+ New instance" button in the header — same picker,
// but with every version from every group in one dropdown so you don't
// have to hunt down and click a specific group tile first.
function openVersionPickerFlat() {
  const panel = document.getElementById('version-picker-panel');
  panel.classList.remove('hidden');
  const allVersions = versionGroups.flatMap(g => g.versions);
  panel.innerHTML = pickerHtml('Create a new instance');
  document.getElementById('picker-version').innerHTML = allVersions.map(v => `<option value="${v}">${v}</option>`).join('');
  document.getElementById('picker-name').value = `My ${allVersions[0]} world`;
  pickerDefaults(allVersions);
  enhanceSelect('picker-version');
  enhanceSelect('picker-loader');
  wirePickerCreate(panel);
  wirePickerLoaderFilter(allVersions);
  wirePickerExtras(panel, allVersions);
  markPickedTile(null);
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function wirePickerCreate(panel) {
  document.getElementById('picker-create').addEventListener('click', async () => {
    const versionNumber = document.getElementById('picker-version').value;
    const name = document.getElementById('picker-name').value.trim() || `My ${versionNumber} world`;
    const loader = document.getElementById('picker-loader').value;
    await window.nebula.createInstance({ name, versionNumber, loader });
    if (!betaLayoutOn()) {
      panel.classList.add('hidden');
      markPickedTile(null);
    }
    showToast('Instance created', `${name} (${versionNumber})`, 'success');
    refreshInstances();
  });
}
document.getElementById('quick-create-btn').addEventListener('click', openVersionPickerFlat);

// ---------- launch state ----------
async function updateLaunchState() {
  const current = await window.nebula.currentAccount();
  const sel = document.getElementById('launch-instance-select');
  const chipLabel = document.getElementById('version-chip-label');

  const selVal = sel.value;
  if (selVal) {
    const [name, version, loader] = selVal.split('|');
    // The chip shows the INSTANCE NAME (e.g. "1.21.11 fabric"). Showing
    // only the bare version was wrong — the instance is named, and that
    // name is what identifies which one is selected.
    chipLabel.textContent = name;
    // speculative pre-cache: start pulling this instance's files right now,
    // so by the time Launch is clicked there's (often) nothing left to download
    window.nebula.prewarm({ instanceName: name, versionNumber: version, loader: loader || 'vanilla' });
  } else {
    chipLabel.textContent = 'No instance';
  }
  signedIn = !!current;
  updateLaunchButtons();
  renderPerformance();
  syncPreload();
}
// The launch page and the mods page point at the same instance. Switching
// on one moves the other, so "Install" always lands in the instance you're
// actually about to play — previously the mods page kept whatever it was
// left on and mods went into the wrong folder.
let syncingInstanceSelects = false;
function mirrorInstanceSelection(fromId, toId) {
  if (syncingInstanceSelects) return false;
  const from = document.getElementById(fromId);
  const to = document.getElementById(toId);
  if (!from || !to || !from.value || to.value === from.value) return false;
  const canMatch = Array.from(to.querySelectorAll('option')).some(o => o.value === from.value);
  if (!canMatch) return false;
  syncingInstanceSelects = true;
  to.value = from.value;
  to._refreshCustomSelect?.();
  syncingInstanceSelects = false;
  return true;
}

document.getElementById('launch-instance-select').addEventListener('change', async () => {
  rememberInstance(document.getElementById('launch-instance-select').value);
  updateLaunchState();
  if (mirrorInstanceSelection('launch-instance-select', 'mods-instance-select')) {
    await refreshInstalledContent();
    searchMods();
  }
});
let signedIn = false;

// ---------- mods browser ----------
let currentType = 'mod';
// Modrinth is the only source now. CurseForge required a per-developer API
// key that couldn't be shipped, and half-working "connect your own key"
// wasn't worth the confusion it caused.
const currentSource = 'modrinth';
let installedProjectIds = new Set();

document.querySelectorAll('.type-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentType = tab.dataset.type;
    searchMods();
  });
});

document.querySelectorAll('.source-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.source-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    searchMods();
  });
});

// ---------- Content / Library mode ----------
let modsMode = 'content';
function applyModsMode() {
  document.getElementById('content-pane').classList.toggle('hidden', modsMode !== 'content');
  document.getElementById('content-controls').classList.toggle('hidden', modsMode !== 'content');
  document.getElementById('library-pane').classList.toggle('hidden', modsMode !== 'library');
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === modsMode));
}
document.querySelectorAll('.mode-tab').forEach(tab => {
  tab.addEventListener('click', async () => {
    modsMode = tab.dataset.mode;
    applyModsMode();
    if (modsMode === 'library') await refreshInstalledContent();
    else searchMods();
  });
});
applyModsMode();

// ---------- sync content between instances ----------
const syncModal = document.getElementById('sync-modal');

function instanceValue(i) { return `${i.name}|${i.versionNumber}|${i.loader}`; }
function parseInstanceValue(v) {
  const [name, versionNumber, loader] = (v || '').split('|');
  return { name, versionNumber, loader };
}

async function openSyncModal() {
  const instances = await window.nebula.listInstances();
  if (instances.length < 2) {
    return showToast('Need two instances', 'Create another instance first — there\u2019s nothing to sync from.', 'error');
  }
  const current = document.getElementById('mods-instance-select').value
    || document.getElementById('launch-instance-select').value;

  const optionsFor = (sel) => groupByLoader(instances).map(([key, items]) => `
    <optgroup label="${loaderLabel(key)}">
      ${items.map(i => `<option value="${escapeHtml(instanceValue(i))}">${escapeHtml(i.name)} (${i.versionNumber})</option>`).join('')}
    </optgroup>`).join('');

  const fromSel = document.getElementById('sync-from');
  const toSel = document.getElementById('sync-to');
  fromSel.innerHTML = optionsFor();
  toSel.innerHTML = optionsFor();
  toSel.value = current;
  // default the source to the first instance that isn't the target
  const other = instances.map(instanceValue).find(v => v !== current);
  fromSel.value = other || instances[0] && instanceValue(instances[0]);

  // These were the last two raw OS <select>s left in the app — grey system
  // dropdown, system highlight colour, nothing like the rest of the UI.
  enhanceSelect('sync-from');
  enhanceSelect('sync-to');
  fromSel._refreshCustomSelect?.();
  toSel._refreshCustomSelect?.();

  document.getElementById('sync-status').textContent = '';
  document.getElementById('sync-go').disabled = false;
  syncModal.classList.remove('hidden');
  updateSyncHint();
}

// Fabric mods are not Forge mods and neither will load on vanilla, so
// mods only ever move between instances running the SAME loader. Quilt is
// the one exception: it runs Fabric mods, so Fabric -> Quilt is allowed.
// Resource packs have no such restriction and stay available either way.
function loadersCompatible(fromLoader, toLoader) {
  const a = (fromLoader || 'vanilla').toLowerCase();
  const b = (toLoader || 'vanilla').toLowerCase();
  if (a === b) return true;
  return a === 'fabric' && b === 'quilt';
}

async function updateSyncHint() {
  const from = parseInstanceValue(document.getElementById('sync-from').value);
  const to = parseInstanceValue(document.getElementById('sync-to').value);
  const hint = document.getElementById('sync-mods-hint');
  const modsBox = document.getElementById('sync-mods');
  const packsBox = document.getElementById('sync-packs');
  const sameTarget = instanceValue(from) === instanceValue(to);

  if (sameTarget) {
    hint.textContent = 'pick two different instances';
    document.getElementById('sync-go').disabled = true;
    return;
  }

  const modsOk = loadersCompatible(from.loader, to.loader);
  modsBox.disabled = !modsOk;
  modsBox.closest('.toggle-inline').classList.toggle('disabled', !modsOk);
  if (!modsOk) {
    modsBox.checked = false;
    hint.textContent = to.loader === 'vanilla'
      ? "vanilla can't load mods — resource packs only"
      : `${from.loader} mods don't run on ${to.loader} — resource packs only`;
  } else {
    hint.textContent = (from.versionNumber === to.versionNumber && from.loader === to.loader)
      ? 'copied directly — same version and loader'
      : `re-downloaded for ${to.versionNumber} ${to.loader}`;
  }
  document.getElementById('sync-go').disabled = !modsBox.checked && !packsBox.checked;
  try {
    const { mods, packs } = await window.nebula.syncPreview({ from });
    document.getElementById('sync-status').textContent =
      `${from.name} has ${mods.length} mod${mods.length === 1 ? '' : 's'} and ${packs.length} resource pack${packs.length === 1 ? '' : 's'}.`;
  } catch { /* preview is a nicety */ }
}
document.getElementById('sync-mods').addEventListener('change', updateSyncHint);
document.getElementById('sync-packs').addEventListener('change', updateSyncHint);
document.getElementById('sync-from').addEventListener('change', updateSyncHint);
document.getElementById('sync-to').addEventListener('change', updateSyncHint);
document.getElementById('sync-content-btn').addEventListener('click', openSyncModal);
document.getElementById('sync-cancel').addEventListener('click', () => syncModal.classList.add('hidden'));
syncModal.addEventListener('click', (e) => { if (e.target === syncModal) syncModal.classList.add('hidden'); });

window.nebula.onSyncProgress(({ label, done, total }) => {
  const el = document.getElementById('sync-status');
  if (el) el.textContent = `${done}/${total} — ${label}`;
});

document.getElementById('sync-go').addEventListener('click', async () => {
  const from = parseInstanceValue(document.getElementById('sync-from').value);
  const to = parseInstanceValue(document.getElementById('sync-to').value);
  const includeMods = document.getElementById('sync-mods').checked;
  const includePacks = document.getElementById('sync-packs').checked;
  if (!includeMods && !includePacks) return showToast('Nothing selected', 'Tick mods, resource packs, or both.', 'error');
  if (includeMods && !loadersCompatible(from.loader, to.loader)) {
    return showToast('Loaders don\u2019t match', `${from.loader} mods won\u2019t load on ${to.loader}.`, 'error');
  }

  const btn = document.getElementById('sync-go');
  btn.disabled = true;
  document.getElementById('sync-status').textContent = 'Starting…';
  try {
    const r = await window.nebula.syncInstances({
      from, to, includeMods, includePacks, syncId: `sync-${Date.now()}`,
    });
    syncModal.classList.add('hidden');
    const moved = r.copied.length + r.upgraded.length;
    const detail = [
      r.upgraded.length ? `${r.upgraded.length} re-downloaded for ${to.versionNumber}` : '',
      r.copied.length ? `${r.copied.length} copied` : '',
      r.skipped.length ? `${r.skipped.length} skipped` : '',
    ].filter(Boolean).join(' · ');
    showToast(moved ? 'Sync complete' : 'Nothing to sync', detail || 'No content found in the source instance.', moved ? 'success' : 'info');
    if (r.skipped.length) {
      console.log('[SolarClient] skipped during sync:', r.skipped);
      setTimeout(() => showToast(
        'Some mods were skipped',
        r.skipped.slice(0, 3).map(x => `${x.title} (${x.reason})`).join('; ') + (r.skipped.length > 3 ? '…' : ''),
        'info',
      ), 900);
    }
    await refreshInstalledContent();
    await refreshStackStatus();
  } catch (err) {
    showToast('Sync failed', err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('mods-search').addEventListener('input', debounce(searchMods, 400));
document.getElementById('mods-instance-select').addEventListener('change', async () => {
  rememberInstance(document.getElementById('mods-instance-select').value);
  if (mirrorInstanceSelection('mods-instance-select', 'launch-instance-select')) updateLaunchState();
  await refreshInstalledContent();
  searchMods();
});

// Shared renderer for the "installed" panels — used for both mods
// (toggle + delete) and resource packs (delete only, no enable/disable
// since packs are toggled in-game, not by renaming the file).
async function renderInstalledPanel({ panelId, folder, listFn, kindLabel, emptyPlural, summaryLabel, showToggle }) {
  const selVal = document.getElementById('mods-instance-select').value;
  const panel = document.getElementById(panelId);
  if (!selVal) { panel.innerHTML = ''; return; }
  const [instanceName, versionNumber] = selVal.split('|');

  const items = await listFn({ name: instanceName, versionNumber });
  if (folder === 'mods') {
    installedProjectIds = new Set();
    items.forEach(m => { if (m.projectId) installedProjectIds.add(m.projectId); });
    // Older builds wrote the slug into the manifest instead of the real id,
    // so the set holds both kinds and the grid checks both.
    items.forEach(m => { if (m.slug) installedProjectIds.add(m.slug); });
  }

  if (!items.length) { panel.innerHTML = `<p class="dim">No ${emptyPlural} installed in this instance yet.</p>`; return; }

  // Collapsible so it's out of the way while browsing/searching for more —
  // stays open by default, but the header remembers the user's choice.
  const wasOpen = panel.querySelector('details')?.open ?? true;
  panel.innerHTML = `
    <details class="installed-mods-details" ${wasOpen ? 'open' : ''}>
      <summary><span>${summaryLabel}</span><span class="dock-sub">${items.length}</span></summary>
      <div class="installed-mods-rows">
        ${items.map(m => `
          <div class="installed-mod-row">
            ${m.iconUrl ? `<img class="mod-icon-sm" src="${m.iconUrl}" onerror="this.removeAttribute('src');">` : `<div class="mod-icon-sm"></div>`}
            <span class="mod-title">${escapeHtml(m.title)}</span>
            ${showToggle ? `
            <label class="toggle">
              <input type="checkbox" data-file="${escapeHtml(m.fileName)}" ${m.enabled ? 'checked' : ''}>
              <span class="toggle-track"><span class="toggle-thumb"></span></span>
            </label>` : ''}
            <button class="mod-delete-btn" data-file="${escapeHtml(m.fileName)}" title="Delete this ${kindLabel} permanently"><svg class="trash-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
          </div>
        `).join('')}
      </div>
    </details>
  `;

  if (showToggle) {
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        await window.nebula.toggleMod({ name: instanceName, versionNumber, fileName: cb.dataset.file, enable: cb.checked });
      });
    });
  }

  panel.querySelectorAll('.mod-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const fileName = btn.dataset.file;
      const ok = await showConfirm(`Delete ${fileName} from this instance's ${folder} folder? This can't be undone.`, {
        title: `Delete this ${kindLabel}?`, confirmLabel: 'Delete',
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        await window.nebula.deleteMod({ name: instanceName, versionNumber, fileName, folder });
        showToast(`${kindLabel[0].toUpperCase()}${kindLabel.slice(1)} deleted`, fileName, 'success');
        await refreshInstalledContent();
        searchMods();
      } catch (err) {
        btn.disabled = false;
        showToast(`Couldn't delete ${kindLabel}`, err.message, 'error');
      }
    });
  });
}

async function loadInstalledMods() {
  return renderInstalledPanel({
    panelId: 'installed-mods-panel', folder: 'mods', listFn: window.nebula.listInstalledMods,
    kindLabel: 'mod', emptyPlural: 'mods', summaryLabel: 'Installed mods', showToggle: true,
  });
}

async function loadInstalledResourcePacks() {
  return renderInstalledPanel({
    panelId: 'installed-respacks-panel', folder: 'resourcepacks', listFn: window.nebula.listInstalledResourcePacks,
    kindLabel: 'resource pack', emptyPlural: 'resource packs', summaryLabel: 'Installed resource packs', showToggle: false,
  });
}

// Call this instead of loadInstalledMods() directly whenever both lists
// need to be brought up to date (instance switch, install, delete, import).
async function refreshInstalledContent() {
  await Promise.all([loadInstalledMods(), loadInstalledResourcePacks()]);
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}
function fmtDownloads(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M ↓`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K ↓`;
  return `${n} ↓`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function searchMods() {
  const selVal = document.getElementById('mods-instance-select').value;
  const [instanceName, versionNumber, loader] = selVal.split('|');
  const query = document.getElementById('mods-search').value;
  const list = document.getElementById('mods-list');

  if (!versionNumber) { list.innerHTML = '<p class="dim">Create or select an instance first.</p>'; return; }

  list.innerHTML = '<p class="dim">Searching…</p>';
  try {
    const hits = await window.nebula.searchMods({ query, versionNumber, loader, projectType: currentType, source: currentSource });

    list.innerHTML = '';
    hits.forEach(hit => {
      const already = installedProjectIds.has(hit.project_id) || (hit.slug && installedProjectIds.has(hit.slug));
      const card = document.createElement('div');
      card.className = 'mod-card liquid-glass';
      card.innerHTML = `
        <div class="mc-art">
          <div class="mc-art-fallback">${(hit.title || '?').charAt(0).toUpperCase()}</div>
          ${hit.icon_url ? `<img src="${hit.icon_url}" alt="" onerror="this.remove();">` : ''}
          <div class="mc-src"><span class="src-mark modrinth-mark" style="width:9px;height:9px;"></span>Modrinth</div>
          ${hit.downloads ? `<div class="mc-downloads">${fmtDownloads(hit.downloads)}</div>` : ''}
        </div>
        <div class="mc-body">
          <div class="mc-name">${escapeHtml(hit.title)}</div>
          <div class="mc-desc">${escapeHtml(hit.description || '')}</div>
        </div>
        <div class="mc-foot">
          ${already
            ? `<button class="install-btn installed" disabled>Installed ✓</button>`
            : `<button class="install-btn">Install</button>`}
        </div>
      `;
      if (!already) {
        card.querySelector('.install-btn').addEventListener('click', () => installMod(hit, instanceName, versionNumber, loader));
      }
      list.appendChild(card);
    });
    if (!hits.length) list.innerHTML = '<p class="dim">No results for this version/loader.</p>';
  } catch (err) {
    list.innerHTML = `<p class="dim">${escapeHtml(err.message)}</p>`;
  }
}

/** Newest stable build; betas/alphas only when a project has nothing else. */
function pickModVersion(versions) {
  return versions.find(v => v.version_type === 'release') || versions[0];
}

async function installMod(hit, instanceName, versionNumber, loader) {
  if (currentType === 'modpack') return installModpack(hit, versionNumber);
  const installId = `install-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const versions = await window.nebula.modVersions({
      projectId: hit.project_id, versionNumber, loader,
      source: 'modrinth', projectType: currentType,
    });
    if (!versions.length) return showToast('No compatible file', `${hit.title} has no build for this version/loader.`, 'error');
    const pick = pickModVersion(versions);
    const f = pick.files.find(x => x.primary) || pick.files[0];
    const file = { url: f.url, filename: f.filename };
    const folder = currentType === 'resourcepack' ? 'resourcepacks' : 'mods';

    showDownloadBar(installId, hit.title);
    await window.nebula.installMod({
      fileUrl: file.url, fileName: file.filename, instanceName, versionNumber, folder, installId,
      projectId: hit.project_id, title: hit.title, iconUrl: hit.icon_url || '',
    });
  } catch (err) {
    removeDownloadBar(installId);
    showToast('Install failed', err.message, 'error');
  }
}
// A modpack becomes its own instance, so it's never "installed into" the
// selected one — the selected version is only a preference when the pack
// has builds for several Minecraft versions.
async function installModpack(hit, preferVersion) {
  const installId = `pack-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  showDownloadBar(installId, escapeHtml(hit.title));
  try {
    const res = await window.nebula.modpackInstall({
      projectId: hit.project_id, title: hit.title, iconUrl: hit.icon_url || '', preferVersion, installId,
    });
    finishModpackInstall(installId, res);
  } catch (err) {
    removeDownloadBar(installId);
    showToast('Modpack install failed', cleanIpcError(err), 'error');
  }
}

async function finishModpackInstall(installId, res) {
  removeDownloadBar(installId);
  if (!res) return;
  const missing = res.failed?.length ? ` ${res.failed.length} file(s) couldn't be downloaded.` : '';
  showToast('Modpack installed', `New instance "${res.name}" (${res.versionNumber} ${res.loader}) is selected and ready to play.${missing}`, missing ? 'error' : 'success');
  await refreshInstances();
  // Jump straight to the new instance's Library, so its mods and resource
  // packs are what's on screen instead of the previously selected instance.
  const val = `${res.name}|${res.versionNumber}|${res.loader}`;
  for (const id of ['launch-instance-select', 'mods-instance-select']) {
    const sel = document.getElementById(id);
    if (![...sel.options].some(o => o.value === val)) continue;
    sel.value = val;
    sel._refreshCustomSelect?.();
  }
  rememberInstance(val);
  updateLaunchState();
  modsMode = 'library';
  applyModsMode();
  await refreshInstalledContent();
}

function cleanIpcError(err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

window.nebula.onModpackProgress(({ installId, label, done, total }) => {
  if (!downloadBars.has(installId)) return;
  const bar = downloadBars.get(installId);
  const lab = bar.querySelector('.download-bar-label');
  if (lab && label) lab.textContent = label;
  updateDownloadBar(installId, total ? Math.round((done / total) * 100) : 0);
});

window.nebula.onModProgress(({ installId, percent, done }) => {
  updateDownloadBar(installId, percent);
  if (done) {
    setTimeout(() => {
      removeDownloadBar(installId);
      showToast('Download complete', 'Installed and ready to use', 'success');
      refreshInstalledContent();
      searchMods();
    }, 400);
  }
});

// =====================================================================
// FPS BOOST PACK — the honest way to raise in-game FPS: the well-known
// performance mod stack, installed in one click into a Fabric/Quilt
// instance. (JVM flags help stutter; these mods are what multiplies
// frame rate.) Slugs are Modrinth project slugs, which the API accepts
// anywhere a project id is accepted.
// =====================================================================
// (BOOST_PACK folded into PERF_STACKS above — one list per loader.)

document.getElementById('install-boost-btn').addEventListener('click', async () => {
  const selVal = document.getElementById('launch-instance-select').value;
  if (!selVal) return showToast('No instance selected', 'Create and select an instance first.', 'error');
  const [instanceName, versionNumber, loader] = selVal.split('|');
  const pack = perfStackFor(loader);
  if (!pack.length) {
    return showToast('Needs a mod loader', 'Vanilla can\u2019t load mods — create the instance with Fabric, Quilt or Forge.', 'error');
  }

  const btn = document.getElementById('install-boost-btn');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  let installed = 0, skipped = 0;

  // fetch version lists in parallel, then download sequentially so the
  // progress bars stay readable
  const lookups = await Promise.all(pack.map(async (m) => {
    try {
      const versions = await window.nebula.modVersions({ projectId: m.slug, versionNumber, loader });
      if (!versions.length) return null;
      const pick = pickModVersion(versions);
      const f = pick.files.find(x => x.primary) || pick.files[0];
      return { ...m, url: f.url, filename: f.filename };
    } catch { return null; }
  }));

  for (const m of lookups) {
    if (!m) { skipped++; continue; }
    const installId = `boost-${m.slug}-${Date.now()}`;
    try {
      showDownloadBar(installId, m.title);
      await window.nebula.installMod({
        fileUrl: m.url, fileName: m.filename, instanceName, versionNumber, folder: 'mods',
        installId, projectId: m.slug, title: m.title, iconUrl: '',
      });
      installed++;
    } catch {
      removeDownloadBar(installId);
      skipped++;
    }
  }

  // part two of the boost: write the consensus best-FPS settings for this
  // hardware into options.txt + sodium-options.json automatically
  let settingsNote = '';
  if (installed) {
    try {
      const info = await window.nebula.systemInfo();
      const res = await window.nebula.applyBestSettings({ instanceName, versionNumber, tier: info.tier });
      settingsNote = ` Best settings applied for your ${info.tier}-tier PC (${res.applied.slice(0, 4).join(', ')}…).`;
    } catch { /* settings write is best-effort */ }
  }

  btn.disabled = false;
  btn.textContent = 'Install';
  showToast('FPS Boost pack', `${installed} mod${installed !== 1 ? 's' : ''} installed${skipped ? `, ${skipped} not available for ${versionNumber}` : ''}.${settingsNote}`, installed ? 'success' : 'error');
  refreshInstalledContent();
});

// =====================================================================
// LAUNCH — full-screen liquid-glass overlay with progress + rotating tips,
// falls back to the inline bar if the user hides it.
// =====================================================================
const crashBanner = document.getElementById('crash-banner');
const launchProgress = document.getElementById('launch-progress');
const overlay = document.getElementById('launch-overlay');
const overlayFill = document.getElementById('overlay-fill');
const overlayLabel = document.getElementById('overlay-label');

const runningLaunches = new Map(); // launchId -> { instanceName, accountName }
const myLaunchIds = new Set();     // launches this window started (drive the overlay)
let latestLaunchId = null;         // most recent running launch (Stop targets this)
let overlayLaunchId = null;        // launch the overlay is following

const LAUNCH_TIPS = [
  'Tip: the FPS Boost pack in Settings can double or triple your frame rate.',
  'Tip: files pre-download in the background the moment you select an instance.',
  'Tip: press Ctrl+K anywhere for the command palette.',
  'Tip: drop any .jar into the auto-install folder to add it to every new instance.',
  'Tip: you can launch two accounts at once from the account menu.',
  'Tip: upload your own photo as the launcher background in Customize.',
  'Tip: Auto-tune in Settings reads your PC and picks the best settings for it.',
];
let tipTimer = null;
let overlayHidden = false;

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const mb = bps / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;
}

function spawnLaunchParticles() {
  if (!theme.animations) return;
  const host = document.getElementById('overlay-card') || overlay;
  if (!host) return;
  for (let i = 0; i < 10; i++) {
    const p = document.createElement('div');
    p.className = 'launch-particle';
    const angle = Math.random() * Math.PI * 2;
    const dist = 80 + Math.random() * 100;
    p.style.left = '50%'; p.style.top = '42%';
    p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.85 },
      { transform: `translate(calc(-50% + ${Math.cos(angle) * dist}px), calc(-50% + ${Math.sin(angle) * dist}px)) scale(0)`, opacity: 0 },
    ], { duration: 800 + Math.random() * 600, easing: 'cubic-bezier(0.1,0.8,0.3,1)' }).onfinish = () => p.remove();
    host.appendChild(p);
  }
}

function showOverlay(title, launchIdToFollow) {
  // Lets the stylesheet park the background animation while a full-screen
  // scrim is covering it -- nothing behind it is visible, so nothing behind
  // it should be costing frames.
  document.body.classList.add('modal-open');
  overlayHidden = false;
  overlayLaunchId = launchIdToFollow ?? null;
  document.getElementById('overlay-title').textContent = title;
  overlayLabel.textContent = 'Preparing…';
  overlayFill.style.width = '0%';
  overlayFill.classList.add('indeterminate');
  document.getElementById('overlay-speed').textContent = '';
  document.getElementById('overlay-pct').textContent = '';
  overlay.classList.add('show');
  const tipEl = document.getElementById('overlay-tip');
  let i = Math.floor(Math.random() * LAUNCH_TIPS.length);
  tipEl.textContent = LAUNCH_TIPS[i];
  clearInterval(tipTimer);
  tipTimer = setInterval(() => { i = (i + 1) % LAUNCH_TIPS.length; tipEl.textContent = LAUNCH_TIPS[i]; }, 5000);
  spawnLaunchParticles();
  clearInterval(Number(overlay.dataset.burst || 0));
  overlay.dataset.burst = String(setInterval(spawnLaunchParticles, 1400));
}
function hideOverlay() {
  document.body.classList.remove('modal-open');
  overlay.classList.remove('show');
  clearInterval(tipTimer);
  clearInterval(Number(overlay.dataset.burst || 0));
  clearTimeout(Number(overlay.dataset.hideSoon || 0));
  clearTimeout(Number(overlay.dataset.hideFallback || 0));
  overlay.dataset.burst = '';
  overlay.dataset.hideSoon = '';
  overlay.dataset.hideFallback = '';
}
document.getElementById('overlay-hide').addEventListener('click', () => {
  overlayHidden = true;
  hideOverlay();
  launchProgress.classList.remove('hidden');
});

// ---- main button: LAUNCH ⇄ STOP, plus "Launch another" ----
const launchBtn = document.getElementById('launch-btn');
const launchLabelEl = document.getElementById('launch-label');
const launchSubEl = document.getElementById('launch-sub');
const anotherBtn = document.getElementById('launch-another-btn');
const monitorChip = document.getElementById('monitor-chip');

// Tracks the last label so we only play the slide when it actually
// changes, not on every re-render.
let __lastLaunchLabel = '';

function playLabelSwap() {
  if (!launchBtn) return;
  launchBtn.classList.add('swapping');
  // let the out-slide play, then clear so the new text slides in
  setTimeout(() => launchBtn.classList.remove('swapping'), 180);
}

/** "Running 42s", "Running 5m 07s", "Running 1h 05m 07s". */
function runTimeLabel(info) {
  const s = Math.max(0, Math.floor((Date.now() - (info?.startedAt || Date.now())) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h) return `Running ${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m) return `Running ${m}m ${pad(sec)}s`;
  return `Running ${sec}s`;
}

setInterval(() => {
  if (!betaLayoutOn() || !launchBtn?.classList.contains('stop-state')) return;
  const info = runningLaunches.get(latestLaunchId);
  if (info) launchSubEl.textContent = runTimeLabel(info);
}, 1000);

function updateLaunchButtons() {
  const sel = document.getElementById('launch-instance-select');
  const hasSelection = !!sel.value;
  const anyRunning = runningLaunches.size > 0;

  if (anyRunning && latestLaunchId && runningLaunches.has(latestLaunchId)) {
    const info = runningLaunches.get(latestLaunchId);
    launchBtn.classList.add('stop-state');
    launchBtn.disabled = false;
    if (__lastLaunchLabel !== 'STOP') { playLabelSwap(); __lastLaunchLabel = 'STOP'; }
    launchLabelEl.textContent = 'STOP';
    if (betaLayoutOn()) {
      launchSubEl.textContent = runTimeLabel(info);
      launchSubEl.style.display = '';
    } else {
      // STOP shows only the word. The old subtitle ("... is running — click
      // to stop") is hidden so the red button reads as one clean word.
      launchSubEl.textContent = '';
      launchSubEl.style.display = 'none';
    }
    anotherBtn.classList.toggle('hidden', !(signedIn && hasSelection));
    monitorChip.classList.remove('hidden');
  } else {
    launchBtn.classList.remove('stop-state');
    if (__lastLaunchLabel === 'STOP') { playLabelSwap(); }
    __lastLaunchLabel = 'LAUNCH GAME';
    launchLabelEl.textContent = 'LAUNCH GAME';
    launchSubEl.style.display = '';   // subtitle returns for the launch state
    anotherBtn.classList.add('hidden');
    monitorChip.classList.add('hidden');
    if (!signedIn) { launchBtn.disabled = true; launchSubEl.textContent = 'Sign in to get started'; }
    else if (!hasSelection) { launchBtn.disabled = true; launchSubEl.textContent = 'Create an instance first'; }
    else {
      const [name, version, loader] = sel.value.split('|');
      launchBtn.disabled = false;
      // Version subtitle restored (I wrongly removed it). It shows the
      // instance name and is aligned flush-right via CSS below.
      launchSubEl.textContent = name.toUpperCase();
    }
  }
  paintLaunchArt();
}

// Every version gets its own launch-button artwork: a deterministic sky
// gradient, horizon band and voxel skyline derived from the version string
// itself, so 1.20.1 and 1.21 never look the same and the same version
// always looks the same. All generated here — no borrowed assets.
const LAUNCH_SKIES = [
  ['#4c2a86', '#8b5cf6', '#f0abfc'], // twilight nebula
  ['#0b3b5c', '#0ea5e9', '#a5f3fc'], // ice world
  ['#5c1f1f', '#f97316', '#fde68a'], // ember / nether
  ['#123f2e', '#22c55e', '#d9f99d'], // overgrowth
  ['#2a1b52', '#6366f1', '#c7d2fe'], // deep space
  ['#4a1d3d', '#ec4899', '#fbcfe8'], // cherry dusk
  ['#0f3a42', '#14b8a6', '#ccfbf1'], // ocean
  ['#3b2f10', '#eab308', '#fef08a'], // desert sun
];

// =====================================================================
// VERSION PLATE — same language as LAUNCH GAME: accent fill, thick black
// stroke, soft purple glow. Lined up on the launch column. Drawn once.
// =====================================================================
function versionWatermarkText() {
  if (typeof currentEdition !== 'undefined' && currentEdition === 'bedrock' && bedrockInfo) {
    const t = bedrockChannel === 'preview' ? bedrockInfo.preview : bedrockInfo.release;
    if (t && t.version) return String(t.version);
  }
  const sel = document.getElementById('launch-instance-select');
  return ((sel && sel.value || '').split('|')[1] || '').trim();
}

function placeVersionWatermark() {
  const host = document.getElementById('bg-version-watermark');
  const hero = document.getElementById('launchpad-hero');
  if (!host || !hero || !host.firstChild) return;
  const hr = hero.getBoundingClientRect();
  if (hr.width < 20) return;
  const bed = document.getElementById('bedrock-panel');
  const onBedrock = bed && !bed.classList.contains('hidden');
  const col = document.querySelector(onBedrock ? '#bedrock-panel' : '.launch-col');
  const btn = document.getElementById(onBedrock ? 'bedrock-launch-btn' : 'launch-btn');
  if (!btn) return;
  const br = btn.getBoundingClientRect();
  const cr = (col || btn).getBoundingClientRect();
  // Sit on the launch column, sized to the button so it frames it cleanly.
  const w = Math.round(Math.min(hr.width * 0.78, Math.max(cr.width * 1.18, br.width * 1.22)));
  host.style.left = (cr.left + cr.width / 2 - hr.left) + 'px';
  host.style.top = (br.top + br.height / 2 - hr.top) + 'px';
  host.style.setProperty('--wm-w', w + 'px');
}

function renderWatermark(host, text) {
  text = String(text || '').trim();
  if (!host) return;
  if (!text) { host.textContent = ''; delete host.dataset.wm; return; }

  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#9d6bff';
  const accent2 = css.getPropertyValue('--accent2').trim() || '#e561d8';
  const sig = 'v7|' + text + '|' + accent + '|' + accent2;
  if (host.dataset.wm === sig && host.firstChild) return;

  const toRgb = (hex) => {
    const v = String(hex).trim().replace('#', '');
    const n = v.length === 3 ? v.split('').map(c => c + c) : [v.slice(0, 2), v.slice(2, 4), v.slice(4, 6)];
    const out = n.map(x => parseInt(x, 16));
    return out.some(Number.isNaN) ? [157, 107, 255] : out;
  };
  const hex = (rgb) => '#' + rgb.map(c => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => hex(toRgb(a).map((c, i) => c + (toRgb(b)[i] - c) * t));

  const VB_W = 1000;
  const track = text.length > 7 ? -3 : text.length > 4 ? -1 : 1;
  const probe = document.createElement('canvas').getContext('2d');
  const widthAt = (size) => {
    probe.font = `900 ${size}px 'Segoe UI Black', 'Segoe UI', 'Arial Black', sans-serif`;
    if ('letterSpacing' in probe) probe.letterSpacing = track + 'px';
    return probe.measureText(text).width;
  };
  let size = 300;
  const measured = widthAt(size);
  if (measured > 0) size = Math.max(170, Math.min(340, Math.round(size * 880 / measured)));

  // Same recipe as Launch Game / chips: white face, fat black stroke, purple depth.
  const DEPTH = 14, DX = 0.95, DY = 1.2;
  const faceX = VB_W / 2 - (DEPTH * DX) / 2;
  const baseline = Math.round(size * 0.84 + 30);
  const VB_H = Math.round(baseline + DEPTH * DY + 30);

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.overflow = 'visible';

  renderWatermark.n = (renderWatermark.n || 0) + 1;
  const id = (k) => `wm${renderWatermark.n}-${k}`;
  const G = `#${id('glyphs')}`;

  let layers = '';
  for (let i = DEPTH; i >= 1; i--) {
    const t = i / DEPTH;
    const col = mix(mix(accent, accent2, 0.4), mix(accent, '#06040c', 0.8), t);
    layers += `<use href="${G}" transform="translate(${(i * DX).toFixed(2)},${(i * DY).toFixed(2)})" fill="${col}"/>`;
  }

  svg.innerHTML = `
    <defs>
      <text id="${id('glyphs')}" x="${faceX.toFixed(1)}" y="${baseline}" text-anchor="middle"
            font-family="'Segoe UI Black', 'Segoe UI', 'Arial Black', sans-serif"
            font-size="${size}" font-weight="900" letter-spacing="${track}">${escapeHtml(text)}</text>
      <filter id="${id('shadow')}" x="-20%" y="-20%" width="150%" height="160%">
        <feGaussianBlur stdDeviation="7"/>
      </filter>
    </defs>
    <use href="${G}" transform="translate(${(DEPTH * DX + 5).toFixed(1)},${(DEPTH * DY + 10).toFixed(1)})"
         fill="#000" opacity="0.5" filter="url(#${id('shadow')})"/>
    ${layers}
    <use class="wm-rim" href="${G}" fill="#ffffff"
         stroke="#000" stroke-width="20" stroke-linejoin="round" paint-order="stroke fill"/>
  `;

  host.textContent = '';
  host.dataset.wm = sig;
  host.appendChild(svg);
}

function paintLaunchArt() {
  const art = document.getElementById('launch-art');
  const stars = document.getElementById('launch-art-stars');
  const badge = document.getElementById('launch-badge');
  if (!art) return;

  const sel = document.getElementById('launch-instance-select');
  const [, version, loader] = (sel?.value || '').split('|');
  if (betaLayoutOn()) {
    art.style.backgroundImage = '';
    stars.style.backgroundImage = '';
    const wmBeta = document.getElementById('bg-version-watermark');
    if (wmBeta) { wmBeta.textContent = ''; delete wmBeta.dataset.wm; }
    // Corner tag on the launch panel: version + loader, same layout as the title-bar Beta tag.
    let ver = version, load = (loader || 'vanilla');
    if (typeof currentEdition !== 'undefined' && currentEdition === 'bedrock' && bedrockInfo) {
      const t = bedrockChannel === 'preview' ? bedrockInfo.preview : bedrockInfo.release;
      if (t && t.version) ver = String(t.version);
      load = bedrockChannel === 'preview' ? 'preview' : 'bedrock';
    }
    if (!ver || !badge) { badge?.classList.add('hidden'); return; }
    document.getElementById('lb-ver').textContent = ver;
    document.getElementById('lb-loader').textContent = String(load).toUpperCase();
    badge.className = `launch-badge loader-${String(load).toLowerCase()}`;
    return;
  }
  if (!version) {
    art.style.backgroundImage = '';
    stars.style.backgroundImage = '';
    const wmOff = document.getElementById('bg-version-watermark');
    if (wmOff) wmOff.textContent = '';
    badge.classList.add('hidden');
    return;
  }
  badge.classList.remove('hidden');

  // #bg-version-watermark is declared in index.html and styled at
  // style.css:2079, but no code ever set its text — so the big version
  // number behind the panel never appeared.
  const wm = document.getElementById('bg-version-watermark');
  if (wm) renderWatermark(wm, version);

  document.getElementById('lb-ver').textContent = version;
  document.getElementById('lb-loader').textContent = (loader || 'vanilla').toUpperCase();
  badge.className = `launch-badge loader-${(loader || 'vanilla').toLowerCase()}`;

  const h = hashStr(version);

  // SKY FOLLOWS THE ACCENT, not a hash-picked palette.
  //
  // LAUNCH_SKIES maps a version hash onto one of eight fixed palettes.
  // "1.21.11" hashes to index 2 — "ember / nether" — so the hero came
  // out orange regardless of the theme, which is why it never matched
  // the purple reference. A version number has no relationship to what
  // colour the app should be; the accent does.
  //
  // The hash still drives the horizon height, sun position and skyline
  // shape below, so different versions still look distinct — they are
  // just distinct within the user's own palette now.
  const accentHex = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent').trim() || '#9d6bff';
  const accent2Hex = getComputedStyle(document.documentElement)
    .getPropertyValue('--accent2').trim() || '#e561d8';

  const toRgb = (hex) => {
    const v = hex.replace('#', '');
    const n = v.length === 3 ? v.split('').map(c => c + c) : [v.slice(0,2), v.slice(2,4), v.slice(4,6)];
    return n.map(x => parseInt(x, 16));
  };
  const mixHex = (a, b, t) => {
    const A = toRgb(a), B = toRgb(b);
    return '#' + A.map((c, i) => Math.round(c + (B[i] - c) * t)
      .toString(16).padStart(2, '0')).join('');
  };
  const shade = (hex, f) => '#' + toRgb(hex)
    .map(c => Math.max(0, Math.min(255, Math.round(c * f))).toString(16).padStart(2, '0')).join('');

  // deep: a dark, desaturated version of the accent for the upper sky
  // mid:  accent blended toward accent2 at the horizon
  // glow: the sun, near-white but tinted
  const deep = shade(mixHex(accentHex, '#2a1030', 0.62), 0.85);
  const mid  = mixHex(accentHex, accent2Hex, 0.55);
  const glow = mixHex(accent2Hex, '#ffffff', 0.55);

  // horizon height and sun position shift per version too
  const horizon = 62 + (h >> 3) % 14;
  const sunX = 12 + (h >> 6) % 76;

  art.style.backgroundImage = [
    `radial-gradient(56px 56px at ${sunX}% ${horizon - 26}%, ${glow}, transparent 70%)`,
    `linear-gradient(180deg, ${deep} 0%, ${mid} ${horizon}%, ${deep} 100%)`,
  ].join(',');

  // voxel skyline: a row of blocks whose heights come from the hash, so it
  // reads as a pixel landscape rather than a gradient wash
  let s2 = (h ^ 0x9e3779b9) >>> 0;
  const rnd = () => (s2 = (s2 * 1664525 + 1013904223) >>> 0) / 4294967296;
  const cols = 26;
  const silhouette = shade(deep, 0.66);   // dark enough to read, not a black wall
  const blocks = [];
  for (let i = 0; i < cols; i++) {
    const w = 100 / cols;
    const bh = 4 + Math.round(rnd() * 11);  // shorter blocks, closer to the reference
    // Blocks are a SILHOUETTE, not the sky colour.
    //
    // They were filled with `deep` — the same colour as the top and
    // bottom of the sky gradient — so at the horizon, where the sky is
    // `mid`, they showed faintly, and everywhere else they vanished
    // entirely. The reference has them as a crisp dark skyline, which
    // needs a tone clearly darker than anything behind them.
    blocks.push(`linear-gradient(${silhouette}, ${silhouette}) ${i * w}% ${100 - bh}% / ${w}% ${bh}% no-repeat`);
  }
  const starPts = [];
  for (let i = 0; i < 18; i++) {
    starPts.push(`radial-gradient(1.5px 1.5px at ${Math.round(rnd() * 100)}% ${Math.round(rnd() * horizon * 0.8)}%, rgba(255,255,255,${(0.3 + rnd() * 0.5).toFixed(2)}), transparent 60%)`);
  }
  stars.style.background = [...starPts, ...blocks].join(',');
}

launchBtn.addEventListener('click', async () => {
  if (launchBtn.classList.contains('stop-state') && latestLaunchId) {
    // Show feedback ON THE LABEL (the subtitle is hidden in stop-state),
    // disable the button so a second click can't double-fire the stop,
    // and keep the red glass while it winds down.
    launchLabelEl.textContent = 'STOPPING…';
    launchBtn.disabled = true;
    try {
      await window.nebula.stopGame(latestLaunchId);
    } catch (e) {
      // if stop fails, restore the STOP label so the user can retry
      launchLabelEl.textContent = 'STOP';
      launchBtn.disabled = false;
    }
    return;
  }
  launchInstance();
});
anotherBtn.addEventListener('click', () => launchInstance());
monitorChip.addEventListener('click', () => { if (latestLaunchId) window.nebula.openMonitor(latestLaunchId); });

// ---- perf mode chip (mirrors the Settings toggle) ----
const perfChip = document.getElementById('perf-chip');
function syncPerfChip() {
  perfChip.classList.toggle('off', !theme.perfMode);
  document.getElementById('perf-chip-state').textContent = theme.perfMode ? 'ON' : 'OFF';
  const settingsToggle = document.getElementById('perf-toggle');
  if (settingsToggle) settingsToggle.checked = !!theme.perfMode;
}
perfChip.addEventListener('click', () => {
  theme.perfMode = !theme.perfMode;
  saveTheme(); syncPerfChip();
  showToast('Performance mode', theme.perfMode ? 'Tuned Java flags will be used on the next launch.' : 'Launching with stock Java flags.', 'info');
});

// ---- faster launch chip (beta) ----
// Beta-only: the chip stays hidden and the feature stays off unless this is a
// -beta build. Both channels ship the same code; only beta turns it on.
const fastLaunchChip = document.getElementById('fastlaunch-chip');
var FASTER_LAUNCH_BUILD = false;
function syncFastLaunchChip() {
  const on = !!theme.fasterLaunch;
  fastLaunchChip.classList.toggle('off', !on);
  document.getElementById('fastlaunch-chip-state').textContent = on ? 'ON' : 'OFF';
}
var preloadSyncTimer = null;
function syncPreload(now = false) {
  if (!FASTER_LAUNCH_BUILD) return;
  clearTimeout(preloadSyncTimer);
  preloadSyncTimer = setTimeout(() => {
    const sel = document.getElementById('launch-instance-select');
    let args = null;
    if (theme.fasterLaunch && signedIn && sel?.value) {
      const [instanceName, versionNumber, loader] = sel.value.split('|');
      const memoryMaxGB = theme.memMax || 4;
      const memoryMinGB = Math.min(theme.memMin || 2, memoryMaxGB);
      args = { instanceName, versionNumber, loader, memoryMaxGB, memoryMinGB, performanceMode: !!theme.perfMode };
    }
    window.nebula.setPreload(args).catch(() => {});
  }, now ? 0 : 1200);
}
fastLaunchChip.addEventListener('click', () => {
  if (!FASTER_LAUNCH_BUILD) return;
  theme.fasterLaunch = !theme.fasterLaunch;
  saveTheme(); syncFastLaunchChip(); syncPreload(true);
  showToast('Faster launch', theme.fasterLaunch ? 'On' : 'Off', 'info');
});
syncFastLaunchChip();
// Reveal the chip only on beta builds; force the setting off on stable.
window.nebula.getAppVersion().then((v) => {
  FASTER_LAUNCH_BUILD = /-beta/i.test(String(v || ''));
  applyBetaLayout(FASTER_LAUNCH_BUILD);
  if (FASTER_LAUNCH_BUILD) {
    fastLaunchChip.classList.remove('hidden');
    syncPreload();
    maybeAskLegalAgreement();
  } else if (theme.fasterLaunch) {
    theme.fasterLaunch = false;
    saveTheme();
    syncFastLaunchChip();
  }
}).catch(() => { applyBetaLayout(false); });

// ---------- Terms of Service / Privacy Policy (beta) ----------
// Text comes from legal.js, generated by scripts/build-legal.js. Bumping its
// version makes everyone accept the new text once.
const LEGAL_ACCEPT_KEY = 'solar.legal.accepted';
let legalMode = 'view';

function showLegalDoc(doc) {
  const L = window.SOLAR_LEGAL;
  const body = document.getElementById('legal-body');
  if (!L || !body) return;
  body.innerHTML = doc === 'privacy' ? L.privacy : doc === 'rules' ? (L.rules || L.terms) : L.terms;
  body.scrollTop = 0;
  document.querySelectorAll('#legal-modal .legal-tab').forEach((t) => t.classList.toggle('active', t.dataset.doc === doc));
}

function openLegal(doc = 'terms', mode = 'view') {
  const L = window.SOLAR_LEGAL;
  const modal = document.getElementById('legal-modal');
  if (!L || !modal) return;
  legalMode = mode;
  const agree = mode === 'agree';
  modal.classList.toggle('legal-required', agree);
  document.getElementById('legal-modal-updated').textContent = `Last updated ${L.updated}`;
  document.getElementById('legal-intro').classList.toggle('hidden', !agree);
  document.getElementById('legal-agree-row').classList.toggle('hidden', !agree);
  document.getElementById('legal-quit').classList.toggle('hidden', !agree);
  document.getElementById('legal-agree-box').checked = false;
  const ok = document.getElementById('legal-ok');
  ok.textContent = agree ? 'I agree' : 'Close';
  ok.disabled = agree;
  showLegalDoc(doc);
  modal.classList.remove('hidden');
}

function closeLegal() {
  document.getElementById('legal-modal')?.classList.add('hidden');
  legalMode = 'view';
}

function maybeAskLegalAgreement() {
  const L = window.SOLAR_LEGAL;
  if (!L || localStorage.getItem(LEGAL_ACCEPT_KEY) === L.version) return;
  openLegal('terms', 'agree');
}

(function wireLegal() {
  const modal = document.getElementById('legal-modal');
  if (!modal) return;
  const ok = document.getElementById('legal-ok');
  const box = document.getElementById('legal-agree-box');
  modal.querySelectorAll('.legal-tab').forEach((t) => t.addEventListener('click', () => showLegalDoc(t.dataset.doc)));
  box.addEventListener('change', () => { if (legalMode === 'agree') ok.disabled = !box.checked; });
  ok.addEventListener('click', () => {
    if (legalMode === 'agree') {
      if (!box.checked) return;
      localStorage.setItem(LEGAL_ACCEPT_KEY, window.SOLAR_LEGAL.version);
    }
    closeLegal();
  });
  document.getElementById('legal-quit').addEventListener('click', () => window.nebula.closeWindow());
  modal.addEventListener('click', (e) => { if (e.target === modal && legalMode === 'view') closeLegal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legalMode === 'view' && !modal.classList.contains('hidden')) closeLegal();
  });
  // The documents link to each other and to outside sites; never navigate the launcher itself.
  document.getElementById('legal-body').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/terms\.html$/i.test(href)) showLegalDoc('terms');
    else if (/privacy\.html$/i.test(href)) showLegalDoc('privacy');
    else if (/rules\.html$/i.test(href)) showLegalDoc('rules');
    else if (/^https?:\/\//i.test(href)) window.open(href, '_blank');
  });
  document.getElementById('nav-legal')?.addEventListener('click', () => openLegal('terms'));
  document.getElementById('open-terms')?.addEventListener('click', () => openLegal('terms'));
  document.getElementById('open-privacy')?.addEventListener('click', () => openLegal('privacy'));
  document.getElementById('open-rules')?.addEventListener('click', () => openLegal('rules'));
  // "Rules" links next to chat boxes (some are drawn later, so delegate).
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-open-rules]')) return;
    e.preventDefault();
    openLegal('rules');
  });
  const updated = document.getElementById('legal-updated');
  if (updated && window.SOLAR_LEGAL) updated.textContent = window.SOLAR_LEGAL.updated;
})();

// ---------- Ban screen ----------
// Shown whenever the main process holds an active ban. It can't be closed
// except by quitting; game launches are refused in the main process too.
const SOLAR_DISCORD = 'https://discord.gg/h6XVyf2Pqd';

function fmtLeft(ms) {
  if (ms <= 0) return 'Ending now';
  const m = Math.ceil(ms / 60000);
  const parts = [];
  let left = m;
  for (const [nm, size] of [['y', 525600], ['mo', 43200], ['d', 1440], ['h', 60], ['m', 1]]) {
    const n = Math.floor(left / size);
    if (n) { parts.push(`${n}${nm}`); left -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '<1m';
}

(function wireBanScreen() {
  const screen = document.getElementById('ban-screen');
  if (!screen || !window.nebula?.banState) return;
  let ban = null;
  let tick = null;

  const paint = () => {
    if (!ban) return;
    const perm = !ban.until;
    document.getElementById('ban-title').textContent = perm ? "You're permanently banned from SolarClient" : "You're banned from SolarClient";
    document.getElementById('ban-who').textContent = ban.name ? `Account: ${ban.name}` : '';
    document.getElementById('ban-length').textContent = perm ? 'Permanent' : (ban.length || fmtLeft(ban.until - ban.at));
    document.getElementById('ban-ends').textContent = perm ? 'Never' : new Date(ban.until).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    document.getElementById('ban-left').textContent = perm ? 'Forever' : fmtLeft(ban.until - Date.now());
    document.getElementById('ban-reason').textContent = ban.reason || 'No reason given';
    document.getElementById('ban-id').textContent = ban.id ? `Ban ID ${ban.id}` : '';
    if (!perm && ban.until <= Date.now()) {
      // Time's up: ask the server, then unlock.
      clearInterval(tick); tick = null;
      document.getElementById('ban-left').textContent = 'Checking…';
      window.nebula.banRecheck().then(show).catch(() => {});
    }
  };

  function show(b) {
    ban = b && (b.until == null || b.until > Date.now() - 5000) ? b : null;
    document.body.classList.toggle('is-banned', !!ban);
    screen.classList.toggle('hidden', !ban);
    clearInterval(tick); tick = null;
    if (!ban) return;
    try { for (const k of ['admin', 'chat', 'online', 'updates']) if (scFloat.get(k)?.win) scDock(k, { shut: true }); } catch { /* not wired yet */ }
    document.getElementById('mod-modal')?.classList.add('hidden');
    document.getElementById('live-chat')?.classList.add('hidden');
    paint();
    if (ban.until) tick = setInterval(paint, 1000);
  }

  // Keyboard shortcuts (palette, etc.) stay off while banned.
  document.addEventListener('keydown', (e) => {
    if (!ban) return;
    if (e.target.closest?.('#legal-modal')) return;
    e.stopPropagation();
    if (e.key !== 'Tab') e.preventDefault();
  }, true);

  document.getElementById('ban-close').addEventListener('click', () => window.nebula.closeWindow());
  document.getElementById('ban-appeal').addEventListener('click', () => window.open(SOLAR_DISCORD, '_blank'));
  document.getElementById('ban-rules').addEventListener('click', () => openLegal('rules'));
  document.getElementById('ban-terms')?.addEventListener('click', () => openLegal('terms'));
  document.getElementById('ban-privacy')?.addEventListener('click', () => openLegal('privacy'));
  window.nebula.onBanState((b) => show(b));
  window.nebula.banState().then(show).catch(() => {});
})();

// ---------- Report a player ----------
const REPORT_REASONS = [
  ['hate', 'Hate speech or slurs', 'Racist, homophobic or other hateful words'],
  ['harassment', 'Harassment or bullying', 'Targeting, insulting or ganging up on someone'],
  ['threats', 'Threats or self-harm', 'Threats, or telling someone to hurt themselves'],
  ['sexual', 'Inappropriate content', 'Sexual messages, images or links'],
  ['spam', 'Spam or scams', 'Flooding chat, scam links or advertising'],
  ['personal', 'Sharing personal info', 'Real names, addresses, photos or doxxing'],
  ['impersonation', 'Impersonation', 'Pretending to be someone else or staff'],
  ['evasion', 'Ban evasion', 'Using another account to get around a ban'],
  ['cheating', 'Cheating or exploits', 'Hacks, exploits or messing with SolarClient'],
  ['other', 'Something else', 'Anything else that breaks the rules'],
];
const REPORT_MAX_FILES = 4;
const REPORT_MAX_BYTES = 25 * 1024 * 1024;
const REPORT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/webm']);
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

// ---------------------------------------------------------------------
// People everywhere (beta): a face or name opens that player's profile
// card, and a red flag beside other people's names reports them. Who an
// element points at is kept in a lookup table rather than in attributes,
// so message text never has to be escaped into HTML attributes.
// ---------------------------------------------------------------------
const FLAG_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V3h2v1h12l-2.5 4.5L19 13H7v8z"/></svg>';
const personKeys = new Map();
let personKeySeq = 0;
const safeName = (n) => String(n || 'Player').replace(/[^\w ]/g, '').slice(0, 32) || 'Player';
function personKey(uuid, name, context) {
  const key = String(++personKeySeq);
  personKeys.set(key, { uuid, name: safeName(name), context: context || null });
  if (personKeys.size > 4000) personKeys.delete(personKeys.keys().next().value);
  return key;
}
/** Attribute that makes an element open this player's profile when clicked. */
function personAttr(uuid, name) {
  const id = normVoiceId(uuid);
  return /^[0-9a-f]{32}$/.test(id) ? `data-person="${personKey(id, name)}"` : '';
}
/** Red flag button that reports this player. Nothing for yourself. */
function reportFlag(uuid, name, context) {
  const id = normVoiceId(uuid);
  if (!/^[0-9a-f]{32}$/.test(id) || id === myVoiceId()) return '';
  return `<button type="button" class="rflag beta-only" data-rflag="${personKey(id, name, context)}" title="Report ${safeName(name)}" aria-label="Report ${safeName(name)}">${FLAG_ICON}</button>`;
}
document.addEventListener('click', (e) => {
  if (!document.body.classList.contains('beta-layout')) return;
  const flag = e.target.closest?.('[data-rflag]');
  if (flag) {
    e.preventDefault();
    e.stopPropagation();
    const p = personKeys.get(flag.dataset.rflag);
    if (p) openReport(p);
    return;
  }
  const el = e.target.closest?.('[data-person]');
  if (!el || e.target.closest('input, textarea, select')) return;
  const p = personKeys.get(el.dataset.person);
  if (!p) return;
  e.preventDefault();
  e.stopPropagation();
  openProfile(p);
}, true);

// Your profile card shows your launcher background (built-in ones only, not
// your own picture) and your accent colour to everyone else.
function syncProfileLook() {
  clearTimeout(window.__profileLookTimer);
  window.__profileLookTimer = setTimeout(() => {
    window.nebula.profileSetMeta?.({ bg: theme.bg === 'custom' ? 'custom' : String(theme.bg || 'nebula'), color: currentAccent().a })
      .catch(() => {});
  }, 1200);
}
syncProfileLook();

function pfRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

async function profileBanner(bg, color) {
  const c = /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#8b5cf6';
  const tint = `linear-gradient(180deg, rgba(0,0,0,0) 30%, ${pfRgba(c, 0.5)} 100%)`;
  if (bg && !['nebula', 'void', 'custom'].includes(bg)) {
    try { await ensureBackgrounds(); } catch { /* fall back to the colour wash */ }
    const scene = window.NEBULA_BACKGROUNDS?.[bg];
    if (scene?.kind === 'scene' && typeof scene.make === 'function') {
      sceneCache[bg] ||= scene.make();
      return { image: `${tint}, ${sceneCache[bg]}`, size: 'cover, cover', position: 'center, center bottom', pixel: true };
    }
  }
  if (bg === 'void') return { image: `${tint}, linear-gradient(180deg, #07060d, #0d0b16)`, size: 'cover', position: 'center' };
  return {
    image: `radial-gradient(120% 150% at 15% 0%, ${pfRgba(c, 0.9)} 0%, rgba(0,0,0,0) 60%), radial-gradient(90% 130% at 95% 100%, ${pfRgba(c, 0.55)} 0%, rgba(0,0,0,0) 65%), linear-gradient(135deg, #140c28, #06040c)`,
    size: 'cover', position: 'center',
  };
}

const PF_LOCK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7A5 5 0 0 0 7 7v2H5v13h14V9zm-8-2a3 3 0 0 1 6 0v2H9zm4 9.7V19h-2v-2.3a2 2 0 1 1 2 0z"/></svg>';
let profileSeq = 0;

async function openProfile({ uuid, name }) {
  const id = normVoiceId(uuid);
  if (!/^[0-9a-f]{32}$/.test(id)) return;
  document.querySelector('.fr-menu, .people-menu')?.remove();
  let wrap = document.querySelector('.pf-overlay');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'pf-overlay';
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeProfile(); });
    document.body.appendChild(wrap);
  }
  const my = ++profileSeq;
  let tab = 'followers';
  wrap.innerHTML = `
    <div class="pf-card" role="dialog" aria-label="Profile">
      <div class="pf-banner"></div>
      <button type="button" class="pf-x" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>
      <div class="pf-top">
        <img class="pf-face" src="${frAvatar(id)}" alt="">
        <div class="pf-id"><div class="pf-name">${escapeHtml(safeName(name))}</div><div class="pf-status">Loading…</div></div>
      </div>
      <div class="pf-body"><div class="pf-note">Loading profile…</div></div>
    </div>`;
  wrap.querySelector('.pf-x').addEventListener('click', closeProfile);
  const card = wrap.querySelector('.pf-card');
  const body = wrap.querySelector('.pf-body');

  let data;
  try { data = await window.nebula.profileGet({ uuid: id }); }
  catch (err) {
    if (my !== profileSeq) return;
    wrap.querySelector('.pf-status').textContent = '';
    body.innerHTML = `<div class="pf-note">${escapeHtml(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))}</div>`;
    return;
  }
  if (my !== profileSeq) return;

  const color = /^#[0-9a-f]{6}$/i.test(data.color || '') ? data.color : '#8b5cf6';
  card.style.setProperty('--pf-c', color);
  profileBanner(data.bg, color).then((b) => {
    if (my !== profileSeq) return;
    const el = wrap.querySelector('.pf-banner');
    el.style.backgroundImage = b.image;
    el.style.backgroundSize = b.size;
    el.style.backgroundPosition = b.position;
    el.classList.toggle('pixel', !!b.pixel);
  });

  const paint = () => {
    const statusLabel = data.status === 'in_game' ? 'In game' : data.status === 'online' ? 'Online' : 'Offline';
    const role = data.role && data.role !== 'member'
      ? `<span class="lc-role" data-role="${escapeHtml(String(data.role).toLowerCase())}">${escapeHtml(data.role)}</span>` : '';
    wrap.querySelector('.pf-name').innerHTML = `${escapeHtml(safeName(data.name))}${role}`;
    wrap.querySelector('.pf-status').innerHTML = `<i class="pf-dot ${escapeHtml(data.status)}"></i>${statusLabel}${data.followsYou && !data.self ? '<span class="pf-tag">Follows you</span>' : ''}`;
    const friends = data.youFollow && data.followsYou;
    const actions = data.self ? '' : data.youBlocked
      ? `<button type="button" class="pf-btn" data-act="unblock">Unblock</button>
         <button type="button" class="pf-btn danger" data-act="report">${FLAG_ICON}Report</button>`
      : `<button type="button" class="pf-btn ${data.youFollow ? '' : 'primary'}" data-act="${data.youFollow ? 'unfollow' : 'follow'}">${data.youFollow ? 'Following' : data.followsYou ? 'Follow back' : 'Follow'}</button>
         ${friends ? '<button type="button" class="pf-btn" data-act="dm">Message</button>' : ''}
         <button type="button" class="pf-btn" data-act="block">Block</button>
         <button type="button" class="pf-btn danger" data-act="report">${FLAG_ICON}Report</button>`;
    const stat = (key, n, label) => `
      <button type="button" class="pf-stat ${tab === key ? 'on' : ''}" data-tab="${key}">
        <b>${Number(n) || 0}</b><span>${label}</span>
      </button>`;
    const people = data.lists ? data.lists[tab] : null;
    const listHtml = !data.lists
      ? `<div class="pf-private">${PF_LOCK}<span>${data.private ? `${escapeHtml(safeName(data.name))} keeps who follows them and who they follow private.` : "You can't see who follows this player."}</span></div>`
      : !people.length
        ? `<div class="pf-note">${tab === 'followers' ? 'No followers yet.' : 'Not following anyone yet.'}</div>`
        : people.map((p) => `
          <div class="pf-row" ${personAttr(p.uuid, p.name)}>
            <img class="pf-row-face" src="${frAvatar(p.uuid)}" alt="">
            <span class="pf-row-name">${escapeHtml(safeName(p.name))}</span>
            ${p.role && p.role !== 'member' ? `<span class="lc-role" data-role="${escapeHtml(String(p.role).toLowerCase())}">${escapeHtml(p.role)}</span>` : ''}
            ${normVoiceId(p.uuid) === myVoiceId() ? '<span class="pf-tag">You</span>' : ''}
          </div>`).join('');
    body.innerHTML = `
      ${actions ? `<div class="pf-actions">${actions}</div>` : ''}
      ${data.self ? `
        <label class="pf-private-toggle">
          <span class="pf-private-txt"><b>Private profile</b><em>Hide who follows you and who you follow. People still see the counts.</em></span>
          <span class="toggle"><input type="checkbox" id="pf-private" ${data.private ? 'checked' : ''}><span class="toggle-track"><span class="toggle-thumb"></span></span></span>
        </label>
        <div class="pf-hint">Your card uses your launcher background and accent colour. Change them in Customize.</div>` : ''}
      <div class="pf-stats">${stat('followers', data.followers, 'Followers')}${stat('following', data.following, 'Following')}</div>
      <div class="pf-list">${listHtml}</div>`;
    body.querySelectorAll('.pf-stat').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; paint(); }));
    body.querySelector('#pf-private')?.addEventListener('change', async (e) => {
      try {
        await window.nebula.profileSetMeta({ private: e.target.checked });
        data.private = e.target.checked;
        const set = document.getElementById('set-private-profile');
        if (set) set.checked = data.private;
      } catch (err) { showToast("Couldn't save", err?.message || String(err), 'error'); }
    });
    body.querySelectorAll('.pf-btn').forEach((b) => b.addEventListener('click', () => profileAction(b.dataset.act)));
    body.querySelectorAll('.pf-row-face, .pf-face').forEach((img) => { img.onerror = () => { img.style.visibility = 'hidden'; }; });
  };

  const refresh = async () => {
    try { const next = await window.nebula.profileGet({ uuid: id }); if (my === profileSeq) { data = next; paint(); } } catch { /* keep what's shown */ }
  };
  async function profileAction(act) {
    const who = { uuid: id, name: data.name };
    try {
      if (act === 'follow') { await window.nebula.friendsFollow(who); showToast('Following', safeName(data.name), 'success'); }
      if (act === 'unfollow') await window.nebula.friendsUnfollow({ uuid: id });
      if (act === 'unblock') await window.nebula.friendsUnblock({ uuid: id });
      if (act === 'report') { closeProfile(); openReport(who); return; }
      if (act === 'dm') { closeProfile(); switchView('friends'); openConversation({ kind: 'dm', id, name: data.name }); return; }
      if (act === 'block') {
        const ok = await showConfirm(
          `Block ${safeName(data.name)}? They'll be removed from your friends and won't be able to follow or message you.`,
          { title: 'Block?', confirmLabel: 'Block' });
        if (!ok) return;
        await window.nebula.friendsBlock({ uuid: id });
      }
      setTimeout(refresh, 350);
    } catch (err) { showToast('Failed', err?.message || String(err), 'error'); }
  }
  paint();
}

function closeProfile() {
  profileSeq++;
  document.querySelector('.pf-overlay')?.remove();
  for (const d of scPop.docs) d.querySelector('.pf-overlay')?.remove();
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.pf-overlay')) closeProfile();
});

let reportApi = null;
function openReport(person) { reportApi?.open(person); }

(function wireReport() {
  const modal = document.getElementById('report-modal');
  if (!modal || !window.nebula?.reportSend) return;
  const form = document.getElementById('report-form');
  const reasonsEl = document.getElementById('report-reasons');
  const details = document.getElementById('report-details');
  const count = document.getElementById('report-count');
  const drop = document.getElementById('report-drop');
  const picker = document.getElementById('report-files');
  const fileList = document.getElementById('report-file-list');
  const status = document.getElementById('report-status');
  const go = document.getElementById('report-go');
  let target = null;
  let reason = null;
  let files = [];   // { file, url }
  let busy = false;

  reasonsEl.innerHTML = REPORT_REASONS.map(([id, label, hint]) => `
    <button type="button" class="report-reason" role="radio" aria-checked="false" data-r="${id}">
      <b>${escapeHtml(label)}</b><span>${escapeHtml(hint)}</span>
    </button>`).join('');

  const setStatus = (text, kind = '') => { status.textContent = text; status.className = `report-status ${kind}`; };
  const valid = () => !!reason && details.value.trim().length >= 10;
  const paintGo = () => { go.disabled = busy || !valid(); };

  function paintFiles() {
    fileList.innerHTML = files.map((f, i) => `
      <div class="report-file">
        ${f.file.type.startsWith('video/')
          ? `<video src="${f.url}" muted preload="metadata"></video><span class="report-file-kind">Video</span>`
          : `<img src="${f.url}" alt="">`}
        <div class="report-file-meta"><span title="${escapeHtml(f.file.name)}">${escapeHtml(f.file.name)}</span><b>${fmtSize(f.file.size)}</b></div>
        <button type="button" class="report-file-x" data-i="${i}" title="Remove" aria-label="Remove">&times;</button>
      </div>`).join('');
    drop.classList.toggle('full', files.length >= REPORT_MAX_FILES);
  }

  function addFiles(list) {
    for (const file of list) {
      if (files.length >= REPORT_MAX_FILES) { setStatus(`You can attach up to ${REPORT_MAX_FILES} files.`, 'bad'); break; }
      if (!REPORT_TYPES.has(file.type)) { setStatus(`${file.name} isn't an image or video we can take.`, 'bad'); continue; }
      if (file.size > REPORT_MAX_BYTES) { setStatus(`${file.name} is over 25 MB.`, 'bad'); continue; }
      files.push({ file, url: URL.createObjectURL(file) });
    }
    paintFiles();
  }

  function clearFiles() {
    for (const f of files) URL.revokeObjectURL(f.url);
    files = [];
    paintFiles();
  }

  function close() {
    if (busy) return;
    modal.classList.add('hidden');
    clearFiles();
  }

  reportApi = {
    open({ uuid, name, context } = {}) {
      const id = normVoiceId(uuid);
      if (!/^[0-9a-f]{32}$/.test(id)) return;
      if (!friendsState?.connected) { showToast('Report', 'Connect to SolarClient online to send a report.', 'error'); return; }
      if (id === myVoiceId()) { showToast('Report', "You can't report yourself.", 'error'); return; }
      target = { uuid: id, name: name || 'Player', context: context && context.text ? context : null };
      reason = null;
      details.value = '';
      count.textContent = '0 / 1000';
      clearFiles();
      setStatus('');
      reasonsEl.querySelectorAll('.report-reason').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); });
      document.getElementById('report-title').textContent = `Report ${target.name}`;
      document.getElementById('report-face').src = frAvatar(id);
      const ctx = document.getElementById('report-context');
      ctx.classList.toggle('hidden', !target.context);
      if (target.context) {
        document.getElementById('report-context-text').innerHTML =
          `<span>${escapeHtml(target.context.where)}</span>${escapeHtml(target.context.text)}`;
      }
      paintGo();
      modal.classList.remove('hidden');
    },
  };

  reasonsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.report-reason');
    if (!b) return;
    reason = b.dataset.r;
    reasonsEl.querySelectorAll('.report-reason').forEach((x) => {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
    paintGo();
  });
  details.addEventListener('input', () => {
    count.textContent = `${details.value.length} / 1000`;
    paintGo();
  });
  drop.addEventListener('click', () => { if (files.length < REPORT_MAX_FILES) picker.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); } });
  picker.addEventListener('change', () => { addFiles([...picker.files]); picker.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles([...(e.dataTransfer?.files || [])]);
  });
  fileList.addEventListener('click', (e) => {
    const x = e.target.closest('.report-file-x');
    if (!x) return;
    const [gone] = files.splice(Number(x.dataset.i), 1);
    if (gone) URL.revokeObjectURL(gone.url);
    paintFiles();
  });
  document.getElementById('report-close').addEventListener('click', close);
  document.getElementById('report-cancel').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!target) return;
    if (!reason) { setStatus('Pick what happened.', 'bad'); return; }
    if (details.value.trim().length < 10) { setStatus('Tell us a little more (at least 10 characters).', 'bad'); details.focus(); return; }
    busy = true; paintGo();
    go.textContent = files.length ? `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…` : 'Sending…';
    setStatus('');
    try {
      const payload = [];
      for (const f of files) payload.push({ name: f.file.name, data: new Uint8Array(await f.file.arrayBuffer()) });
      const res = await window.nebula.reportSend({
        target: target.uuid, targetName: target.name, reason, details: details.value.trim(),
        context: target.context, files: payload,
      });
      busy = false;
      close();
      showToast('Report sent', escapeHtml(`Thanks. The SolarClient team will look at it. Report ${res?.id || ''}`.trim()), 'success');
    } catch (err) {
      setStatus(String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'bad');
    } finally {
      busy = false;
      go.textContent = 'Send report';
      paintGo();
    }
  });
})();

// ---------- shared chat helpers (beta) ----------
// Live chat and communities share one message format. The server only stores
// plain text, so replies, mentions and formatting are conventions in the text
// that older launchers still show as readable plain text.

function myName() {
  return friendsState?.self?.name || window.__myAccountName || '';
}
window.nebula.currentAccount?.().then((a) => { if (a?.name) window.__myAccountName = a.name; }).catch(() => {});

const SC_REPLY_RE = /^> @([A-Za-z0-9_]{2,16}) ([^\n]*)\n([\s\S]+)$/;
/** "> @Name quoted text\nreply" -> { to, quote, body } or null. */
function scParseReply(text) {
  const m = SC_REPLY_RE.exec(String(text || ''));
  return m ? { to: m[1], quote: m[2], body: m[3] } : null;
}
function scReplyText(to, quote, body, max) {
  const clean = String(quote || '').replace(/^> @\w+ [^\n]*\n/, '').replace(/\s+/g, ' ').trim();
  const head = `> @${to} `;
  const room = Math.max(0, Math.min(70, max - head.length - body.length - 2));
  const q = clean.length > room ? `${clean.slice(0, Math.max(0, room - 1))}…` : clean;
  return `${head}${q}\n${body}`;
}

const SC_SHORTCODES = {
  ':)': '🙂', ':D': '😄', ';)': '😉', ':(': '🙁', ':P': '😛', '<3': '❤️',
  ':fire:': '🔥', ':skull:': '💀', ':heart:': '❤️', ':thumbsup:': '👍', ':+1:': '👍', ':joy:': '😂',
  ':sob:': '😭', ':eyes:': '👀', ':pray:': '🙏', ':100:': '💯', ':tada:': '🎉', ':gg:': '🎮',
  ':pick:': '⛏️', ':sword:': '🗡️', ':diamond:': '💎', ':creeper:': '💚', ':clap:': '👏', ':wave:': '👋',
};
/** Turns :fire:-style codes into emoji before a message is sent. */
function scShortcodes(text) {
  return String(text || '').replace(/(^|\s)(:[a-z0-9+_]+:|:\)|:D|;\)|:\(|:P|<3)(?=\s|$)/g, (m, pre, code) => (SC_SHORTCODES[code] ? pre + SC_SHORTCODES[code] : m));
}

const SC_EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*){1,3}$/u;

/** Message text -> safe HTML with links, mentions, **bold**, *italic*, __underline__, ~~strike~~, ||spoiler|| and `code`. */
function scRich(text, { me = myName() } = {}) {
  const s = String(text ?? '');
  const meLow = String(me || '').toLowerCase();
  const inline = (raw) => {
    let out = escapeHtml(raw);
    out = out.replace(/\|\|(.+?)\|\|/g, '<span class="sc-spoiler" tabindex="0" title="Click to show">$1</span>');
    out = out.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    out = out.replace(/__(.+?)__/g, '<u>$1</u>');
    out = out.replace(/~~(.+?)~~/g, '<s>$1</s>');
    out = out.replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<i>$2</i>');
    out = out.replace(/(^|[^\w@])@([A-Za-z0-9_]{2,16})\b/g, (m, pre, n) =>
      `${pre}<span class="sc-mention${n.toLowerCase() === meLow || n.toLowerCase() === 'everyone' ? ' me' : ''}">@${n}</span>`);
    return out;
  };
  const withLinks = (raw) => {
    let out = '';
    let last = 0;
    for (const m of raw.matchAll(MSG_LINK_RE)) {
      const url = m[0].replace(/[.,!?;:)\]}]+$/, '');
      out += inline(raw.slice(last, m.index));
      out += `<a class="msg-link" href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
      last = m.index + url.length;
    }
    return out + inline(raw.slice(last));
  };
  let html = '';
  let last = 0;
  for (const m of s.matchAll(/```([\s\S]+?)```|`([^`\n]+)`/g)) {
    html += withLinks(s.slice(last, m.index));
    html += m[1] != null ? `<pre class="sc-code">${escapeHtml(m[1].replace(/^\n/, ''))}</pre>` : `<code class="sc-code">${escapeHtml(m[2])}</code>`;
    last = m.index + m[0].length;
  }
  return html + withLinks(s.slice(last));
}

/** Does this message mention me (or @everyone)? */
function scMentionsMe(text, me = myName()) {
  if (!me) return false;
  const low = String(text || '').toLowerCase();
  const name = me.toLowerCase();
  return new RegExp(`(^|[^\\w@])@(${name.replace(/[^a-z0-9_]/g, '')}|everyone)\\b`).test(low);
}

document.addEventListener('click', (e) => {
  const sp = e.target.closest?.('.sc-spoiler');
  if (sp) { sp.classList.add('shown'); e.stopPropagation(); }
}, true);

/** A small floating menu at a point: items are [label, fn, opts] or '-' for a divider. */
function scMenu(x, y, items, { title } = {}) {
  document.querySelector('.sc-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'sc-menu';
  if (title) menu.innerHTML = `<div class="sc-menu-title">${escapeHtml(title)}</div>`;
  for (const it of items) {
    if (it === '-') { menu.insertAdjacentHTML('beforeend', '<div class="sc-menu-sep"></div>'); continue; }
    const [label, fn, opts = {}] = it;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sc-menu-item${opts.danger ? ' danger' : ''}${opts.on ? ' on' : ''}`;
    b.innerHTML = `<span>${escapeHtml(label)}</span>${opts.hint ? `<kbd>${escapeHtml(opts.hint)}</kbd>` : ''}${opts.check ? `<i class="sc-check${opts.on ? ' on' : ''}"></i>` : ''}`;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); if (!opts.keep) menu.remove(); fn?.(b); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - mw - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - mh - 6))}px`;
  const dismiss = (ev) => {
    if (menu.contains(ev.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); dismiss({ target: document.body }); } };
  setTimeout(() => {
    document.addEventListener('mousedown', dismiss, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  return menu;
}

const SC_EMOJI = [
  ['Smileys', '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 😘 😋 😛 😜 🤪 😎 🤩 🥳 😏 😮 😲 😳 🥺 😢 😭 😤 😡 🤯 😱 🤔 🤫 🙄 😴 🤤 😬 🫠 💀 👻 🤖 👽'],
  ['Hands', '👍 👎 👏 🙌 👋 🤝 🙏 💪 ✌️ 🤞 👌 🤙 👀 🫡 🫶'],
  ['Game', '🎮 ⛏️ 🗡️ 🏹 🛡️ 💎 🔥 🧱 🌲 🪓 🧭 🗺️ 🏰 🐷 🐄 🐑 🐔 🐺 🐝 🍖 🍞 🍎 🎣 ⚔️ 🏆 🥇 🎯 🎲'],
  ['Symbols', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 ✨ ⭐ 🌟 ⚡ 💥 💫 🎉 🎊 ✅ ❌ ⚠️ ❓ ❗ 💬 🔔 🔇 🕐 📌 🚀 🌙 ☀️ 🌈'],
];
const SC_EMOJI_RECENT = 'sc.emoji.recent';
/** Emoji grid next to a button; calls onPick(emoji). */
function scEmojiPicker(anchor, onPick) {
  const old = document.querySelector('.sc-emoji');
  if (old) { old.remove(); if (old._anchor === anchor) return; }
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem(SC_EMOJI_RECENT) || '[]').slice(0, 16); } catch { recent = []; }
  const pop = document.createElement('div');
  pop.className = 'sc-emoji';
  pop._anchor = anchor;
  const groups = recent.length ? [['Recent', recent.join(' ')], ...SC_EMOJI] : SC_EMOJI;
  pop.innerHTML = `<input class="sc-emoji-q" placeholder="Search: fire, heart, sword…" maxlength="20">
    <div class="sc-emoji-scroll">${groups.map(([name, list]) => `<div class="sc-emoji-group">${name}</div><div class="sc-emoji-grid">${
    list.split(' ').filter(Boolean).map((e) => `<button type="button" data-e="${e}">${e}</button>`).join('')}</div>`).join('')}</div>`;
  document.body.appendChild(pop);
  const r = scRect(anchor);
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8))}px`;
  pop.style.top = `${r.top - ph - 8 > 8 ? r.top - ph - 8 : Math.min(r.bottom + 8, window.innerHeight - ph - 8)}px`;
  const names = Object.entries(SC_SHORTCODES).filter(([k]) => k.startsWith(':') && k.endsWith(':'));
  const q = pop.querySelector('.sc-emoji-q');
  q.addEventListener('input', () => {
    const v = q.value.trim().toLowerCase();
    const hits = new Set(names.filter(([k]) => k.includes(v)).map(([, e]) => e));
    pop.querySelectorAll('.sc-emoji-grid button').forEach((b) => b.classList.toggle('dim', !!v && !hits.has(b.dataset.e)));
  });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-e]');
    if (!b) return;
    e.stopPropagation();
    const em = b.dataset.e;
    try { localStorage.setItem(SC_EMOJI_RECENT, JSON.stringify([em, ...recent.filter((x) => x !== em)].slice(0, 16))); } catch { /* full */ }
    onPick(em);
    if (!e.shiftKey) pop.remove();
  });
  const dismiss = (ev) => {
    if (pop.contains(ev.target) || anchor.contains(ev.target)) return;
    pop.remove();
    document.removeEventListener('mousedown', dismiss, true);
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  setTimeout(() => q.focus(), 20);
}

/** Insert text at the caret of an input and keep focus there. */
function scInsert(input, text) {
  const a = input.selectionStart ?? input.value.length;
  const b = input.selectionEnd ?? input.value.length;
  const next = input.value.slice(0, a) + text + input.value.slice(b);
  if (input.maxLength > 0 && next.length > input.maxLength) return;
  input.value = next;
  input.focus();
  input.setSelectionRange(a + text.length, a + text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** @name suggestions while typing in a chat box. people() -> [{ uuid, name }]. */
function scMentionAuto(input, people) {
  const pop = document.createElement('div');
  pop.className = 'sc-mentions hidden sc-keep';
  document.body.appendChild(pop);
  let items = [];
  let sel = 0;
  const word = () => {
    const upto = input.value.slice(0, input.selectionStart ?? input.value.length);
    const m = /(^|\s)@([A-Za-z0-9_]{0,16})$/.exec(upto);
    return m ? { q: m[2], at: upto.length - m[2].length - 1 } : null;
  };
  const hide = () => { pop.classList.add('hidden'); items = []; };
  const paint = () => {
    pop.innerHTML = items.map((p, i) => `<button type="button" class="${i === sel ? 'sel' : ''}" data-i="${i}">
      <img src="${frAvatar(p.uuid)}" alt=""><span>${escapeHtml(p.name)}</span>${p.hint ? `<em>${escapeHtml(p.hint)}</em>` : ''}</button>`).join('');
    if (pop.ownerDocument !== input.ownerDocument) input.ownerDocument.body.appendChild(pop);
    const r = scRect(input);
    pop.classList.remove('hidden');
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.width = `${Math.round(Math.min(260, r.width))}px`;
    pop.style.top = `${Math.round(r.top - pop.offsetHeight - 6)}px`;
  };
  const pick = (p) => {
    const w = word();
    if (!w) return hide();
    const before = input.value.slice(0, w.at);
    const after = input.value.slice(input.selectionStart ?? input.value.length);
    input.value = `${before}@${p.name} ${after}`;
    const pos = before.length + p.name.length + 2;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    hide();
  };
  const update = () => {
    const w = word();
    if (!w) return hide();
    const q = w.q.toLowerCase();
    const seen = new Set();
    items = [{ uuid: '', name: 'everyone', hint: 'Notify everyone here' }, ...(people() || [])]
      .filter((p) => p?.name && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()) && p.name.toLowerCase().startsWith(q))
      .slice(0, 6);
    if (!items.length) return hide();
    sel = Math.min(sel, items.length - 1);
    paint();
  };
  input.addEventListener('input', update);
  input.addEventListener('click', update);
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (pop.classList.contains('hidden') || !items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopImmediatePropagation();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopImmediatePropagation();
      pick(items[sel]);
    } else if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      hide();
    }
  }, true);
  pop.addEventListener('mousedown', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    e.preventDefault();
    pick(items[Number(b.dataset.i)]);
  });
  return { hide, destroy: () => pop.remove() };
}

/** Short soft ping for a mention. */
function scPing() {
  try {
    const ctx = scPing.ctx ||= new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.26);
  } catch { /* no audio */ }
}

function scAgo(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Beta floating panels grow and shrink their contents with the box: text and
 * controls scale with the width between 80% and 122%, so a bigger box shows
 * bigger, not just emptier, and a small one never clips.
 */
function scPanelScale(panel, baseW) {
  if (!panel || panel._scScale) return;
  panel._scScale = true;
  const apply = () => {
    if (!betaLayoutOn()) { panel.style.removeProperty('--sc-zoom'); return; }
    const w = panel.offsetWidth;
    if (!w) return;
    let z = Math.max(0.8, Math.min(1.22, w / baseW));
    // Mid-resize it moves in 2.5% steps: re-sizing the text is the costly part, and every pixel is too often.
    if (panel.closest('.resizing')) z = Math.round(z * 40) / 40;
    panel.style.setProperty('--sc-zoom', z.toFixed(3));
    panel.classList.toggle('sc-wide', w / z >= 540);
    panel.classList.toggle('sc-narrow', w / z < 380);
  };
  new ResizeObserver(apply).observe(panel);
  panel._scZoom = apply;
  apply();
}

// ---------- Moderation panel (head mods + in-game admins) ----------
// Purely a view: every action is a request the server checks against the
// two mod accounts, so showing this to anyone else would get them nothing.
// Chromium before 128 reports rects inside a `zoom`ed box in that box's own
// units, so popups anchored to something in a scaled panel land in the wrong spot.
let scZoomLegacy = null;
/** getBoundingClientRect in real window pixels, even inside a scaled panel. */
function scRect(el) {
  const r = el.getBoundingClientRect();
  const host = el.closest?.('#live-chat, #mod-modal .mod-panel, #online-pop');
  const z = host ? parseFloat(host.style.getPropertyValue('--sc-zoom')) : 1;
  if (!z || z === 1) return r;
  if (scZoomLegacy === null) {
    const a = document.createElement('div');
    a.style.cssText = 'position:fixed;left:0;top:0;zoom:2;visibility:hidden;pointer-events:none';
    a.innerHTML = '<div style="margin-left:10px;width:4px;height:4px"></div>';
    document.body.appendChild(a);
    scZoomLegacy = Math.abs(a.firstChild.getBoundingClientRect().left - 10) < 1;
    a.remove();
  }
  if (!scZoomLegacy) return r;
  return { left: r.left * z, top: r.top * z, right: r.right * z, bottom: r.bottom * z, width: r.width * z, height: r.height * z, x: r.left * z, y: r.top * z };
}

/** Beta: drop a floating panel down out of the top-bar button that opened it. */
function scMotionOff() {
  return !betaLayoutOn() || document.body.classList.contains('no-ui-motion') || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function popDown(panel, chip) {
  if (!panel) return;
  // Glass is painted before the first frame it's seen in, not a frame or two after.
  if (panel.classList.contains('liquid-glass')) window.SolarLiquidGlass?.paintNow?.(panel);
  if (scMotionOff()) return;
  clearTimeout(panel._popOutTimer);
  panel.removeEventListener('animationend', panel._popOutEnd);
  panel.classList.remove('sc-pop-out');
  const r = panel.getBoundingClientRect();
  const c = chip?.getBoundingClientRect();
  const ox = c ? Math.max(0, Math.min(r.width, c.left + c.width / 2 - r.left)) : r.width / 2;
  panel.style.setProperty('--pop-ox', `${Math.round(ox)}px`);
  panel.style.removeProperty('--pop-oy');
  panel._popChip = chip || null;
  panel.classList.remove('sc-pop');
  void panel.offsetWidth;
  panel.classList.add('sc-pop');
  clearTimeout(panel._popTimer);
  panel._popTimer = setTimeout(() => panel.classList.remove('sc-pop'), 560);
  chip?.classList.remove('sc-chip-press');
  void chip?.offsetWidth;
  chip?.classList.add('sc-chip-press');
}

const SC_RIPPLE = [
  '#update-chip', '#online-indicator', '#ingame-indicator', '#chat-chip', '#mod-chip',
  '#mod-modal .mod-tab', '#mod-modal .mod-filter button', '#mod-modal .mod-act', '#mod-modal .pill-btn',
  '#online-pop .op-views button', '#online-pop .op-act',
  '#live-chat-send', '.sc-hbtn', '.mod-icon-btn', '.live-chat-x',
  '.pill-btn', '.launch-btn', '.bedrock-launch', '.launch-another', '.chip', '.edition-btn', '.rail-plus',
  '.um-primary', '.um-ghost', '.um-check', '.fr-tab', '.mod-new', '.model-btn', '.se-tool',
  '#community-stage .cs-tool', '#community-stage .cs-send', '#community-stage .cs-leave',
].join(', ');

/** Beta: a ripple spreads from where you pressed. */
function scRipple(e) {
  if (e.button !== 0 || scMotionOff()) return;
  const el = e.target.closest?.(SC_RIPPLE);
  if (!el || el.disabled) return;
  const doc = el.ownerDocument;
  const r = el.getBoundingClientRect();
  const k = el.offsetWidth ? r.width / el.offsetWidth : 1;
  if (doc.defaultView.getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const wrap = doc.createElement('sc-rip');
  const dot = doc.createElement('sc-rip-dot');
  const x = (e.clientX - r.left) / k, y = (e.clientY - r.top) / k;
  const w = el.offsetWidth, h = el.offsetHeight;
  dot.style.setProperty('--x', `${x}px`);
  dot.style.setProperty('--y', `${y}px`);
  dot.style.setProperty('--d', `${Math.hypot(Math.max(x, w - x), Math.max(y, h - y)) * 2}px`);
  wrap.appendChild(dot);
  el.appendChild(wrap);
  setTimeout(() => wrap.remove(), 650);
}
document.addEventListener('pointerdown', scRipple, true);

// Beta: every button sinks when pressed and springs back past its size when
// released. Runs on the separate `scale` property so it stacks with each
// button's own hover/press transform instead of replacing it.
(function scPressSpring() {
  const SEL = 'button, .nav-btn, .rail-avatar, .rail-comm, .cs-ch, [role="button"], summary';
  const KEY = { easing: 'cubic-bezier(.3,.7,.4,1)' };
  let held = null, press = null, sx = 0, sy = 0, moved = false;
  function ownScale(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return 1;
    const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(t);
    return m && Math.abs(+m[2]) < 0.001 ? +m[1] : 0;
  }
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || scMotionOff()) return;
    const el = e.target.closest?.(SEL);
    if (!el || el.disabled || el.offsetWidth > 520 || el.offsetHeight > 160) return;
    held = el; moved = false; sx = e.clientX; sy = e.clientY;
    press?.cancel(); press = null;
    // Buttons that already shrink on :active keep their own press; the rest get one.
    requestAnimationFrame(() => {
      if (held !== el || Math.abs(ownScale(el) - 1) > 0.004) return;
      press = el.animate([{ scale: 1 }, { scale: 0.95 }], { duration: 110, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' });
    });
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (held && !moved && Math.hypot(e.clientX - sx, e.clientY - sy) > 6) moved = true;
  }, { passive: true });
  const letGo = () => {
    const el = held;
    held = null;
    if (!el) return;
    const from = press ? 0.95 : 1;
    press?.cancel(); press = null;
    if (moved || !el.isConnected) return;
    el.animate([
      { scale: from, ...KEY },
      { scale: from < 1 ? 1.045 : 1.03, offset: 0.38, ...KEY },
      { scale: 0.992, offset: 0.72, ...KEY },
      { scale: 1 },
    ], { duration: 460 });
  };
  document.addEventListener('pointerup', letGo, true);
  document.addEventListener('pointercancel', letGo, true);
})();

// Beta: a soft light follows the pointer across whichever glass surface it's
// over, and the rim catches it nearest the cursor. The community stage is left
// out: repainting it every move costs frames.
(function glassLight() {
  const SKIP = '#community-stage';
  let surf = null, shine = null, rect = null, k = 1, x = 0, y = 0, queued = false;
  const drop = () => { rect = null; };
  window.addEventListener('resize', drop, { passive: true });
  window.addEventListener('scroll', drop, { passive: true, capture: true });
  function setSurf(next) {
    if (next === surf) return;
    shine?.classList.remove('lit');
    surf = next; rect = null;
    shine = surf?.querySelector(':scope > .lq-shine') || null;
    if (!shine) surf = null;
  }
  function apply() {
    queued = false;
    if (!shine) return;
    if (!rect) {
      rect = surf.getBoundingClientRect();
      k = surf.offsetWidth ? rect.width / surf.offsetWidth : 1;
    }
    shine.style.setProperty('--gx', `${((x - rect.left) / k).toFixed(1)}px`);
    shine.style.setProperty('--gy', `${((y - rect.top) / k).toFixed(1)}px`);
    shine.classList.add('lit');
  }
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (e.buttons || scMotionOff() || document.body.classList.contains('perf-lite')) { setSurf(null); return; }
    let s = e.target.closest?.('.liquid-glass.lq-surface') || null;
    if (s?.matches(SKIP)) s = null;
    setSurf(s);
    if (!surf) return;
    x = e.clientX; y = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(apply); }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => setSurf(null));
})();

/**
 * Beta: slow looping motion (nebula drift, skin bob, sheens, pulsing dots) is
 * stepped at 30fps. At the display's own rate any one of them makes every
 * glass pane redraw 120 times a second, even the 8px online dot, and that
 * leaves no frames for panels and buttons. Fast loops (spinners) are left alone.
 */
(function scAmbient() {
  const tracked = new Map();   // animation -> { start on the document timeline, run: CSS wants it playing }
  let tick = 0, scan = 0;
  // The stylesheet still decides when these stop (window in the background, a
  // modal over the nebula); picking up again continues from the same frame.
  function refresh() {
    const now = document.timeline.currentTime;
    for (const [a, s] of tracked) {
      const run = getComputedStyle(a.effect.target, a.effect.pseudoElement).animationPlayState.split(',')[0].trim() !== 'paused';
      if (run && !s.run) s.start = now - (a.currentTime || 0);
      s.run = run;
    }
  }
  function adopt() {
    for (const a of document.getAnimations()) {
      if (tracked.has(a) || !a.animationName || a.playState !== 'running') continue;
      const t = a.effect?.getTiming();
      if (t?.iterations !== Infinity || !(t.duration >= 1200 || a.animationName === 'modSpin')) continue;
      tracked.set(a, { start: a.startTime, run: true });
      a.pause();
    }
    for (const a of tracked.keys()) if (a.playState === 'idle' || !a.effect?.target?.isConnected) tracked.delete(a);
    refresh();
  }
  function step() {
    if (document.hidden) return;
    const now = document.timeline.currentTime;
    for (const [a, s] of tracked) if (s.run) a.currentTime = now - s.start;
  }
  function sync() {
    if (betaLayoutOn() && !scan) {
      adopt();
      scan = setInterval(adopt, 1000);
      tick = setInterval(step, 1000 / 30);
    } else if (!betaLayoutOn() && scan) {
      clearInterval(scan); clearInterval(tick); scan = tick = 0;
      for (const a of tracked.keys()) a.play();
      tracked.clear();
    } else if (scan) refresh();
  }
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  sync();
})();

/** Beta: the panel swells, then gets pulled into the button that opened it, which catches it; then hide(). */
function popClose(panel, hide) {
  if (!panel || scMotionOff() || panel.classList.contains('hidden') || panel._scQuiet) { panel && (panel._scQuiet = false); hide(); return; }
  clearTimeout(panel._popTimer);
  panel.classList.remove('sc-pop');
  const chip = panel._popChip;
  const c = chip?.isConnected && chip.ownerDocument === panel.ownerDocument ? chip.getBoundingClientRect() : null;
  if (c?.width) {
    // Origin can sit outside the panel: scaling toward it is what carries the panel into the button.
    const r = panel.getBoundingClientRect();
    const k = panel.offsetWidth ? r.width / panel.offsetWidth : 1;
    panel.style.setProperty('--pop-ox', `${Math.round((c.left + c.width / 2 - r.left) / k)}px`);
    panel.style.setProperty('--pop-oy', `${Math.round((c.top + c.height / 2 - r.top) / k)}px`);
  }
  panel.classList.add('sc-pop-out');
  clearTimeout(panel._popOutTimer);
  panel.removeEventListener('animationend', panel._popOutEnd);
  const finish = () => {
    panel.removeEventListener('animationend', panel._popOutEnd);
    clearTimeout(panel._popOutTimer);
    if (!panel.classList.contains('sc-pop-out')) return;
    panel.classList.remove('sc-pop-out');
    hide();
    if (!c?.width) return;
    chip.classList.remove('sc-chip-press', 'sc-chip-catch');
    void chip.offsetWidth;
    chip.classList.add('sc-chip-catch');
    clearTimeout(chip._catchTimer);
    chip._catchTimer = setTimeout(() => chip.classList.remove('sc-chip-catch'), 520);
  };
  panel._popOutEnd = (e) => { if (e.target === panel && e.animationName === 'sc-pop-lift-y') finish(); };
  panel.addEventListener('animationend', panel._popOutEnd);
  // In case the animation never gets to run.
  panel._popOutTimer = setTimeout(finish, 480);
}

// ---------- Beta: floating panels (live chat, admin panel) ----------
// Dragging one into the other knocks the other aside. Pushing one past the
// edge of the launcher lights the edge and, on release, bounces it out into
// its own window (the header button does the same). The panel's own DOM is
// moved into that window, so it keeps working exactly as before; dragging
// the window back over the launcher docks it again.
const scFloat = new Map();
const SC_SPRING = 'cubic-bezier(.34,1.56,.64,1)';
const SC_FLOATERS = '.sc-menu, .sc-emoji, .people-menu, .fr-menu';
const SC_FOLLOW_IDS = ['confirm-modal', 'report-modal', 'mod-viewer'];
const SC_POP_SVG = {
  out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7z"/><path class="pb-arrow" d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
  dock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 3h-8v2h8v14H5v-8H3v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/><path class="pb-arrow" d="M10 12V10H6.41l5.3-5.29-1.42-1.42L5 8.59V5H3v7h7z"/></svg>',
};

function scFloatPaintBtn(f) {
  const dock = !!f.win;
  const swapped = f.btn.classList.contains('dock') !== dock && !!f.btn.firstChild;
  f.btn.innerHTML = dock ? SC_POP_SVG.dock : SC_POP_SVG.out;
  f.btn.classList.toggle('dock', dock);
  if (swapped) f.btn.firstChild.classList.add('pb-in');
  f.btn.title = dock ? 'Dock back into SolarClient' : 'Pop out into its own window';
  f.btn.setAttribute('aria-label', f.btn.title);
}

/** o: { panel, host, chip, closeBtn, btnClass, title, isOpen(), place(x, y), save(), restore(), close() } */
function scFloatAdd(key, o) {
  const f = { ...o, key, win: null };
  scFloat.set(key, f);
  if (o.noPop) return f;
  f.btn = document.createElement('button');
  f.btn.type = 'button';
  f.btn.className = `${o.btnClass} sc-popbtn beta-only`;
  o.closeBtn.before(f.btn);
  scFloatPaintBtn(f);
  f.btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (f.win) scDock(key);
    else scPopOut(key, { side: 'right' });
  });
  // While it has its own window, the top-bar button closes that window and
  // the panel goes back home; the next click opens it inside the launcher.
  o.chip.addEventListener('click', (e) => {
    if (!f.win) return;
    e.stopImmediatePropagation();
    scDock(key, { shut: true });
  }, true);
  return f;
}

/** Runs fn at most once a frame, with the newest event. flush() runs a pending call now. */
function scPerFrame(fn) {
  let ev = null, id = 0;
  const run = () => { id = 0; const e = ev; ev = null; if (e) fn(e); };
  const wrapped = (e) => { ev = e; if (!id) id = requestAnimationFrame(run); };
  wrapped.flush = () => { if (id) { cancelAnimationFrame(id); run(); } };
  return wrapped;
}

/** Where a floating panel is headed (its resting spot, ignoring any glide in progress). */
function scFloatRect(o) {
  const r = o.panel.getBoundingClientRect();
  return o.glide ? { left: o.glide.x, top: o.glide.y, right: o.glide.x + r.width, bottom: o.glide.y + r.height, width: r.width, height: r.height } : r;
}

const scOverlap = (a, b, pad = 0) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left) + pad)
  * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + pad);

/**
 * The closest spot to (x, y) where a w×h box is fully on screen and clear of
 * every rect in `avoid`: right next to one of them first (14px apart, or 4px
 * when that's what fits), otherwise anywhere on a 24px grid. Sideways moves
 * read as "out of the way", so vertical distance counts a little more.
 */
function scFreeSpot(x, y, w, h, avoid) {
  const minX = 8, maxX = window.innerWidth - w - 8, minY = 40, maxY = window.innerHeight - h - 8;
  if (maxX < minX || maxY < minY) return null;
  const cx = (v) => Math.max(minX, Math.min(v, maxX)), cy = (v) => Math.max(minY, Math.min(v, maxY));
  const clear = (sx, sy) => avoid.every((r) => sx + w + 4 <= r.left || sx >= r.right + 4 || sy + h + 4 <= r.top || sy >= r.bottom + 4);
  const spots = [];
  for (const r of avoid) {
    for (const g of [14, 4]) {
      spots.push([r.right + g, cy(y)], [r.left - g - w, cy(y)], [cx(x), r.bottom + g], [cx(x), r.top - g - h]);
    }
  }
  for (let gx = minX; gx <= maxX + 23; gx += 24) for (let gy = minY; gy <= maxY + 23; gy += 24) spots.push([cx(gx), cy(gy)]);
  let best = null, bestCost = Infinity;
  for (const [sx, sy] of spots) {
    if (sx < minX || sx > maxX || sy < minY || sy > maxY || !clear(sx, sy)) continue;
    const c = Math.hypot(sx - x, (sy - y) * 1.25);
    if (c < bestCost) { bestCost = c; best = { x: sx, y: sy }; }
  }
  return best;
}

const scFloatOthers = (f) => [...scFloat.values()].filter((o) => o !== f && !o.win && o.isOpen());
// html.sc-moving while a panel is dragged or resized.
const SC_MOVERS = ['live-chat', 'online-pop', 'mod-modal', 'updates-menu'];
let scDownAt = null;
document.addEventListener('pointerdown', (e) => { scDownAt = { clientX: e.clientX, clientY: e.clientY }; }, true);
const scMovingObs = new MutationObserver(() => {
  document.documentElement.classList.toggle('sc-moving', SC_MOVERS.some((id) => /\b(dragging|resizing)\b/.test(document.getElementById(id)?.className || '')));
  // Lifts the moment it's grabbed, in the same frame .dragging scales it up, so that never snaps.
  if (!betaLayoutOn() || !scDownAt) return;
  for (const f of scFloat.values()) {
    if (!f.lift && !f.win && (f.host || f.panel).classList.contains('dragging')) scLift(f, scDownAt);
  }
});
for (const id of SC_MOVERS) {
  const n = document.getElementById(id);
  if (n) scMovingObs.observe(n, { attributes: true, attributeFilter: ['class'] });
}
// A smaller window can push panels onto each other; once the resize settles, sort them out again.
let scFloatResizeT = 0;
window.addEventListener('resize', () => {
  clearTimeout(scFloatResizeT);
  scFloatResizeT = setTimeout(() => { for (const f of scFloat.values()) scFloatFit(f); }, 200);
});

/**
 * Slide any other open panel out from under this one, to the closest spot
 * that's on screen and clear of every panel. Re-aiming mid-glide starts from
 * wherever it is, so it never snaps.
 */
function scFloatBump(f, { force = false } = {}) {
  if (!betaLayoutOn() || f.win || !f.isOpen()) return;
  const a = f.panel.getBoundingClientRect();
  const others = scFloatOthers(f);
  for (const o of others) {
    const b = scFloatRect(o);
    if (!b.width) continue;
    const hit = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const hitY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    // Grazing contact while dragging isn't worth moving for; on drop any overlap is.
    if (hit <= 0 || hitY <= 0 || (!force && Math.min(hit, hitY) < 18)) continue;
    const best = scFreeSpot(b.left, b.top, b.width, b.height, [a, ...others.filter((p) => p !== o).map(scFloatRect)]);
    if (!best || (Math.abs(best.x - b.left) < 2 && Math.abs(best.y - b.top) < 2)) continue;
    // Mid-drag, one already on its way only re-aims for a real change; each re-aim costs a few layouts.
    if (!force && o.glide && Math.hypot(best.x - b.left, best.y - b.top) < 36 && scOverlap(a, b) <= 0) continue;
    // Its way out is on the far side of the one being dragged: it ducks under on the way.
    const now = o.panel.getBoundingClientRect();
    const ax = (a.left + a.right) / 2, ay = (a.top + a.bottom) / 2;
    const side = (cx, cy) => (Math.abs(cx - ax) / a.width >= Math.abs(cy - ay) / a.height ? Math.sign(cx - ax) : 2 * Math.sign(cy - ay));
    const under = side((now.left + now.right) / 2, (now.top + now.bottom) / 2) !== side(best.x + b.width / 2, best.y + b.height / 2);
    scFloatGlide(o, best.x, best.y, { under });
  }
}

/** If this panel sits on top of another one, move it to the nearest clear spot. */
function scFloatFit(f, { glide = true } = {}) {
  if (!betaLayoutOn() || f.win || !f.isOpen()) return;
  const a = scFloatRect(f);
  const avoid = scFloatOthers(f).map(scFloatRect).filter((r) => r.width);
  if (!a.width || !avoid.some((r) => scOverlap(a, r) > 0)) return;
  const best = scFreeSpot(a.left, a.top, a.width, a.height, avoid);
  if (!best) {
    if (scFloatSpread(f, { glide }) || scFloatShrink(f, avoid)) return;
    // Still no room anywhere: panels never sit on top of each other, so the ones underneath close.
    const now = scFloatRect(f);
    for (const o of scFloatOthers(f)) if (scOverlap(now, scFloatRect(o)) > 0) o.close();
    return;
  }
  if (glide) scFloatGlide(f, best.x, best.y);
  else f.place(best.x, best.y);
}

/** A dropdown just opened: slide every open panel out from under it. */
function scFloatClear(el) {
  if (!betaLayoutOn()) return;
  const m = el.getBoundingClientRect();
  if (!m.width) return;
  const open = [...scFloat.values()].filter((o) => !o.win && o.isOpen() && o.panel !== el);
  for (const o of open) {
    const b = scFloatRect(o);
    if (!b.width || scOverlap(m, b) <= 0) continue;
    const avoid = [m, ...open.filter((p) => p !== o).map(scFloatRect)];
    const best = scFreeSpot(b.left, b.top, b.width, b.height, avoid);
    if (best) scFloatGlide(o, best.x, best.y);
    else if (!scFloatShrink(o, avoid)) o.close();
  }
}

/** Make this panel smaller (down to its minimum) until it fits in a clear spot. */
function scFloatShrink(f, avoid) {
  if (!f.resize) return false;
  const a = scFloatRect(f);
  for (const k of [0.85, 0.7, 0.55, 0.4]) {
    f.resize(a.width * k, a.height * k);
    const r = f.panel.getBoundingClientRect();
    const best = scFreeSpot(a.left, a.top, r.width, r.height, avoid);
    if (best) { f.place(best.x, best.y); f.save(); return true; }
  }
  f.resize(a.width, a.height);
  return false;
}

/**
 * No clear spot anywhere: line every open panel up side by side, in the
 * order they already sit, each as close to where it was as fits. False when
 * they're too wide for the window together.
 */
function scFloatSpread(f, { glide = true } = {}) {
  const all = [f, ...scFloatOthers(f)].map((o) => ({ o, r: scFloatRect(o) })).filter(({ r }) => r.width);
  const W = window.innerWidth, gap = 8;
  if (all.reduce((s, p) => s + p.r.width, 0) + gap * (all.length - 1) > W - 16) return false;
  all.sort((p, q) => (p.r.left + p.r.width / 2) - (q.r.left + q.r.width / 2));
  const xs = all.map((p) => p.r.left);
  for (let i = 0; i < all.length; i++) xs[i] = Math.max(xs[i], i ? xs[i - 1] + all[i - 1].r.width + gap : 8);
  for (let i = all.length - 1; i >= 0; i--) xs[i] = Math.min(xs[i], i < all.length - 1 ? xs[i + 1] - gap - all[i].r.width : W - 8 - all[i].r.width);
  all.forEach(({ o, r }, i) => {
    if (Math.abs(xs[i] - r.left) < 2) return;
    if (o === f && !glide) o.place(xs[i], r.top);
    else scFloatGlide(o, xs[i], r.top);
  });
  return true;
}

/**
 * A damped spring from (x, y) px off its spot, moving at (vx, vy) px/s, back to rest.
 * One [x, y, vx, vy] per 60fps frame; capped at 1.4s.
 */
function scSpringRun(x, y, vx, vy) {
  const K = 210, C = 20, sub = 4, dt = 1 / 60 / sub;
  const out = [];
  for (let i = 0; i < 84; i++) {
    out.push([x, y, vx, vy]);
    if (i > 6 && Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && Math.hypot(vx, vy) < 10) break;
    for (let s = 0; s < sub; s++) {
      vx += (-K * x - C * vx) * dt;
      vy += (-K * y - C * vy) * dt;
      x += vx * dt;
      y += vy * dt;
    }
  }
  out.push([0, 0, 0, 0]);
  return out;
}

/**
 * Knock a panel to (x, y): it springs over, leaning into the way it's going
 * and stretching with its speed, then settles. Re-aimed mid-flight it keeps
 * its momentum instead of starting over.
 */
function scFloatGlide(o, x, y, { under = false } = {}) {
  const p = o.panel;
  // Starts from exactly what's on screen (mid-landing, pressed on a wall, tilted). Scaling
  // about the center leaves the center put, so the switch of origin doesn't show.
  const r0 = p.getBoundingClientRect();
  const was = o.glideAnim ? null : scSettle(p);
  scEdgeStop(o);
  if (!o.lift) p.style.transformOrigin = '';
  let vx = 0, vy = 0;
  const fresh = !o.glideAnim;
  if (o.spring && o.glideAnim) {
    const i = Math.min(o.spring.length - 1, Math.round((performance.now() - o.springT0) / (1000 / 60)));
    [, , vx, vy] = o.spring[i];
  }
  o.glideAnim?.cancel();
  o.place(x, y);
  const r1 = p.getBoundingClientRect();
  o.glide = { x: r1.left, y: r1.top };
  const done = () => { o.glide = null; o.glideAnim = null; o.spring = null; p.classList.remove('sc-gliding'); o.save(); };
  if (scMotionOff()) { done(); return; }
  p.classList.add('sc-gliding');
  // Centers: they don't move when the panel is scaled or tilted.
  const dx = (r0.left + r0.right) / 2 - (r1.left + r1.right) / 2;
  const dy = (r0.top + r0.bottom) / 2 - (r1.top + r1.bottom) / 2;
  const pts = scSpringRun(dx, dy, vx, vy);
  const d0 = Math.max(1, Math.hypot(dx, dy));
  const frames = pts.map(([px, py, pvx, pvy], i) => {
    const speed = Math.hypot(pvx, pvy);
    const st = Math.min(0.045, speed * 0.000022);
    const ax = speed ? Math.abs(pvx) / speed : 0;
    // Ducking under: shrinks back as if further away, deepest halfway across.
    const dip = under ? 1 - 0.12 * Math.sin(Math.PI * Math.min(1, Math.max(0, 1 - Math.hypot(px, py) / d0))) : 1;
    let sx = (1 + st * ax - st * 0.55 * (1 - ax)) * dip, sy = (1 + st * (1 - ax) - st * 0.55 * ax) * dip;
    let rot = Math.max(-4, Math.min(4, pvx * 0.0022));
    const m = was && i < 12 ? (1 - i / 12) ** 2 : 0;
    if (m) { sx += (was.sx - sx) * m; sy += (was.sy - sy) * m; rot += (was.rot - rot) * m; }
    return {
      translate: `${px.toFixed(1)}px ${py.toFixed(1)}px`,
      rotate: `${rot.toFixed(2)}deg`,
      scale: `${sx.toFixed(4)} ${sy.toFixed(4)}`,
    };
  });
  const anim = p.animate(frames, { duration: (pts.length - 1) * (1000 / 60), easing: 'linear' });
  o.glideAnim = anim;
  o.spring = pts;
  o.springT0 = performance.now();
  anim.onfinish = anim.oncancel = () => { if (o.glideAnim === anim) done(); };
  if (fresh) {
    p.classList.remove('sc-hit');
    void p.offsetWidth;
    p.classList.add('sc-hit');
    clearTimeout(p._scHitT);
    p._scHitT = setTimeout(() => p.classList.remove('sc-hit'), 650);
  }
}

/**
 * Corner resize, shared by live chat, Online, admin and Updates. The box follows the
 * cursor exactly from where it really is (any glide or landing is stopped first, so
 * grabbing a corner never jumps), its contents re-scale as you go, panels it grows into
 * slide away while you drag instead of after, and the corner you hold lights up with
 * the size riding next to it. Letting go settles it with a small spring.
 * minH may be a function (Updates works it out from its contents).
 */
let scRzBadge = null;
function scResize(e, grip, { f, panel, host = panel, minW, minH, prep, save }) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  if (f) { f.glideAnim?.cancel(); scEdgeStop(f); }
  for (const a of panel.getAnimations()) a.cancel();
  panel.style.scale = ''; panel.style.translate = ''; panel.style.rotate = '';
  const dir = grip.dataset.rz;
  const east = dir.includes('e'), south = dir.includes('s');
  const r = panel.getBoundingClientRect();
  const sx = e.clientX, sy = e.clientY;
  const maxW = east ? window.innerWidth - 8 - r.left : r.right - 8;
  const maxH = south ? window.innerHeight - 8 - r.top : r.bottom - 40;
  const lo = () => (typeof minH === 'function' ? minH() : minH);
  prep?.(r);
  host.classList.add('resizing');
  grip.classList.add('rz-on');
  // Regenerating the glass lens every frame makes the drag stutter; it's repainted once at the end.
  window.SolarLiquidGlass?.detach(panel);
  if (!scRzBadge) {
    scRzBadge = document.createElement('div');
    scRzBadge.className = 'sc-rz-badge';
    document.body.appendChild(scRzBadge);
  }
  const badge = scRzBadge;
  badge.className = `sc-rz-badge on ${dir}`;
  let bumpT = 0;
  const frame = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    const w = Math.round(Math.max(minW, Math.min(maxW, r.width + (east ? dx : -dx))));
    panel.style.width = `${w}px`;
    const h = Math.round(Math.max(lo(), Math.min(maxH, r.height + (south ? dy : -dy))));
    panel.style.height = `${h}px`;
    const left = east ? r.left : r.right - w, top = south ? r.top : r.bottom - h;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
    badge.textContent = `${w} × ${h}`;
    badge.style.left = `${east ? left + w : left}px`;
    badge.style.top = `${south ? top + h : top}px`;
    const t = performance.now();
    if (f && t - bumpT > 90) { bumpT = t; scFloatBump(f); }
  };
  frame(e);
  const move = scPerFrame(frame);
  const up = () => {
    move.flush();
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    host.classList.remove('resizing');
    grip.classList.remove('rz-on');
    badge.classList.remove('on');
    panel._scZoom?.();
    window.SolarLiquidGlass?.attach(panel);
    save?.();
    if (f) { scFloatBump(f, { force: true }); scFloatFit(f); }
    if (!scMotionOff() && !f?.glideAnim) {
      panel.animate([{ scale: '1' }, { scale: '1.012', offset: 0.35 }, { scale: '0.997', offset: 0.7 }, { scale: '1' }],
        { id: 'sc-motion', duration: 380, easing: 'cubic-bezier(.3,.7,.3,1)' });
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

const SC_LIFT = 1.035;
/**
 * What the panel is showing right now (scale and tilt, mid-animation included), then
 * its own lift and landing animations are stopped so whatever comes next starts from there.
 */
function scSettle(p) {
  const cs = getComputedStyle(p);
  const sc = cs.scale === 'none' ? [1, 1] : cs.scale.split(' ').map(Number);
  const was = { sx: sc[0] || 1, sy: sc[1] ?? sc[0] ?? 1, rot: cs.rotate === 'none' ? 0 : parseFloat(cs.rotate) || 0 };
  for (const a of p.getAnimations()) if (a.id === 'sc-motion') a.cancel();
  return was;
}

/** Beta: a picked-up panel lifts toward you and leans into the way you drag it. */
function scLift(f, ev) {
  if (scMotionOff()) return;
  const p = f.panel;
  const now = performance.now();
  const l = f.lift;
  if (!l) {
    clearTimeout(p._scLiftT);
    // .dragging already says lifted; what was on screen is the landing it interrupts, or rest.
    const landing = p.getAnimations().some((a) => a.id === 'sc-motion');
    const was = scSettle(p);
    const from = landing ? `${was.sx} ${was.sy}` : '1';
    const r = p.getBoundingClientRect();
    const k = p.offsetWidth ? r.width / p.offsetWidth : 1;
    p.style.transformOrigin = `${Math.round((ev.clientX - r.left) / k)}px ${Math.round((ev.clientY - r.top) / k)}px`;
    // Grabbed again while it's still easing off a wall: that ease now ends held, not at rest.
    if (f.press?.release) { f.press.gx = f.press.gy = SC_LIFT; scEdgeRun(f); }
    else if (!f.press) p.animate([{ scale: from }, { scale: '1.06', offset: 0.42 }, { scale: String(SC_LIFT) }], { id: 'sc-motion', duration: 380, easing: 'cubic-bezier(.3,.7,.3,1)' });
    const lf = f.lift = { x: ev.clientX, t: now, v: 0, tilt: was.rot, raf: 0 };
    const tick = () => {
      if (f.lift !== lf) return;
      lf.v *= 0.86;
      // Pressed against an edge it can't lean: it's flat on the wall.
      const want = f.edge ? 0 : Math.max(-5, Math.min(5, lf.v * 0.005));
      lf.tilt += (want - lf.tilt) * 0.22;
      p.style.rotate = `${lf.tilt.toFixed(2)}deg`;
      lf.raf = requestAnimationFrame(tick);
    };
    lf.raf = requestAnimationFrame(tick);
    return;
  }
  const v = ((ev.clientX - l.x) / Math.max(8, now - l.t)) * 1000;
  l.v = l.v * 0.4 + v * 0.6;
  l.x = ev.clientX;
  l.t = now;
}

/** Let go: the tilt swings back past level and the panel lands with a little squash. */
function scLiftEnd(f, { quiet = false } = {}) {
  const l = f.lift;
  if (!l) return;
  f.lift = null;
  cancelAnimationFrame(l.raf);
  const p = f.panel;
  // Still popping up (a quick grab and let go): land from where that got to.
  const popping = p.getAnimations().some((a) => a.id === 'sc-motion');
  const was = scSettle(p);
  p.style.rotate = '';
  const clear = () => { if (!f.lift && !f.press) p.style.transformOrigin = ''; };
  if (quiet || scMotionOff()) { clear(); return; }
  p.animate([{ rotate: `${l.tilt}deg` }, { rotate: `${(-l.tilt * 0.35).toFixed(2)}deg`, offset: 0.45 }, { rotate: '0deg' }], { id: 'sc-motion', duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)' });
  // Pressed on a wall, the press spring lands it instead.
  if (!f.press) {
    const from = popping ? `${was.sx} ${was.sy}` : String(SC_LIFT);
    p.animate([{ scale: from }, { scale: '0.975', offset: 0.38 }, { scale: '1.01', offset: 0.7 }, { scale: '1' }], { id: 'sc-motion', duration: 560, easing: 'cubic-bezier(.3,.7,.3,1)' });
  }
  p._scLiftT = setTimeout(clear, 600);
}

let scEdgeEl = null;
/** During a header drag. want = where the panel is trying to go before it's kept on screen. */
function scFloatDrag(f, ev, want) {
  if (!f || !betaLayoutOn()) return;
  f.glideAnim?.cancel();
  scLift(f, ev);
  // Others glide with momentum, so re-aiming them a dozen times a second is plenty; each check costs a layout.
  const t = performance.now();
  if (t - (f.bumpT || 0) > 70) { f.bumpT = t; scFloatBump(f); }
  if (f.noPop) return;
  const W = window.innerWidth, H = window.innerHeight;
  let side = null, push = 0;
  for (const [s, p] of [['right', want.x + want.w - (W - 8)], ['left', 8 - want.x], ['bottom', want.y + want.h - (H - 8)]]) {
    if (p > push) { side = s; push = p; }
  }
  if (!side || push < 6) { scEdgeHide(f); return; }
  if (!scEdgeEl) {
    scEdgeEl = document.createElement('div');
    scEdgeEl.className = 'sc-edge';
    scEdgeEl.innerHTML = '<i class="sc-edge-glow"></i><span class="sc-edge-tag"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg><b></b><em></em></span>';
    document.body.appendChild(scEdgeEl);
  }
  const k = Math.min(1, push / 110);
  // Once armed it stays armed until you clearly back off, so wobbling on the line can't flicker it.
  const armed = k >= 1 || (f.edge?.armed && f.edge.side === side && k > 0.8);
  scEdgeEl.className = `sc-edge on ${side}${armed ? ' armed' : ''}`;
  const label = armed ? 'Let go to pop out' : 'Keep pushing';
  const b = scEdgeEl.querySelector('b');
  if (b.textContent !== label) b.textContent = label;
  scEdgeEl.style.setProperty('--k', k.toFixed(3));
  // The tag follows the cursor along the edge but never past the title bar or out of the window.
  scEdgeEl.style.setProperty('--cx', `${Math.round(Math.max(140, Math.min(W - 140, ev.clientX)))}px`);
  scEdgeEl.style.setProperty('--cy', `${Math.round(Math.max(72, Math.min(H - 36, ev.clientY)))}px`);
  f.panel.style.setProperty('--edge-k', (armed ? 1 : k).toFixed(3));
  f.edge = { side, armed };
  scEdgePress(f, side, k, armed);
  f.panel.classList.toggle('sc-edge-armed', armed);
}

/**
 * Pushed into the edge of the launcher: the panel presses flat against it, firmer the
 * harder you push, and never crosses it. Once it's far enough it lets go of the squash
 * and shrinks back off the edge, ready to come away as its own window.
 * One spring drives all of it, pressing in, easing off and landing, so touching the
 * edge again halfway through just turns it around.
 */
function scEdgePress(f, side, k, armed) {
  if (scMotionOff()) return;
  const e = 1 - (1 - k) ** 2;
  const along = armed ? 0.93 : 1 - 0.1 * e;
  const across = armed ? 0.93 : 1 + 0.03 * e;
  let s = f.press;
  if (!s) {
    const p = f.panel;
    const was = scSettle(p);
    // Sized once: measuring every move is what made the press stutter.
    s = f.press = { sx: was.sx, sy: was.sy, vx: 0, vy: 0, pin: 0, vp: 0, w: p.offsetWidth || 1, h: p.offsetHeight || 1, raf: 0, t: 0 };
    p.classList.add('sc-edging');
  }
  s.side = side;
  s.armed = armed;
  s.release = false;
  s.pinTo = 1;
  s.gx = SC_LIFT * (side === 'bottom' ? across : along);
  s.gy = SC_LIFT * (side === 'bottom' ? along : across);
  scEdgeRun(f);
}

function scEdgeRun(f) {
  const s = f.press, p = f.panel;
  if (!s || s.raf) return;
  s.t = performance.now();
  const tick = (now) => {
    if (f.press !== s) return;
    const dt = Math.min(0.05, (now - s.t) / 1000);
    s.t = now;
    // Follows the push like a soft spring; snaps in with a small bounce once it arms.
    const K = s.armed ? 420 : 560, C = s.armed ? 24 : 40;
    for (let i = 0, n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n; i < n; i++) {
      s.vx += (K * (s.gx - s.sx) - C * s.vx) * h; s.sx += s.vx * h;
      s.vy += (K * (s.gy - s.sy) - C * s.vy) * h; s.sy += s.vy * h;
      s.vp += (560 * (s.pinTo - s.pin) - 47 * s.vp) * h; s.pin += s.vp * h;
    }
    const still = Math.abs(s.gx - s.sx) + Math.abs(s.gy - s.sy) < 2e-4 && Math.abs(s.vx) + Math.abs(s.vy) < 2e-3
      && Math.abs(s.pinTo - s.pin) < 1e-3 && Math.abs(s.vp) < 1e-2;
    if (still && s.release) {
      f.press = null;
      p.style.scale = '';
      p.style.translate = '';
      p.classList.remove('sc-edging');
      if (!f.lift) p.style.transformOrigin = '';
      return;
    }
    // Scale runs about the grab point; slide back by what that moves the pressed side so it stays on the edge.
    const o = (p.style.transformOrigin || '').split(' ').map(parseFloat);
    const ox = Number.isFinite(o[0]) ? o[0] : s.w / 2, oy = Number.isFinite(o[1]) ? o[1] : s.h / 2;
    const tx = (s.side === 'right' ? (s.w - ox) * (1 - s.sx) : s.side === 'left' ? -ox * (1 - s.sx) : 0) * s.pin;
    const ty = (s.side === 'bottom' ? (s.h - oy) * (1 - s.sy) : 0) * s.pin;
    p.style.scale = `${s.sx.toFixed(4)} ${s.sy.toFixed(4)}`;
    p.style.translate = `${tx.toFixed(1)}px ${ty.toFixed(1)}px`;
    s.raf = still ? 0 : requestAnimationFrame(tick);
  };
  s.raf = requestAnimationFrame(tick);
}

/** Drops the press without easing it out (something else is taking over the panel). */
function scEdgeStop(f) {
  if (!f?.press) return;
  cancelAnimationFrame(f.press.raf);
  f.press = null;
  f.panel.style.scale = '';
  f.panel.style.translate = '';
  f.panel.classList.remove('sc-edging');
}

/** drop: the drag ended here, so it settles to rest instead of back to held. */
function scEdgeHide(f, { drop = false } = {}) {
  scEdgeEl?.classList.remove('on', 'armed');
  if (!f) return;
  f.edge = null;
  f.panel.classList.remove('sc-edge-armed');
  f.panel.style.removeProperty('--edge-k');
  const s = f.press;
  if (!s) return;
  if (scMotionOff()) { scEdgeStop(f); return; }
  s.armed = false;
  s.release = true;
  s.pinTo = 0;
  s.gx = s.gy = drop ? 1 : SC_LIFT;
  scEdgeRun(f);
}

/** End of a header drag; true when it popped out. */
function scFloatDrop(f, ev, grab) {
  if (!f) return false;
  const edge = f.edge;
  scLiftEnd(f, { quiet: !!edge?.armed });
  if (!edge?.armed) {
    if (!f.noPop) scEdgeHide(f, { drop: true });
    scFloatBump(f, { force: true });
    // Whatever couldn't make room, this one moves off it instead: panels never stack.
    scFloatFit(f);
    return false;
  }
  f.edge = null;
  scPopOut(f.key, { side: edge.side, ev, grab });
  return true;
}

// Popped out: grab anywhere that isn't a control to move the window; the edges and corners resize it.
const SC_POP_NOGRAB = `button, a, input, textarea, select, label, [contenteditable], [role="button"], [role="slider"], [role="tab"], video, ${SC_FLOATERS}, .pf-overlay, .sync-modal`;
function scPopGrab(d, key) {
  // No top-right grip: that's where the X is.
  for (const edge of ['n', 's', 'e', 'w', 'nw', 'sw', 'se']) {
    const g = d.createElement('div');
    g.className = `sc-pop-rz ${edge}`;
    g.dataset.popRz = edge;
    d.body.appendChild(g);
  }
  d.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || scFloat.get(key)?.win?.document !== d) return;
    const t = e.target;
    const rz = t.closest?.('.sc-pop-rz');
    if (!rz) {
      if (t.closest?.(SC_POP_NOGRAB)) return;
      // Its scrollbar scrolls.
      if (t.clientWidth && (e.offsetX > t.clientWidth || e.offsetY > t.clientHeight)) return;
    }
    const id = e.pointerId, sx = e.screenX, sy = e.screenY;
    const host = scFloat.get(key).host;
    let on = false;
    const begin = () => {
      on = true;
      if (rz) host.classList.add('resizing');
      try { t.setPointerCapture(id); } catch { /* gone */ }
      d.getSelection()?.removeAllRanges();
      d.documentElement.classList.add('sc-grabbing');
      d.documentElement.classList.toggle('sc-grab-move', !rz);
      window.nebula.popoutGrab?.({ key, mode: rz ? 'resize' : 'move', edge: rz?.dataset.popRz, sx, sy });
    };
    const moveFn = (ev) => { if (!on && Math.hypot(ev.screenX - sx, ev.screenY - sy) > 4) begin(); };
    const end = () => {
      d.removeEventListener('pointermove', moveFn, true);
      d.removeEventListener('pointerup', end, true);
      d.removeEventListener('pointercancel', end, true);
      t.removeEventListener('lostpointercapture', end);
      if (!on) return;
      on = false;
      d.documentElement.classList.remove('sc-grabbing', 'sc-grab-move');
      window.nebula.popoutRelease?.();
      if (rz) host.classList.remove('resizing');
      // The press that moved the window isn't also a click on whatever it started on.
      const eat = (ce) => { ce.stopPropagation(); ce.preventDefault(); };
      d.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => d.removeEventListener('click', eat, { capture: true }), 0);
    };
    d.addEventListener('pointermove', moveFn, true);
    d.addEventListener('pointerup', end, true);
    d.addEventListener('pointercancel', end, true);
    t.addEventListener('lostpointercapture', end);
    if (rz) { e.preventDefault(); begin(); }
  }, true);
}

function scPopOut(key, { side = 'right', ev = null, grab = null } = {}) {
  const f = scFloat.get(key);
  if (!f || f.win || !betaLayoutOn() || !f.isOpen()) return;
  const r = f.panel.getBoundingClientRect();
  const w = Math.round(r.width), h = Math.round(r.height);
  // Land just past the edge it went over (the main process keeps it on screen).
  let x = window.screenX + Math.round(r.left) + 40, y = window.screenY + Math.round(r.top) + 24;
  if (ev) {
    y = ev.screenY - (grab?.y || 20);
    if (side === 'right') x = window.screenX + window.outerWidth + 10;
    else if (side === 'left') x = window.screenX - w - 10;
    else { x = ev.screenX - (grab?.x || w / 2); y = window.screenY + window.outerHeight + 10; }
  }
  const win = window.open('', `sc-pop-${key}`, `popup=yes,width=${w},height=${h},left=${Math.round(x)},top=${Math.round(y)}`);
  if (!win?.document) { showToast("Couldn't pop out", 'The window could not be opened.', 'error'); scEdgeHide(f, { drop: true }); return; }
  const d = win.document;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><base href="${escapeHtml(location.href)}"><title>${escapeHtml(f.title)} · SolarClient</title><link rel="stylesheet" href="style.css"></head><body><div id="toast-container" class="toast-container"></div></body></html>`);
  d.close();
  f.win = win;
  scPop.docs.add(d);
  scPop.active = d;

  const dx = side === 'right' ? 1 : side === 'left' ? -1 : 0, dy = side === 'bottom' ? 1 : 0;
  scEdgeEl?.classList.add('fire');
  setTimeout(() => scEdgeEl?.classList.remove('fire'), 500);
  const move = () => {
    if (f.win !== win) return;
    scEdgeHide(null);
    f.panel.getAnimations().forEach((a) => a.cancel());
    f.panel.style.translate = '';
    f.panel.style.scale = '';
    f.panel.style.rotate = '';
    f.panel.style.transformOrigin = '';
    f.panel.classList.remove('sc-edge-armed', 'sc-edging', 'sc-slot', 'sc-pop', 'sc-pop-out', 'dragging', 'resizing');
    f.panel.style.removeProperty('--edge-k');
    window.SolarLiquidGlass?.detach(f.panel);
    f.home = { parent: f.host.parentNode, next: f.host.nextSibling };
    const look = () => {
      d.documentElement.style.cssText = document.documentElement.style.cssText;
      d.body.className = `${document.body.className.replace(/\bwin-blurred\b/g, '')} sc-popdoc sc-popdoc-${key}`;
    };
    look();
    f.lookObs = new MutationObserver(look);
    f.lookObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    f.lookObs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    d.body.appendChild(f.host);
    f.chip.classList.add('sc-popped');
    scFloatPaintBtn(f);
    if (!scMotionOff()) {
      f.panel.animate([
        { transform: `translate(${-dx * 40}px, ${-dy * 40}px) scale(0.9)`, opacity: 0 },
        { transform: `translate(${dx * 8}px, ${dy * 8}px) scale(1.02)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${dx * -2}px, ${dy * -2}px) scale(0.995)`, opacity: 1, offset: 0.8 },
        { transform: 'none', opacity: 1 },
      ], { duration: 480, easing: 'cubic-bezier(.2,.9,.25,1)' });
    }
    try { win.focus(); } catch { /* closed */ }
  };

  // Clicks inside the new window behave like they do in the launcher.
  for (const [type, fn, opts] of SC_DOC_CLICKS) d.addEventListener(type, fn, opts);
  d.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(a.href)) window.nebula.openExternal(a.href).catch(() => {});
  });
  const dropFloaters = (keep) => d.querySelectorAll(SC_FLOATERS).forEach((m) => { if (!keep || !m.contains(keep)) m.remove(); });
  d.addEventListener('pointerdown', (e) => { scPop.active = d; dropFloaters(e.target); }, true);
  d.addEventListener('pointerdown', scRipple, true);
  d.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.querySelector(SC_FLOATERS)) { e.stopPropagation(); dropFloaters(null); } }, true);
  win.addEventListener('focus', () => { scPop.active = d; });
  win.addEventListener('pagehide', () => { if (f.win === win) scDock(key, { gone: true }); });
  clearInterval(f.poll);
  f.poll = setInterval(() => { if (f.win === win && win.closed) scDock(key, { gone: true }); }, 1000);
  f.popSize = null;
  win.addEventListener('resize', () => { if (f.win === win) f.popSize = { w: win.innerWidth, h: win.innerHeight }; });
  scPopGrab(d, key);
  scDotTips(d);

  // The press stops where it is; the slot below starts from that shape.
  if (f.press) { cancelAnimationFrame(f.press.raf); f.press = null; }
  if (scMotionOff()) { move(); return; }
  // Out through the edge like through a slot: it squeezes flat against it and is gone,
  // never hanging half over it. Starts from exactly where it is (pressed, shrunk, tilted).
  const p = f.panel;
  const L = { x: p.offsetLeft, y: p.offsetTop, w: p.offsetWidth || 1, h: p.offsetHeight || 1 };
  const v = p.getBoundingClientRect();
  p.getAnimations().forEach((a) => a.cancel());
  p.style.scale = '1';
  p.style.translate = '0px 0px';
  p.style.rotate = '0deg';
  p.style.transformOrigin = side === 'left' ? '0% 50%' : side === 'bottom' ? '50% 100%' : '100% 50%';
  const tx = side === 'left' ? v.left - L.x : side === 'bottom' ? (v.left + v.width / 2) - (L.x + L.w / 2) : v.right - (L.x + L.w);
  const ty = side === 'bottom' ? v.bottom - (L.y + L.h) : (v.top + v.height / 2) - (L.y + L.h / 2);
  const from = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) scale(${(v.width / L.w).toFixed(4)}, ${(v.height / L.h).toFixed(4)})`;
  // A small lean back off the wall, then it's drawn through, gathering speed.
  const back = `translate(${-dx * 7}px, ${-dy * 7}px) scale(0.965)`;
  const thin = dy ? 'scale(0.9, 0.45)' : 'scale(0.45, 0.9)';
  const flat = dy ? 'scale(0.8, 0.02)' : 'scale(0.02, 0.8)';
  p.classList.add('sc-slot');
  p.animate([
    { transform: from, easing: 'cubic-bezier(.25,.6,.35,1)' },
    { transform: back, offset: 0.34, easing: 'cubic-bezier(.55,0,.8,.45)' },
    { transform: thin, offset: 0.72, easing: 'cubic-bezier(.4,0,1,1)' },
    { transform: flat },
  ], { duration: 420, fill: 'forwards' });
  setTimeout(move, 410);
}

/**
 * Bring a popped-out panel home. at: where the cursor let go over the launcher.
 * gone: its window was already closed. shut: close the window and the panel.
 */
function scDock(key, { at = null, gone = false, shut = false } = {}) {
  const f = scFloat.get(key);
  if (!f?.win) return;
  const win = f.win;
  const d = win.document;
  f.win = null;
  scPop.docs.delete(d);
  if (scPop.active === d) scPop.active = document;
  f.lookObs?.disconnect();
  clearInterval(f.poll);
  scDockHint(null);
  for (const n of [...d.body.children]) {
    if (n === f.host || n.id === 'toast-container') continue;
    if (SC_FOLLOW_IDS.includes(n.id)) document.body.appendChild(n);
    else n.remove();
  }
  f.panel.getAnimations().forEach((a) => a.cancel());
  const { parent, next } = f.home || { parent: document.body, next: null };
  parent.insertBefore(f.host, next && next.parentNode === parent ? next : null);
  f.chip.classList.remove('sc-popped');
  scFloatPaintBtn(f);
  if (!gone) { try { win.close(); } catch { /* already gone */ } }
  // A size picked while it was popped out comes home with it.
  const size = f.popSize;
  f.popSize = null;
  if (gone || shut) {
    if (size && f.resize) { f.restore(); f.resize(size.w, size.h); f.save(); }
    f.panel._scQuiet = true; f.close(); return;
  }
  f.restore();
  if (size) f.resize?.(size.w, size.h);
  if (at) f.place(at.x - at.ox, at.y - at.oy);
  window.SolarLiquidGlass?.attach(f.panel);
  scFloatBump(f, { force: true });
  scFloatFit(f, { glide: false });
  f.save();
  if (!scMotionOff()) {
    window.SolarLiquidGlass?.paintNow?.(f.panel);
    scDockLand(f.panel, at);
  }
  window.focus();
}

/** The landing: the panel springs out of the spot you let go, a white ring rolls off its edges and a shine crosses it. */
function scDockLand(panel, at) {
  const r = panel.getBoundingClientRect();
  const ox = at ? Math.max(0, Math.min(r.width, at.x - r.left)) : r.width / 2;
  const oy = at ? Math.max(0, Math.min(r.height, at.y - r.top)) : r.height / 2;
  const radius = getComputedStyle(panel).borderRadius || '16px';
  panel.animate([
    { transformOrigin: `${ox}px ${oy}px`, transform: 'scale(0.55)', opacity: 0, boxShadow: '0 0 0 3px #fff, 0 0 50px rgba(255,255,255,0.55)', easing: 'cubic-bezier(.2,1.1,.35,1)' },
    { transformOrigin: `${ox}px ${oy}px`, transform: 'scale(1.03)', opacity: 1, boxShadow: '0 0 0 2px rgba(255,255,255,0.8), 0 0 30px rgba(255,255,255,0.3)', offset: 0.5, easing: 'ease-in-out' },
    { transformOrigin: `${ox}px ${oy}px`, transform: 'scale(0.992)', boxShadow: '0 0 0 1px rgba(255,255,255,0.3), 0 0 12px rgba(255,255,255,0.1)', offset: 0.76, easing: 'ease-out' },
    { transformOrigin: `${ox}px ${oy}px`, transform: 'none', opacity: 1 },
  ], { duration: 620, id: 'sc-motion' });
  const fx = document.createElement('div');
  fx.className = 'sc-dock-land';
  fx.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px; border-radius:${radius}; --ox:${ox}px; --oy:${oy}px;`;
  fx.innerHTML = '<i class="ring"></i><i class="ring two"></i><span class="clip"><i class="shine"></i></span>';
  document.body.appendChild(fx);
  setTimeout(() => fx.remove(), 900);
}

let scDockHintEl = null;
function scDockHint(f) {
  if (!scDockHintEl) {
    scDockHintEl = document.createElement('div');
    scDockHintEl.className = 'sc-dock-hint';
    scDockHintEl.innerHTML = '<span></span>';
    document.body.appendChild(scDockHintEl);
  }
  if (f) scDockHintEl.firstChild.textContent = `Let go to dock ${f.title.toLowerCase()}`;
  scDockHintEl.classList.toggle('on', !!f);
}

window.nebula?.onPopoutHover?.(({ key, over }) => {
  const f = scFloat.get(key);
  if (!f?.win) return;
  f.win.document.documentElement.classList.toggle('sc-merging', !!over);
  scDockHint(over ? f : null);
});
window.nebula?.onPopoutDock?.((p) => {
  if (scFloat.get(p?.key)?.win) scDock(p.key, { at: p });
});
window.addEventListener('beforeunload', () => { for (const f of scFloat.values()) { try { f.win?.close(); } catch { /* gone */ } } });
document.addEventListener('pointerdown', () => { scPop.active = document; }, true);
window.addEventListener('focus', () => { scPop.active = document; });

// Menus, pickers and dialogs open in whichever window you're using.
new MutationObserver((muts) => {
  const d = scActiveDoc();
  if (d === document) return;
  for (const m of muts) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1 || n.classList.contains('sc-keep') || !n.matches(`${SC_FLOATERS}, .pf-overlay, .sync-modal:has(#prompt-input)`)) continue;
      const focused = n.contains(document.activeElement) ? document.activeElement : null;
      d.body.appendChild(n);
      const W = d.defaultView.innerWidth, H = d.defaultView.innerHeight;
      if (n.style.left) n.style.left = `${Math.max(6, Math.min(parseFloat(n.style.left), W - n.offsetWidth - 6))}px`;
      if (n.style.top) n.style.top = `${Math.max(6, Math.min(parseFloat(n.style.top), H - n.offsetHeight - 6))}px`;
      focused?.focus();
    }
  }
}).observe(document.body, { childList: true });
for (const id of SC_FOLLOW_IDS) {
  const el = document.getElementById(id);
  if (!el) continue;
  new MutationObserver(() => {
    const shown = !el.classList.contains('hidden');
    const d = scActiveDoc();
    if (shown && d !== document && el.ownerDocument !== d) {
      const focused = el.contains(el.ownerDocument.activeElement) ? el.ownerDocument.activeElement : null;
      d.body.appendChild(el);
      focused?.focus();
    } else if (!shown && el.ownerDocument !== document) document.body.appendChild(el);
  }).observe(el, { attributes: true, attributeFilter: ['class'] });
}

(function wireModeration() {
  const chip = document.getElementById('mod-chip');
  const modal = document.getElementById('mod-modal');
  if (!chip || !modal || !window.nebula?.modRequest) return;
  const $ = (id) => document.getElementById(id) || modal.querySelector(`#${CSS.escape(id)}`);
  const badge = $('mod-chip-badge');
  const flagList = $('mod-flag-list');
  const reportList = $('mod-report-list');
  const banList = $('mod-ban-list');
  const muteList = $('mod-mute-list');
  const search = $('mod-flag-search');
  const reportSearch = $('mod-report-search');
  const refreshBtn = $('mod-refresh');
  const SEEN_KEY = 'solar.mod.seenFlagAt';
  const ICON_BAN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A7.96 7.96 0 0 1 4 12zm8 8a7.96 7.96 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>';
  const ICON_MUTE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/><path d="M5 3l15 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const ICON_DEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
  const ICON_IMG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg>';
  const ICON_VID = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>';
  const ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5.25 3.4 10.1 8 11 4.6-.9 8-5.75 8-11V5l-8-3zm-1.2 14.2-3.5-3.5 1.4-1.4 2.1 2.1 4.9-4.9 1.4 1.4-6.3 6.3z"/></svg>';
  const ICON_FIND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>';

  let isMod = false;
  let data = { flags: [], reports: [], bans: [], mutes: [], webhook: false };
  let flagFilter = 'all';
  const fileCache = new Map();   // file id -> blob url
  let unseen = 0;

  const seenAt = () => Number(localStorage.getItem(SEEN_KEY) || 0);
  // Swearing in live chat is logged but too common to ping about.
  const loud = (f) => f.kind !== 'swear';
  const setBadge = () => {
    badge.textContent = unseen > 99 ? '99+' : String(unseen);
    badge.classList.toggle('hidden', unseen === 0);
  };
  const isOpen = () => !modal.classList.contains('hidden');
  const when = (t) => {
    const d = new Date(t);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const ago = (t) => {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  const stamp = (t) => `<time title="${escapeHtml(when(t))}">${escapeHtml(ago(t))}</time>`;

  function setAccess(on) {
    isMod = !!on;
    chip.classList.toggle('hidden', !isMod);
    if (!isMod) { if (modFloat.win) scDock('admin', { gone: true }); modal.classList.add('hidden'); return; }
    load(false);
  }

  async function load(spin = true) {
    if (!isMod) return;
    if (spin) refreshBtn.classList.add('spin');
    try {
      const d = await window.nebula.modRequest({ op: 'overview' });
      data = { flags: d.flags || [], reports: d.reports || [], bans: d.bans || [], mutes: d.mutes || [], webhook: !!d.webhook };
      const seen = seenAt();
      unseen = isOpen() ? 0 : data.flags.filter(f => loud(f) && f.at > seen).length + data.reports.filter(r => r.at > seen).length;
      setBadge();
      renderAll();
    } catch (err) {
      if (isOpen()) showToast("Couldn't load moderation", escapeHtml(cleanErr(err)), 'error');
    } finally {
      refreshBtn.classList.remove('spin');
    }
  }

  function renderAll() {
    renderFlags();
    renderReports();
    renderBans();
    renderMutes();
    renderDiscord();
    const counts = [['mod-flags-n', data.flags.filter(loud).length], ['mod-reports-n', data.reports.length],
      ['mod-bans-n', data.bans.length], ['mod-mutes-n', data.mutes.length]];
    for (const [id, n] of counts) {
      $(id).textContent = String(n);
      $(id).closest('.mod-tab').classList.toggle('has', n > 0 && (id === 'mod-flags-n' || id === 'mod-reports-n'));
    }
    $('mod-ff-all').textContent = String(data.flags.length);
    $('mod-ff-hate').textContent = String(data.flags.filter(loud).length);
    $('mod-ff-swear').textContent = String(data.flags.length - data.flags.filter(loud).length);
    const review = data.flags.filter(loud).length + data.reports.length;
    const bits = [review ? `${review} to review` : 'Nothing to review',
      `${data.bans.length} ${data.bans.length === 1 ? 'ban' : 'bans'}`, `${data.mutes.length} ${data.mutes.length === 1 ? 'mute' : 'mutes'}`];
    $('mod-sub').textContent = bits.join(' · ');
    $('mod-sub').classList.toggle('busy', review > 0);
  }

  const actBtns = () => `
    <div class="mod-flag-actions">
      <button type="button" class="mod-act" data-act="delete" title="Delete">${ICON_DEL}Delete</button>
      <button type="button" class="mod-act mute" data-act="mute" title="Mute in live chat">${ICON_MUTE}Mute</button>
      <button type="button" class="mod-act ban" data-act="ban" title="Ban from SolarClient">${ICON_BAN}Ban</button>
    </div>`;
  const newDot = (on) => (on ? '<i class="mod-new-dot" title="New since you last looked"></i>' : '');
  const empty = (icon, title, text) => `<div class="mod-empty"><span class="mod-empty-ic">${icon}</span><b>${title}</b>${text}</div>`;

  function renderFlags() {
    const q = search.value.trim().toLowerCase();
    const seen = Number(modal.dataset.seenBefore || 0);
    const rows = data.flags.filter(f => (flagFilter === 'all' || (flagFilter === 'swear') === !loud(f))
      && (!q || `${f.name} ${f.where} ${f.text}`.toLowerCase().includes(q)));
    if (!rows.length) {
      flagList.innerHTML = data.flags.length
        ? empty(ICON_FIND, 'Nothing matches', 'Try a different name or word.')
        : empty(ICON_OK, 'All clear', 'Slurs, hate speech, telling people to hurt themselves and swearing in live chat are stopped before they send and show up here.');
      return;
    }
    flagList.innerHTML = rows.map(f => `
      <div class="mod-card mod-flag ${f.at > seen && loud(f) ? 'new' : ''} ${loud(f) ? '' : 'swear'}" data-id="${escapeHtml(f.id)}">
        <div class="mod-card-head">
          <img class="mod-face" src="${frAvatar(f.from)}" alt="" ${personAttr(f.from, f.name)}>
          <div class="mod-who">
            <b>${newDot(f.at > seen && loud(f))}<span ${personAttr(f.from, f.name)}>${escapeHtml(f.name)}</span></b>
            <span>${escapeHtml(f.where)} · ${stamp(f.at)}</span>
          </div>
          <span class="mod-tag ${loud(f) ? 'why' : 'swear'}">${escapeHtml(f.matched || 'flagged')}</span>
        </div>
        <div class="mod-flag-text" title="Click to show all">${escapeHtml(f.text)}</div>
        ${actBtns()}
      </div>`).join('');
  }

  function renderReports() {
    const q = reportSearch.value.trim().toLowerCase();
    const seen = Number(modal.dataset.seenBefore || 0);
    const rows = data.reports.filter(r => !q || `${r.targetName} ${r.fromName} ${r.reasonLabel} ${r.details} ${r.context?.text || ''}`.toLowerCase().includes(q));
    if (!rows.length) {
      reportList.innerHTML = data.reports.length
        ? empty(ICON_FIND, 'Nothing matches', 'Try a different name, reason or word.')
        : empty(ICON_OK, 'No reports', 'When someone reports a player from live chat, a DM or the online list, it shows up here with any screenshots or clips they attached.');
      return;
    }
    reportList.innerHTML = rows.map(r => `
      <div class="mod-card mod-report ${r.at > seen ? 'new' : ''}" data-id="${escapeHtml(r.id)}">
        <div class="mod-card-head">
          <img class="mod-face" src="${frAvatar(r.target)}" alt="" ${personAttr(r.target, r.targetName)}>
          <div class="mod-who">
            <b>${newDot(r.at > seen)}<span ${personAttr(r.target, r.targetName)}>${escapeHtml(r.targetName)}</span></b>
            <span class="mod-report-by">reported by <img src="${frAvatar(r.from)}" alt=""><span ${personAttr(r.from, r.fromName)}>${escapeHtml(r.fromName)}</span> · ${stamp(r.at)} · #${escapeHtml(r.id)}</span>
          </div>
          <span class="mod-tag why">${escapeHtml(r.reasonLabel)}</span>
        </div>
        <div class="mod-report-details">${escapeHtml(r.details)}</div>
        ${r.context?.text ? `<div class="mod-report-quote"><span>${escapeHtml(r.context.where || 'Message')}</span>${escapeHtml(r.context.text)}</div>` : ''}
        ${r.files.length ? `<div class="mod-report-files">${r.files.map((f, i) => {
          const cached = fileCache.get(f.id);
          const video = f.type.startsWith('video/');
          return `<button type="button" class="mod-file ${cached ? 'loaded' : ''}" data-file="${escapeHtml(f.id)}" title="Open">
            ${cached && !video ? `<img src="${cached}" alt="">` : `<span class="mod-file-ic">${video ? ICON_VID : ICON_IMG}</span>`}
            <span class="mod-file-label">${video ? 'Video' : 'Image'} ${i + 1}<em>${fmtSize(f.size)}</em></span>
          </button>`;
        }).join('')}</div>` : ''}
        ${r.filesRemoved ? '<div class="mod-report-gone">Attachments were removed to save space.</div>' : ''}
        ${actBtns()}
      </div>`).join('');
  }

  /** One active ban or mute: who, how long, why, and how much of it is left. */
  function sentenceCard(p, key, act) {
    const temp = !!p.until;
    const served = temp ? Math.min(100, Math.max(0, ((Date.now() - p.at) / Math.max(1, p.until - p.at)) * 100)) : 100;
    return `
      <div class="mod-card mod-ban-row ${temp ? 'temp' : 'perm'}" ${key}>
        <div class="mod-card-head">
          <img class="mod-face" src="${frAvatar(p.uuid)}" alt="" ${personAttr(p.uuid, p.name)}>
          <div class="mod-who">
            <b><span ${personAttr(p.uuid, p.name)}>${escapeHtml(p.name)}</span></b>
            <span>${p.byName ? `by ${escapeHtml(p.byName)} · ` : ''}${stamp(p.at)}${p.id ? ` · #${escapeHtml(p.id)}` : ''}</span>
          </div>
          <span class="mod-tag ${temp ? 'temp' : 'perm'}">${escapeHtml(temp ? p.length : 'Permanent')}</span>
        </div>
        ${p.reason ? `<div class="mod-ban-reason">${escapeHtml(p.reason)}</div>` : ''}
        <div class="mod-term">
          <div class="mod-term-bar"><i style="width:${served.toFixed(1)}%"></i></div>
          <span>${temp ? `${escapeHtml(fmtLeft(p.until - Date.now()))} left · ends ${escapeHtml(when(p.until))}` : 'Never ends'}</span>
          <button type="button" class="mod-act" data-act="${act}">${act === 'unban' ? 'Unban' : 'Unmute'}</button>
        </div>
      </div>`;
  }

  function renderBans() {
    banList.innerHTML = data.bans.length
      ? data.bans.map(b => sentenceCard(b, `data-id="${escapeHtml(b.id)}"`, 'unban')).join('')
      : empty(ICON_OK, 'No active bans', 'Bans you add show up here until they end.');
  }

  function renderMutes() {
    muteList.innerHTML = data.mutes.length
      ? data.mutes.map(m => sentenceCard(m, `data-uuid="${escapeHtml(m.uuid)}"`, 'unmute')).join('')
      : empty(ICON_OK, 'Nobody is muted', 'Muted players can still use the launcher, they just can\'t send messages in live chat.');
  }

  function renderDiscord() {
    const st = $('mod-discord-status');
    st.className = `mod-discord-status ${data.webhook ? 'ok' : 'off'}`;
    st.textContent = data.webhook ? 'Discord log is connected' : 'No Discord webhook set on the server';
    $('mod-discord-dot').className = `mod-dot ${data.webhook ? 'ok' : 'off'}`;
  }

  // Same rules as the server: m, h, d, w, mo, y/yr, any capitals, combos like 1d12h, or perm.
  function parseDur(input) {
    const s = String(input || '').toLowerCase().replace(/\s+/g, '');
    if (!s) return { empty: true };
    if (/^(?:perm|perma|permanent|forever|never|p)$/.test(s)) return { ms: null };
    const units = [[/^(?:y|yr|yrs|year|years)$/, 525600], [/^(?:mo|mos|mon|mons|month|months)$/, 43200],
      [/^(?:w|wk|wks|week|weeks)$/, 10080], [/^(?:d|day|days)$/, 1440], [/^(?:h|hr|hrs|hour|hours)$/, 60],
      [/^(?:m|min|mins|minute|minutes)$/, 1]];
    const re = /(\d+(?:\.\d+)?)([a-z]+)/g;
    let total = 0; let used = 0; let m;
    while ((m = re.exec(s))) {
      const u = units.find(([rx]) => rx.test(m[2]));
      if (!u) return { bad: `"${m[2]}" isn't a time unit` };
      total += Number(m[1]) * u[1];
      used += m[0].length;
    }
    if (used !== s.length || total <= 0) return { bad: 'Use a number and a unit, like 30m or 7d' };
    return { ms: Math.min(total, 100 * 525600) * 60000 };
  }
  const fmtUntil = (ms) => new Date(Date.now() + ms).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  /** The ban and mute forms work the same way; this wires one of them. */
  function punishForm({ kind, formId, userId, durId, reasonId, previewId, quickId, goId, idle, verb, done }) {
    const form = $(formId), userIn = $(userId), durIn = $(durId), reasonIn = $(reasonId);
    const preview = $(previewId), go = $(goId);
    const pane = form.closest('.mod-pane');
    const setOpen = (on) => {
      pane.classList.toggle('form-open', on);
      if (on) userIn.focus();
    };
    pane.querySelector(`[data-open-form="${formId}"]`)?.addEventListener('click', () => setOpen(true));
    form.querySelector('.mod-form-cancel')?.addEventListener('click', () => { form.reset(); uuid = null; update(); setOpen(false); });
    let uuid = null;
    const update = () => {
      const d = parseDur(durIn.value);
      $(quickId).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.d === durIn.value.trim().toLowerCase()));
      preview.className = 'mod-preview';
      if (d.empty) preview.textContent = idle;
      else if (d.bad) { preview.classList.add('bad'); preview.textContent = d.bad; }
      else if (d.ms === null) { preview.classList.add('perm'); preview.textContent = `Permanent. It never ends unless you ${kind === 'ban' ? 'unban' : 'unmute'} them.`; }
      else { preview.classList.add('ok'); preview.textContent = `${verb} for ${fmtLeft(d.ms)}, until ${fmtUntil(d.ms)}.`; }
    };
    $(quickId).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-d]');
      if (!b) return;
      durIn.value = b.dataset.d;
      update();
    });
    durIn.addEventListener('input', update);
    userIn.addEventListener('input', () => { uuid = null; });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = userIn.value.trim();
      const duration = durIn.value.trim();
      const reason = reasonIn.value.trim();
      const d = parseDur(duration);
      const label = kind === 'ban' ? 'Ban' : 'Mute';
      if (!/^\w{2,16}$/.test(username)) { showToast(label, 'Enter their Minecraft username.', 'error'); userIn.focus(); return; }
      if (d.empty || d.bad) { showToast(label, escapeHtml(d.bad || 'Enter how long, like 30m, 12h, 7d, 1mo, 1y or perm.'), 'error'); durIn.focus(); return; }
      if (!reason) { showToast(label, 'Enter a reason. The player sees it.', 'error'); reasonIn.focus(); return; }
      const ok = await showConfirm(
        kind === 'ban'
          ? `${d.ms === null ? 'Permanently' : `For ${fmtLeft(d.ms)}`}. They'll be kicked right away and locked out of the launcher on their account and computer.`
          : `${d.ms === null ? 'Permanently' : `For ${fmtLeft(d.ms)}`}. They won't be able to send messages in live chat.`,
        { title: `${label} ${username}?`, confirmLabel: kind === 'ban' ? 'Ban player' : 'Mute player' });
      if (!ok) return;
      go.disabled = true;
      const idleLabel = go.textContent;
      go.textContent = kind === 'ban' ? 'Banning…' : 'Muting…';
      try {
        const res = await window.nebula.modRequest({ op: kind, username, uuid: uuid || undefined, duration, reason });
        form.reset(); uuid = null; update(); setOpen(false);
        done(res, username);
      } catch (err) {
        showToast(`Couldn't ${kind}`, escapeHtml(cleanErr(err)), 'error');
      } finally {
        go.disabled = false;
        go.textContent = idleLabel;
      }
    });
    update();
    return {
      prefill(p) {
        uuid = p.uuid || null;
        userIn.value = p.name || '';
        reasonIn.value = p.reason || '';
        if (!durIn.value) durIn.value = p.duration;
        update();
        showTab(kind === 'ban' ? 'bans' : 'mutes');
        setOpen(true);
        durIn.focus();
        durIn.select();
      },
    };
  }

  const discordNote = (res) => (res.discord === 'sent' ? 'Logged to Discord.' : `Discord log failed: ${res.discord}`);
  const banForm = punishForm({
    kind: 'ban', formId: 'mod-ban-form', userId: 'mod-ban-user', durId: 'mod-ban-dur', reasonId: 'mod-ban-reason',
    previewId: 'mod-ban-preview', quickId: 'mod-ban-quick', goId: 'mod-ban-go', verb: 'Banned',
    idle: "m = minutes, h = hours, d = days, w = weeks, mo = months, y or yr = years. Capitals don't matter.",
    done: (res, username) => {
      data.bans = res.bans;
      renderAll();
      showToast(escapeHtml(`${res.ban?.name || username} banned`), escapeHtml(`${res.ban?.length || ''} · ${discordNote(res)}`),
        res.discord === 'sent' ? 'success' : 'error');
    },
  });
  const muteForm = punishForm({
    kind: 'mute', formId: 'mod-mute-form', userId: 'mod-mute-user', durId: 'mod-mute-dur', reasonId: 'mod-mute-reason',
    previewId: 'mod-mute-preview', quickId: 'mod-mute-quick', goId: 'mod-mute-go', verb: 'Muted in live chat',
    idle: 'A mute stops them sending messages in live chat. They can still use the rest of the launcher.',
    done: (res, username) => {
      data.mutes = res.mutes;
      renderAll();
      showToast(escapeHtml(`${res.name || username} muted`), escapeHtml(`${res.length || ''} · ${discordNote(res)}`),
        res.discord === 'sent' ? 'success' : 'error');
    },
  });

  function showTab(tab) {
    modal.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    modal.querySelectorAll('.mod-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== tab));
  }

  function open() {
    if (!isMod) return;
    modal.dataset.seenBefore = String(seenAt());
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    unseen = 0; setBadge();
    modal.classList.remove('hidden');
    chip.classList.add('open');
    placeBox(boxNow());
    scFloatFit(modFloat, { glide: false });
    popDown(panel, chip);
    renderAll();
    load();
  }
  const close = () => {
    if (modFloat.win) { scDock('admin', { shut: true }); return; }
    chip.classList.remove('open');
    popClose(panel, () => modal.classList.add('hidden'));
  };

  // A tall floating box you can drag and resize, like live chat.
  const panel = modal.querySelector('.mod-panel');
  const head = modal.querySelector('.mod-head');
  const BOX_KEY = 'solar.mod.box';
  const MIN_W = 380, MIN_H = 360;
  const defaultBox = () => ({ x: 84, y: 52, w: 460, h: Math.min(760, window.innerHeight - 70) });
  const boxNow = () => {
    try {
      const b = JSON.parse(localStorage.getItem(BOX_KEY) || 'null');
      if (b && [b.x, b.y, b.w, b.h].every(Number.isFinite)) return b;
    } catch { /* ignore */ }
    return defaultBox();
  };
  const placeBox = (b) => {
    const w = Math.max(MIN_W, Math.min(b.w, window.innerWidth - 16));
    const h = Math.max(MIN_H, Math.min(b.h, window.innerHeight - 48));
    const x = Math.max(8, Math.min(b.x, window.innerWidth - w - 8));
    const y = Math.max(40, Math.min(b.y, window.innerHeight - h - 8));
    Object.assign(panel.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
  };
  const saveBox = () => {
    const r = panel.getBoundingClientRect();
    try {
      localStorage.setItem(BOX_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }));
    } catch { /* full */ }
  };
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input') || modFloat.win) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    modal.classList.add('dragging');
    const move = scPerFrame((ev) => {
      placeBox({ x: ev.clientX - ox, y: ev.clientY - oy, w: r.width, h: r.height });
      scFloatDrag(modFloat, ev, { x: ev.clientX - ox, y: ev.clientY - oy, w: r.width, h: r.height });
    });
    const up = (ev) => {
      move.flush();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      modal.classList.remove('dragging');
      saveBox();
      scFloatDrop(modFloat, ev, { x: ox, y: oy });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  panel.querySelectorAll('.mod-rz').forEach((grip) => grip.addEventListener('mousedown', (e) => {
    scResize(e, grip, { f: modFloat, panel, host: modal, minW: MIN_W, minH: MIN_H, save: saveBox });
  }));
  window.addEventListener('resize', () => { if (isOpen() && !modFloat.win) placeBox(boxNow()); });
  scPanelScale(panel, 460);
  const modFloat = scFloatAdd('admin', {
    panel, host: modal, chip, closeBtn: $('mod-close'), btnClass: 'mod-icon-btn',
    title: 'Admin panel', isOpen, close,
    place: (x, y) => placeBox({ x, y, w: panel.offsetWidth, h: panel.offsetHeight }),
    save: saveBox,
    restore: () => placeBox(boxNow()),
    resize: (w, h) => placeBox({ ...boxNow(), w, h }),
  });
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || modFloat.win) return;
    try { localStorage.removeItem(BOX_KEY); } catch { /* ignore */ }
    placeBox(defaultBox());
  });
  // 1-4 switch tabs, / searches, R refreshes; only while the panel has focus.
  panel.tabIndex = -1;
  panel.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest('input, textarea, select')) return;
    const tabs = ['flags', 'reports', 'bans', 'mutes'];
    if (/^[1-4]$/.test(e.key)) { e.preventDefault(); showTab(tabs[Number(e.key) - 1]); }
    else if (e.key === '/') {
      e.preventDefault();
      const pane = modal.querySelector('.mod-pane:not(.hidden)');
      (pane?.querySelector('.mod-search input') || search).focus();
    } else if (e.key.toLowerCase() === 'r') { e.preventDefault(); load(); }
  });
  panel.addEventListener('mousedown', (e) => { if (!e.target.closest('input, textarea, button, select')) panel.focus({ preventScroll: true }); });
  modal.addEventListener('click', (e) => {
    const t = e.target.closest('.mod-flag-text, .mod-report-details, .mod-ban-reason');
    if (t && !window.getSelection()?.toString()) t.classList.toggle('open');
  });

  // ---- evidence viewer ----
  const viewer = $('mod-viewer');
  const viewerMedia = $('mod-viewer-media');
  const closeViewer = () => {
    viewer.classList.add('hidden');
    viewerMedia.querySelector('video')?.pause();
    viewerMedia.innerHTML = '';
  };
  async function openFile(report, fileId, btn) {
    const f = report.files.find(x => x.id === fileId);
    if (!f) return;
    let url = fileCache.get(fileId);
    if (!url) {
      btn?.classList.add('loading');
      try {
        const res = await window.nebula.modFile({ id: report.id, file: fileId });
        url = URL.createObjectURL(new Blob([res.data], { type: res.type }));
        fileCache.set(fileId, url);
      } catch (err) {
        showToast("Couldn't open file", escapeHtml(cleanErr(err)), 'error');
        return;
      } finally {
        btn?.classList.remove('loading');
      }
      renderReports();
    }
    viewerMedia.innerHTML = f.type.startsWith('video/')
      ? `<video src="${url}" controls autoplay></video>`
      : `<img src="${url}" alt="">`;
    viewer.classList.remove('hidden');
  }
  $('mod-viewer-close').addEventListener('click', closeViewer);
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });

  chip.addEventListener('click', () => (isOpen() ? close() : open()));
  $('mod-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!viewer.classList.contains('hidden')) closeViewer();
    else if (isOpen() && !modFloat.win) close();
  });
  refreshBtn.addEventListener('click', () => load());
  modal.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  search.addEventListener('input', renderFlags);
  reportSearch.addEventListener('input', renderReports);
  $('mod-flag-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    flagFilter = b.dataset.f;
    $('mod-flag-filter').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    renderFlags();
  });

  flagList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const f = data.flags.find(x => x.id === btn.closest('.mod-flag')?.dataset.id);
    if (!f) return;
    const why = `${f.matched ? f.matched[0].toUpperCase() + f.matched.slice(1) : 'Breaking the rules'} in ${f.where}: "${f.text.slice(0, 160)}"`;
    if (btn.dataset.act === 'ban') return banForm.prefill({ uuid: f.from, name: f.name, reason: why, duration: '7d' });
    if (btn.dataset.act === 'mute') return muteForm.prefill({ uuid: f.from, name: f.name, reason: why, duration: loud(f) ? '1d' : '1h' });
    btn.disabled = true;
    try {
      await window.nebula.modRequest({ op: 'flag_delete', id: f.id });
      data.flags = data.flags.filter(x => x.id !== f.id);
      renderAll();
    } catch (err) {
      btn.disabled = false;
      showToast("Couldn't delete", escapeHtml(cleanErr(err)), 'error');
    }
  });

  reportList.addEventListener('click', async (e) => {
    const row = e.target.closest('.mod-report');
    const r = data.reports.find(x => x.id === row?.dataset.id);
    if (!r) return;
    const file = e.target.closest('[data-file]');
    if (file) return openFile(r, file.dataset.file, file);
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const why = `${r.reasonLabel} (report #${r.id}): ${r.details.slice(0, 200)}`;
    if (btn.dataset.act === 'ban') return banForm.prefill({ uuid: r.target, name: r.targetName, reason: why, duration: '7d' });
    if (btn.dataset.act === 'mute') return muteForm.prefill({ uuid: r.target, name: r.targetName, reason: why, duration: '1d' });
    const ok = await showConfirm(`Delete ${r.fromName}'s report on ${r.targetName}${r.files.length ? ' and its attachments' : ''}? It's removed for both mods.`,
      { title: 'Delete report?', confirmLabel: 'Delete' });
    if (!ok) return;
    btn.disabled = true;
    try {
      await window.nebula.modRequest({ op: 'report_delete', id: r.id });
      for (const f of r.files) { const u = fileCache.get(f.id); if (u) URL.revokeObjectURL(u); fileCache.delete(f.id); }
      data.reports = data.reports.filter(x => x.id !== r.id);
      renderAll();
    } catch (err) {
      btn.disabled = false;
      showToast("Couldn't delete", escapeHtml(cleanErr(err)), 'error');
    }
  });

  $('mod-clear-flags').addEventListener('click', async () => {
    if (!data.flags.length) return;
    const ok = await showConfirm(`This removes all ${data.flags.length} flagged messages for both mods. It can't be undone.`,
      { title: 'Delete every flagged message?', confirmLabel: 'Delete all' });
    if (!ok) return;
    try {
      await window.nebula.modRequest({ op: 'flags_clear' });
      data.flags = [];
      renderAll();
    } catch (err) { showToast("Couldn't delete", escapeHtml(cleanErr(err)), 'error'); }
  });
  $('mod-clear-reports').addEventListener('click', async () => {
    if (!data.reports.length) return;
    const ok = await showConfirm(`This removes all ${data.reports.length} reports and their attachments for both mods. It can't be undone.`,
      { title: 'Delete every report?', confirmLabel: 'Delete all' });
    if (!ok) return;
    try {
      await window.nebula.modRequest({ op: 'reports_clear' });
      for (const u of fileCache.values()) URL.revokeObjectURL(u);
      fileCache.clear();
      data.reports = [];
      renderAll();
    } catch (err) { showToast("Couldn't delete", escapeHtml(cleanErr(err)), 'error'); }
  });

  banList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="unban"]');
    if (!btn) return;
    const b = data.bans.find(x => x.id === btn.closest('.mod-ban-row')?.dataset.id);
    if (!b) return;
    const ok = await showConfirm('They can use SolarClient again straight away.', { title: `Unban ${b.name}?`, confirmLabel: 'Unban' });
    if (!ok) return;
    btn.disabled = true;
    try {
      const res = await window.nebula.modRequest({ op: 'unban', id: b.id });
      data.bans = res.bans;
      renderAll();
      showToast('Unbanned', escapeHtml(`${b.name} can play again. ${discordNote(res)}`), 'success');
    } catch (err) {
      btn.disabled = false;
      showToast("Couldn't unban", escapeHtml(cleanErr(err)), 'error');
    }
  });
  muteList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act="unmute"]');
    if (!btn) return;
    const m = data.mutes.find(x => x.uuid === btn.closest('.mod-ban-row')?.dataset.uuid);
    if (!m) return;
    btn.disabled = true;
    try {
      const res = await window.nebula.modRequest({ op: 'unmute', uuid: m.uuid });
      data.mutes = res.mutes;
      renderAll();
      showToast('Unmuted', escapeHtml(`${m.name} can talk in live chat again. ${discordNote(res)}`), 'success');
    } catch (err) {
      btn.disabled = false;
      showToast("Couldn't unmute", escapeHtml(cleanErr(err)), 'error');
    }
  });

  $('mod-discord-test').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const out = $('mod-discord-result');
    btn.disabled = true;
    out.className = 'mod-discord-result';
    out.textContent = 'Sending…';
    try {
      await window.nebula.modRequest({ op: 'webhook_test' });
      out.classList.add('ok');
      out.textContent = 'Sent. Check the Discord channel.';
      data.webhook = true; renderDiscord();
    } catch (err) {
      out.classList.add('bad');
      out.textContent = cleanErr(err);
    } finally {
      setTimeout(() => { btn.disabled = false; }, 3000);
    }
  });

  window.nebula.onModEvent((m) => {
    if (m.kind === 'access') { setAccess(!!m.isMod); return; }
    if (!isMod) return;
    if (m.kind === 'flag' && m.flag) {
      if (!data.flags.some(f => f.id === m.flag.id)) data.flags.unshift(m.flag);
      if (isOpen()) { renderAll(); localStorage.setItem(SEEN_KEY, String(Date.now())); }
      else if (loud(m.flag)) {
        unseen++; setBadge();
        showToast('Message flagged', `${escapeHtml(m.flag.name)} in ${escapeHtml(m.flag.where)}`, 'error');
      }
    } else if (m.kind === 'report' && m.report) {
      if (!data.reports.some(r => r.id === m.report.id)) data.reports.unshift(m.report);
      if (isOpen()) { renderAll(); localStorage.setItem(SEEN_KEY, String(Date.now())); }
      else {
        unseen++; setBadge();
        showToast('New report', `${escapeHtml(m.report.fromName)} reported ${escapeHtml(m.report.targetName)}: ${escapeHtml(m.report.reasonLabel)}`, 'error');
      }
    } else if (m.kind === 'changed') {
      load(false);
    }
  });
  window.nebula.onFriendsConnection?.((c) => {
    if (c && typeof c.isMod === 'boolean') setAccess(c.isMod);
    else if (c && !c.connected) setAccess(false);
  });
  window.nebula.modAccess().then(setAccess).catch(() => {});
})();

// A message the server refused for breaking the chat rules.
window.nebula?.onFriendsBlocked?.((b) => {
  showToast('Message not sent', escapeHtml(b?.reason || 'It breaks the SolarClient chat rules.'), 'error');
});

// ---- prewarm chip (background pre-download status) ----
const prewarmChip = document.getElementById('prewarm-chip');
let prewarmHideTimer = null;
// Same treatment as onProgress: the prewarm downloader fires per file, and
// this handler read a <select>'s value and did four getElementById() lookups
// every time. Cache the nodes, coalesce to one frame.
const prewarmEls = {
  select: null,   // resolved lazily -- it may not exist yet at parse time
  label:  null,
  fill:   null,
};
let prewarmPending = null, prewarmQueued = false;

function flushPrewarm() {
  prewarmQueued = false;
  const p = prewarmPending;
  prewarmPending = null;
  if (!p) return;
  if (!prewarmEls.label) {
    prewarmEls.label = document.getElementById('prewarm-label');
    prewarmEls.fill  = document.getElementById('prewarm-fill');
  }
  if (prewarmEls.label && prewarmEls.label.textContent !== p.text) prewarmEls.label.textContent = p.text;
  if (prewarmEls.fill && prewarmEls.fill.style.width !== p.width) prewarmEls.fill.style.width = p.width;
}

window.nebula.onPrewarmProgress((p) => {
  if (!prewarmEls.select) prewarmEls.select = document.getElementById('launch-instance-select');
  const sel = prewarmEls.select ? prewarmEls.select.value : '';
  if (!sel) return;
  const [name, version] = sel.split('|');
  if (p.instanceName !== name || p.versionNumber !== version) return;

  clearTimeout(prewarmHideTimer);
  if (p.error) { prewarmChip.classList.add('hidden'); delete prewarmChip.dataset.active; return; }
  if (p.done) {
    if (p.totalBytes > 0 || !prewarmChip.classList.contains('hidden')) {
      prewarmChip.classList.remove('hidden');
      prewarmChip.classList.add('done');
      prewarmPending = null;   // a queued in-flight update must not overwrite "done"
      document.getElementById('prewarm-label').textContent = 'Files ready — instant launch ✓';
      document.getElementById('prewarm-fill').style.width = '100%';
      prewarmHideTimer = setTimeout(() => { prewarmChip.classList.add('hidden'); delete prewarmChip.dataset.active; }, 3500);
    }
    return;
  }
  if (p.totalBytes > 0) {
    if (currentEdition !== 'java') return;
    prewarmChip.dataset.active = '1';
    prewarmChip.classList.remove('hidden', 'done');
    const mb = (p.doneBytes / 1048576).toFixed(0);
    const mbT = (p.totalBytes / 1048576).toFixed(0);
    const spd = fmtSpeed(p.bytesPerSec);
    prewarmPending = {
      text: `Pre-downloading ${mb}/${mbT} MB${spd ? ' · ' + spd : ''}`,
      width: `${p.percent.toFixed(0)}%`,
    };
    if (!prewarmQueued) { prewarmQueued = true; requestAnimationFrame(flushPrewarm); }
  }
});

async function launchInstance(accountId) {
  const selVal = document.getElementById('launch-instance-select').value;
  if (!selVal) return;
  const [instanceName, versionNumber, loader] = selVal.split('|');
  const memoryMaxGB = theme.memMax || 4;
  const memoryMinGB = Math.min(theme.memMin || 2, memoryMaxGB);

  crashBanner.classList.add('hidden');
  launchProgress.classList.add('hidden');
  document.getElementById('launch-progress-fill').style.width = '0%';
  gameWindowUp = false;
  gameProcessStarted = false;
  showOverlay(`Launching ${instanceName}`);
  pendingRecentLaunch = { name: instanceName, versionNumber, loader: loader || 'vanilla' };

  try {
    const p = window.nebula.launchGame({
      instanceName, versionNumber, loader, memoryMaxGB, memoryMinGB, accountId,
      performanceMode: !!theme.perfMode,
    });
    const res = await p;
    if (res?.launchId) myLaunchIds.add(res.launchId);
    commitRecentLaunch();
  } catch (err) {
    pendingRecentLaunch = null;
    hideOverlay();
    launchProgress.classList.add('hidden');
    showToast('Launch failed', err.message, 'error');
  }
}

let pendingRecentLaunch = null;
let gameWindowUp = false;
let gameProcessStarted = false;
function commitRecentLaunch() {
  if (!pendingRecentLaunch) return;
  rememberRecentLaunch(pendingRecentLaunch);
  pendingRecentLaunch = null;
  refreshInstanceSelects().catch(() => {});
}

function renderRunningIndicator() {
  // Running text was removed from the topbar (replaced by Online count).
  // Keep this as a no-op so existing call sites stay safe.
}

const OI_ICON = {
  online: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>',
  game: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 6H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zm-10 7H8v3H6v-3H3v-2h3V8h2v3h3v2zm4.5 2a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm4-3a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/></svg>',
};
const OP_STAT_ICON = {
  offline: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7z"/></svg>',
  launcher: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/></svg>',
  hidden: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 0 1 5 5c0 .65-.13 1.26-.36 1.83l2.92 2.92A11.8 11.8 0 0 0 23 12c-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16A4.9 4.9 0 0 1 12 7zM2 4.27l2.28 2.28.46.46A11.8 11.8 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3zM7.53 9.8l1.55 1.55A2.8 2.8 0 0 0 9 12a3 3 0 0 0 3 3c.22 0 .44-.03.65-.08l1.55 1.55A5 5 0 0 1 7 12c0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16a3 3 0 0 0-3-3z"/></svg>',
};

let oiHidden = null;
let oiOffline = 0;
let oiHiddenAsk = false;
// Hovering a presence dot (online chip, online list, community members) says
// what it means. Pop-out windows get their own copy via scDotTips(doc).
const SC_DOT_TIP = '.oi-dot[data-tip], .op-dot[data-tip], .cs-person-dot[data-tip], .cs-mem-on[data-tip]';
function scDotTips(doc) {
  const win = doc.defaultView;
  let tip = null, on = null, titled = null;
  const hide = () => {
    if (!on) return;
    on = null;
    tip?.classList.remove('on');
    if (titled) {
      if (titled.dataset.title != null) { titled.title = titled.dataset.title; delete titled.dataset.title; }
      titled = null;
    }
  };
  doc.addEventListener('pointerover', (e) => {
    const dot = e.target.closest?.(SC_DOT_TIP);
    if (!dot) { hide(); return; }
    if (dot === on) return;
    hide();
    on = dot;
    if (!tip || !tip.isConnected) {
      tip = doc.createElement('div');
      tip.className = 'oi-tip';
      doc.body.appendChild(tip);
    }
    const mark = dot.querySelector('i') || dot;
    tip.textContent = dot.dataset.tip;
    tip.style.setProperty('--dot', win.getComputedStyle(mark).backgroundColor);
    titled = dot.parentElement?.closest('[title]') || null;
    if (titled && titled.dataset.title == null) { titled.dataset.title = titled.title; titled.title = ''; }
    const r = scRect(mark);
    const below = r.bottom + 40 < win.innerHeight;
    tip.classList.toggle('above', !below);
    tip.style.left = `${Math.round(r.left + r.width / 2)}px`;
    tip.style.top = `${Math.round(below ? r.bottom + 10 : r.top - 10)}px`;
    win.requestAnimationFrame(() => tip.classList.add('on'));
  });
  doc.addEventListener('pointerdown', hide, true);
  doc.addEventListener('scroll', hide, true);
  doc.documentElement.addEventListener('pointerleave', hide);
  win.addEventListener('blur', hide);
}
scDotTips(document);
async function refreshOnlineIndicator() {
  const el = document.getElementById('online-indicator');
  const label = document.getElementById('online-indicator-label');
  const gEl = document.getElementById('ingame-indicator');
  const gLabel = document.getElementById('ingame-indicator-label');
  if (!el || !label) return;
  let counts = null;
  try { counts = await window.nebula.getOnlineCount?.(); } catch { /* offline */ }
  const n = counts?.online;
  if (typeof n === 'number' && n >= 0) {
    el.classList.remove('offline');
    // Beta: one button for every count, laid out like a community's Members button; the In game chip is hidden.
    const g = counts?.inGame;
    if (betaLayoutOn() && oiHidden == null && !oiHiddenAsk) {
      oiHiddenAsk = true;
      window.nebula.onlineList?.().then((d) => { oiHidden = Number(d?.hidden) || 0; oiOffline = Number(d?.offlineTotal) || 0; refreshOnlineIndicator(); })
        .catch(() => {}).finally(() => { oiHiddenAsk = false; });
    }
    const h = Math.min(oiHidden || 0, n);
    const html = betaLayoutOn() && typeof g === 'number' && g >= 0
      ? `<span class="oi-stat on">${OI_ICON.online}<b>${n}</b> online</span>`
        + `<span class="oi-dot game" data-tip="Playing"><i></i>${g}</span>`
        + `<span class="oi-dot hid" data-tip="Hidden"><i></i>${h}</span>`
        + `<span class="oi-dot off" data-tip="Offline"><i></i>${oiOffline}</span>`
      : `<b>${n}</b> online`;
    if (label.innerHTML !== html) label.innerHTML = html;
    if (el.dataset.title != null) el.dataset.title = "See who's online";
    else el.title = "See who's online";
  } else {
    el.classList.add('offline');
    if (betaLayoutOn()) label.innerHTML = `<span class="oi-stat on">${OI_ICON.online}Online —</span>`;
    else label.textContent = 'Online —';
    el.title = 'Could not reach SolarClient online';
  }
  if (gEl && gLabel) {
    const g = counts?.inGame;
    const ok = typeof g === 'number' && g >= 0;
    gEl.classList.toggle('offline', !ok);
    gLabel.textContent = ok ? `${g} in game` : 'In game —';
    gEl.title = ok ? 'People with the game running' : 'Could not reach SolarClient online';
  }
}
setInterval(refreshOnlineIndicator, 20000);
setTimeout(() => refreshOnlineIndicator(), 800);

// Click the online counter to see who's on, follow them, or open their menu.
(function wireOnlineList() {
  const chip = document.getElementById('online-indicator');
  const pop = document.getElementById('online-pop');
  if (!chip || !pop) return;
  const list = document.getElementById('online-pop-list');
  const sub = document.getElementById('online-pop-sub');
  const search = document.getElementById('online-pop-search');
  const viewsEl = document.getElementById('online-pop-views');
  let data = null;
  let timer = null;
  let view = 'all';
  let sel = -1;
  const isOpen = () => !pop.classList.contains('hidden');
  const ROLE_ORDER = ['owner', 'admin', 'manager', 'verified', 'solar+'];
  const ROLE_GROUP = { owner: 'Owners', admin: 'Admins', manager: 'Managers', verified: 'Verified', 'solar+': 'Solar+' };
  const ROLE_ICON = {
    owner: '<path d="M3 7l4.5 3.5L12 4l4.5 6.5L21 7l-2 11H5L3 7zm2.3 13h13.4v2H5.3v-2z"/>',
    admin: '<path d="M12 2 4 5v6c0 5.25 3.4 10.1 8 11 4.6-.9 8-5.75 8-11V5l-8-3z"/>',
    manager: '<path d="M12 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8.2 12.4 6.5 21l5.5-3 5.5 3-1.7-8.6"/>',
    verified: '<path d="M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12zm-12.91 4.72-3.8-3.81 1.48-1.48 2.32 2.33 5.85-5.87 1.48 1.48-7.33 7.35z"/>',
    'solar+': '<path d="M12 2l2.6 6.9L22 9.3l-5.7 4.6 1.9 7.1L12 17l-6.2 4 1.9-7.1L2 9.3l7.4-.4z"/>',
  };
  const roleKey = (p) => String(p.role || '').toLowerCase();
  const roleRank = (p) => {
    const i = ROLE_ORDER.indexOf(roleKey(p));
    return i < 0 ? ROLE_ORDER.length : i;
  };
  const inView = (p) => view === 'all' || (view === 'ingame' ? p.inGame
    : view === 'friends' ? !!p.following && !!p.follower && !p.self : !!p.following && !p.self);
  const OP_ICON = {
    profile: '<svg viewBox="0 0 24 24"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z"/></svg>',
    dm: '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
    caret: '<svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3"/></svg>',
  };
  function moveInk() {
    const on = viewsEl?.querySelector('button.on');
    const ink = viewsEl?.querySelector('.op-views-ink');
    if (!on || !ink) return;
    ink.style.width = `${on.offsetWidth}px`;
    ink.style.transform = `translateX(${on.offsetLeft}px)`;
  }

  // Beta: drag it by the header, resize from any corner; both are remembered.
  const OP_BOX = 'sc.online.box';
  const OP_MIN_W = 380, OP_MIN_H = 300;
  const savedBox = () => {
    try { const b = JSON.parse(localStorage.getItem(OP_BOX) || 'null'); return b && Number.isFinite(b.x) && Number.isFinite(b.y) ? b : null; } catch { return null; }
  };
  const saveBox = () => {
    const r = pop.getBoundingClientRect();
    try {
      localStorage.setItem(OP_BOX, JSON.stringify({
        x: Math.round(r.left), y: Math.round(r.top),
        ...(pop.style.height ? { w: Math.round(r.width), h: Math.round(r.height) } : {}),
      }));
    } catch { /* full */ }
  };
  const placeOp = (x, y) => {
    const w = pop.offsetWidth || 340, h = pop.offsetHeight || 400;
    pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
    // Beta: the bottom edge stops the panel like the sides do, so pushing past it pops out.
    pop.style.top = `${Math.max(40, Math.min(y, window.innerHeight - (betaLayoutOn() ? h + 8 : Math.min(h, 120))))}px`;
    pop.style.right = 'auto';
  };
  const sizeOp = (w, h) => {
    pop.style.width = `${Math.max(OP_MIN_W, Math.min(w, window.innerWidth - 16))}px`;
    pop.style.height = `${Math.max(OP_MIN_H, Math.min(h, window.innerHeight - 48))}px`;
    pop.style.maxHeight = 'none';
  };
  const unsizeOp = () => { pop.style.width = ''; pop.style.height = ''; pop.style.maxHeight = ''; };

  function place() {
    const box = betaLayoutOn() ? savedBox() : null;
    if (box) {
      if (Number.isFinite(box.w) && Number.isFinite(box.h)) sizeOp(box.w, box.h); else unsizeOp();
      placeOp(box.x, box.y);
      return;
    }
    unsizeOp();
    const r = chip.getBoundingClientRect();
    const w = pop.offsetWidth || 320;
    pop.style.left = `${Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = 'auto';
  }

  scPanelScale(pop, 400);
  const opFloat = scFloatAdd('online', {
    panel: pop, host: pop, chip, closeBtn: document.getElementById('online-pop-close'), btnClass: 'sc-hbtn',
    title: 'SolarClient Online', isOpen: () => !pop.classList.contains('hidden'),
    place: placeOp, save: saveBox, restore: () => place(), close: () => close(), resize: sizeOp,
  });
  const opHead = pop.querySelector('.op-head');
  opHead.addEventListener('mousedown', (e) => {
    if (!betaLayoutOn() || e.button !== 0 || e.target.closest('button, input') || opFloat.win) return;
    e.preventDefault();
    const r = pop.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    pop.classList.add('dragging');
    const move = scPerFrame((ev) => {
      placeOp(ev.clientX - ox, ev.clientY - oy);
      scFloatDrag(opFloat, ev, { x: ev.clientX - ox, y: ev.clientY - oy, w: r.width, h: r.height });
    });
    const up = (ev) => {
      move.flush();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      pop.classList.remove('dragging');
      saveBox();
      scFloatDrop(opFloat, ev, { x: ox, y: oy });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  opHead.addEventListener('dblclick', (e) => {
    if (!betaLayoutOn() || e.target.closest('button, input') || opFloat.win) return;
    try { localStorage.removeItem(OP_BOX); } catch { /* ignore */ }
    place();
  });
  pop.querySelectorAll('.op-rz').forEach((grip) => grip.addEventListener('mousedown', (e) => {
    scResize(e, grip, {
      f: opFloat, panel: pop, minW: OP_MIN_W, minH: OP_MIN_H, save: saveBox,
      prep: () => { pop.style.maxHeight = 'none'; },
    });
  }));

  function render() {
    if (!data) return;
    const q = search.value.trim().toLowerCase();
    const inGame = data.people.filter(p => p.inGame).length;
    const beta = betaLayoutOn();
    pop.classList.toggle('op-beta', beta);
    if (beta) {
      renderBeta(q, inGame);
      return;
    }
    delete list.dataset.painted;
    sub.textContent = `${data.total} online · ${inGame} in game${data.hidden ? ` · ${data.hidden} hidden` : ''}`;
    delete sub.dataset.html;
    const rows = data.people
      .filter(p => !q || p.name.toLowerCase().includes(q))
      .sort((a, b) => (!!b.self - !!a.self) || (!!b.inGame - !!a.inGame) || a.name.localeCompare(b.name));
    if (!rows.length) {
      const why = q ? 'Nobody by that name is online.' : 'Nobody else is showing as online right now.';
      list.innerHTML = `<p class="op-empty">${why}</p>`;
      return;
    }
    list.innerHTML = '';
    for (const p of rows) {
      const row = document.createElement('div');
      row.className = 'op-row';
      const status = p.inGame ? '<span class="op-status ingame"><i></i>In game</span>' : '<span class="op-status"><i></i>In the launcher</span>';
      const face = `<img class="op-face" src="${frAvatar(p.uuid)}" alt="" ${personAttr(p.uuid, p.name)}>`;
      const role = p.role && p.role !== 'member' ? `<span class="op-role" data-role="${escapeHtml(roleKey(p))}">${escapeHtml(p.role)}</span>` : '';
      const action = p.self ? '<span class="op-tag">You</span>'
        : p.following && p.follower ? '<span class="op-tag friends">Friends</span>'
        : p.following ? '<button class="op-act" data-act="menu">Following</button>'
        : `<button class="op-act follow" data-act="follow">${p.follower ? 'Follow back' : 'Follow'}</button>`;
      row.innerHTML = `${face}
        <div class="op-info"><span class="op-name"><span ${personAttr(p.uuid, p.name)}>${escapeHtml(p.name)}</span>${role}${p.self ? '' : reportFlag(p.uuid, p.name)}</span>${status}</div>${action}`;
      row.querySelector('.op-face').onerror = (e) => { e.target.style.visibility = 'hidden'; };
      if (!p.self) {
        row.title = 'Right-click for options';
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); showPeopleMenu(p, e.clientX, e.clientY); });
      }
      row.querySelector('[data-act="follow"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await window.nebula.friendsFollow({ uuid: p.uuid, name: p.name });
          p.following = true;
          render();
          showToast('Following', p.name, 'success');
        } catch (err) { showToast("Couldn't follow", err.message, 'error'); }
      });
      row.querySelector('[data-act="menu"]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = scRect(e.currentTarget);
        showPeopleMenu(p, r.left, r.bottom + 4);
      });
      list.appendChild(row);
    }
  }

  function renderBeta(q, inGame) {
    const friends = data.people.filter((p) => p.following && p.follower && !p.self).length;
    const bigN = document.getElementById('op-big-n');
    if (bigN.textContent !== String(data.total)) {
      bigN.textContent = String(data.total);
      bigN.classList.remove('bump'); void bigN.offsetWidth; bigN.classList.add('bump');
    }
    const chip = (cls, icon, n, label, tip) => `<span class="op-stat ${cls}" title="${tip}">${icon}<b>${n}</b>${label}</span>`;
    const subHtml = chip('game', OI_ICON.game, inGame, 'playing', 'In Minecraft right now')
      + chip('launcher', OP_STAT_ICON.launcher, Math.max(0, data.people.length - inGame), 'in launcher', 'In the launcher, not in a game')
      + (data.hidden ? chip('hid', OP_STAT_ICON.hidden, data.hidden, 'hidden', 'Online but hiding who they are') : '')
      + (data.offlineTotal ? chip('off', OP_STAT_ICON.offline, data.offlineTotal, 'offline', "Have SolarClient installed, but it's closed") : '');
    if (sub.dataset.html !== subHtml) { sub.innerHTML = subHtml; sub.dataset.html = subHtml; }
    document.getElementById('op-n-all').textContent = String(data.total);
    document.getElementById('op-n-ingame').textContent = String(inGame);
    document.getElementById('op-n-friends').textContent = String(friends);
    document.getElementById('op-n-following').textContent = String(data.people.filter(p => p.following && !p.self).length);
    viewsEl.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    requestAnimationFrame(moveInk);
    document.getElementById('op-search-x').classList.toggle('hidden', !q);
    const byRole = (a, b) => (roleRank(a) - roleRank(b)) || (!!b.inGame - !!a.inGame) || a.name.localeCompare(b.name);
    const rows = data.people.filter(p => (!q || p.name.toLowerCase().includes(q)) && inView(p)).sort(byRole);
    const offRows = view === 'ingame' ? [] : (data.offline || [])
      .filter(p => (!q || p.name.toLowerCase().includes(q)) && inView(p))
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
    if (!rows.length && !offRows.length) {
      const why = q ? `Nobody called "${escapeHtml(q)}" is online.`
        : view === 'ingame' ? 'Nobody is in a game right now.'
        : view === 'friends' ? 'None of your friends are online. Friends are people you follow who follow you back.'
        : view === 'following' ? 'Nobody you follow is online right now.'
        : 'Nobody else is showing as online right now.';
      list.innerHTML = `<div class="op-empty"><span class="op-empty-ic">${OP_ICON.profile}</span>${why}</div>`;
      return;
    }
    const groupOf = (p) => ROLE_ORDER[roleRank(p)] || 'member';
    const groupName = { ...ROLE_GROUP, member: 'Members' };
    const animate = !list.dataset.painted;
    list.dataset.painted = '1';
    let html = '';
    let group = null;
    let i = 0;
    for (const p of rows) {
      const g = groupOf(p);
      if (g !== group) {
        group = g;
        const n = rows.filter((x) => groupOf(x) === g).length;
        html += `<div class="op-group" data-group="${g}"><span>${groupName[g] || 'Members'}</span><em>${n}</em></div>`;
      }
      const key = roleKey(p);
      const icon = ROLE_ICON[key] ? `<svg class="op-badge" viewBox="0 0 24 24" aria-label="${escapeHtml(p.role)}"><title>${escapeHtml(p.role)}</title>${ROLE_ICON[key]}</svg>` : '';
      const friend = p.following && p.follower;
      const follow = p.self || p.following ? ''
        : `<button type="button" class="op-act follow" data-act="follow">${p.follower ? 'Follow back' : 'Follow'}</button>`;
      html += `<div class="op-row${animate ? ' op-in' : ''}" style="--i:${Math.min(i++, 14)}" data-uuid="${escapeHtml(p.uuid)}" data-role="${ROLE_ICON[key] ? key : 'member'}">
        <span class="op-face-wrap"><img class="op-face" src="${frAvatar(p.uuid)}" alt="" ${personAttr(p.uuid, p.name)}><i class="op-dot${p.inGame ? ' ingame' : ''}" data-tip="${p.inGame ? 'Playing' : 'In the launcher'}"></i></span>
        <div class="op-info"><span class="op-name"><span class="op-nick" ${personAttr(p.uuid, p.name)}>${escapeHtml(p.name)}</span>${icon}${p.self ? '<span class="op-you">you</span>' : ''}${friend ? '<span class="op-friend" title="You follow each other">friend</span>' : ''}</span>
        <span class="op-status${p.inGame ? ' ingame' : ''}">${p.inGame ? 'Playing Minecraft' : 'In the launcher'}</span></div>
        <div class="op-tools">${p.self ? '' : `
          <button type="button" class="op-tool" data-act="profile" title="View profile">${OP_ICON.profile}</button>
          ${friend ? `<button type="button" class="op-tool" data-act="dm" title="Message">${OP_ICON.dm}</button>` : ''}
          <button type="button" class="op-tool" data-act="menu" title="More">${OP_ICON.more}</button>`}</div>
        ${follow}
      </div>`;
    }
    if (offRows.length) {
      const OFF_SHOWN = 100;
      html += `<div class="op-group" data-group="offline"><span>Offline</span><em>${offRows.length}</em></div>`;
      for (const p of offRows.slice(0, OFF_SHOWN)) {
        const key = roleKey(p);
        const icon = ROLE_ICON[key] ? `<svg class="op-badge" viewBox="0 0 24 24" aria-label="${escapeHtml(p.role)}"><title>${escapeHtml(p.role)}</title>${ROLE_ICON[key]}</svg>` : '';
        const friend = p.following && p.follower;
        html += `<div class="op-row op-off${animate ? ' op-in' : ''}" style="--i:${Math.min(i++, 14)}" data-uuid="${escapeHtml(p.uuid)}" data-role="${ROLE_ICON[key] ? key : 'member'}">
          <span class="op-face-wrap"><img class="op-face" src="${frAvatar(p.uuid)}" alt="" ${personAttr(p.uuid, p.name)}><i class="op-dot off" data-tip="Offline"></i></span>
          <div class="op-info"><span class="op-name"><span class="op-nick" ${personAttr(p.uuid, p.name)}>${escapeHtml(p.name)}</span>${icon}${friend ? '<span class="op-friend" title="You follow each other">friend</span>' : ''}</span>
          <span class="op-status off">${p.lastSeen ? `Last online ${scAgo(p.lastSeen)}` : 'Offline'}</span></div>
          <div class="op-tools">
            <button type="button" class="op-tool" data-act="profile" title="View profile">${OP_ICON.profile}</button>
            ${friend ? `<button type="button" class="op-tool" data-act="dm" title="Message">${OP_ICON.dm}</button>` : ''}
            <button type="button" class="op-tool" data-act="menu" title="More">${OP_ICON.more}</button></div>
        </div>`;
      }
      if (offRows.length > OFF_SHOWN) html += `<div class="op-more">+${offRows.length - OFF_SHOWN} more offline. Search to find someone.</div>`;
    }
    list.innerHTML = html;
    sel = Math.min(sel, list.querySelectorAll('.op-row').length - 1);
    paintSel();
  }
  function paintSel() {
    const rowsEl = [...list.querySelectorAll('.op-row')];
    rowsEl.forEach((r, i) => r.classList.toggle('sel', i === sel));
    rowsEl[sel]?.scrollIntoView({ block: 'nearest' });
  }
  const personOf = (row) => data && [...data.people, ...(data.offline || [])].find((p) => p.uuid === row?.dataset.uuid);
  list.addEventListener('click', async (e) => {
    if (!pop.classList.contains('op-beta')) return;
    const btn = e.target.closest('[data-act]');
    const p = personOf(e.target.closest('.op-row'));
    if (!btn || !p) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'profile') openProfile({ uuid: p.uuid, name: p.name });
    else if (act === 'dm') { close(); switchView('friends'); openConversation({ kind: 'dm', id: p.uuid, name: p.name }); }
    else if (act === 'menu') { const r = scRect(btn); showPeopleMenu(p, r.left, r.bottom + 4); }
    else if (act === 'follow') {
      try {
        await window.nebula.friendsFollow({ uuid: p.uuid, name: p.name });
        p.following = true;
        render();
        showToast('Following', escapeHtml(p.name), 'success');
      } catch (err) { showToast("Couldn't follow", err.message, 'error'); }
    }
  }, true);
  list.addEventListener('contextmenu', (e) => {
    if (!pop.classList.contains('op-beta')) return;
    const p = personOf(e.target.closest('.op-row'));
    if (!p || p.self) return;
    e.preventDefault();
    showPeopleMenu(p, e.clientX, e.clientY);
  });

  async function load() {
    try {
      data = await window.nebula.onlineList();
      if (oiHidden !== (data.hidden || 0) || oiOffline !== (data.offlineTotal || 0)) {
        oiHidden = data.hidden || 0;
        oiOffline = data.offlineTotal || 0;
        refreshOnlineIndicator();
      }
      render();
    } catch (err) {
      if (!data) {
        sub.textContent = 'Not connected';
        const msg = String(err.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        list.innerHTML = `<p class="op-empty">${escapeHtml(msg || "Couldn't load who's online.")}</p>`;
      }
    }
  }

  function open(startView = 'all', from = chip) {
    view = startView;
    sel = -1;
    const beta = betaLayoutOn();
    pop.classList.toggle('op-beta', beta);
    pop.querySelector('.op-title').textContent = beta ? 'SolarClient Online' : 'On SolarClient now';
    pop.classList.remove('hidden');
    chip.classList.add('open');
    place();
    if (beta) { scFloatFit(opFloat, { glide: false }); delete list.dataset.painted; popDown(pop, from); }
    search.value = '';
    if (!data) { sub.textContent = 'Loading…'; list.innerHTML = ''; }
    else if (beta) render();
    load();
    clearInterval(timer);
    timer = setInterval(() => { if (isOpen() && (opFloat.win || !document.hidden)) load(); }, 15000);
    if (beta) setTimeout(() => { if (isOpen()) search.focus({ preventScroll: true }); }, 60);
  }
  function close() {
    if (opFloat.win) { scDock('online', { shut: true }); return; }
    popClose(pop, () => pop.classList.add('hidden'));
    chip.classList.remove('open');
    clearInterval(timer);
  }

  chip.addEventListener('click', () => (isOpen() ? close() : open()));
  chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chip.click(); } });
  document.getElementById('online-pop-close').addEventListener('click', close);
  document.getElementById('ingame-indicator')?.addEventListener('click', (e) => {
    if (!betaLayoutOn()) return;
    e.stopPropagation();
    if (isOpen() && view === 'ingame') close(); else open('ingame', e.currentTarget);
  });
  viewsEl?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    view = b.dataset.view;
    sel = -1;
    delete list.dataset.painted;
    render();
  });
  document.getElementById('op-search-x')?.addEventListener('click', () => { search.value = ''; render(); search.focus(); });
  search.addEventListener('input', () => { sel = -1; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (betaLayoutOn() && search.value) { search.value = ''; render(); } else close(); return; }
    if (!pop.classList.contains('op-beta')) return;
    const n = list.querySelectorAll('.op-row').length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); sel = (sel + 1) % n; paintSel(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); sel = sel <= 0 ? n - 1 : sel - 1; paintSel(); }
    else if (e.key === 'Enter' && sel >= 0) {
      const p = personOf(list.querySelectorAll('.op-row')[sel]);
      if (p) openProfile({ uuid: p.uuid, name: p.name });
    } else if (e.key === 'Tab' && viewsEl && !e.shiftKey && !search.value) {
      e.preventDefault();
      const views = [...viewsEl.querySelectorAll('button[data-view]')];
      const i = views.findIndex((b) => b.dataset.view === view);
      views[(i + 1) % views.length].click();
    }
  });
  list.addEventListener('error', (e) => { if (e.target.matches?.('.op-face')) e.target.style.visibility = 'hidden'; }, true);
  // Clicking elsewhere leaves it open; it closes from its X (or the online button).
  window.addEventListener('resize', () => { if (isOpen() && !opFloat.win) { place(); moveInk(); } });
})();

window.nebula.onStarted(({ launchId, instanceName, accountName, instant }) => {
  runningLaunches.set(launchId, { instanceName, accountName, startedAt: Date.now() });
  latestLaunchId = launchId;
  if (overlayLaunchId === null) overlayLaunchId = launchId;
  renderRunningIndicator();
  updateLaunchButtons();
  showToast('Launching', `${instanceName} · ${accountName}`, 'info');
  window.nebula.openMonitor(launchId);
  commitRecentLaunch();
  if (instant) {
    // Faster launch: the game was already loaded and is on screen now.
    gameWindowUp = true;
    if (overlayLaunchId === launchId) hideOverlay();
    return;
  }
  if (overlayLaunchId === launchId && overlay.classList.contains('show')) {
    gameProcessStarted = true;
    progressPending = null;
    overlayLabel.textContent = 'Starting Minecraft…';
    if (progressEls.ovPct) progressEls.ovPct.textContent = '';
    if (progressEls.ovSpeed) progressEls.ovSpeed.textContent = '';
    overlayFill.classList.add('indeterminate');
  }
  // Last-resort fallback only (slow PCs / modpacks) — never the normal path.
  clearTimeout(Number(overlay.dataset.hideFallback || 0));
  overlay.dataset.hideFallback = String(setTimeout(() => {
    if (overlay.classList.contains('show') && overlayLaunchId === launchId) hideOverlay();
  }, 90000));
});

window.nebula.onLog(({ launchId, line }) => {
  if (launchId !== overlayLaunchId) return;
  // Only lines logged once the game window is on screen and loading is done.
  // Datafixer / graphics-adapter lines print before the window exists.
  if (overlay.classList.contains('show') && /Sound engine started|OpenAL initialized|Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks|textures-atlas/i.test(line)) {
    gameWindowUp = true;
    overlayLabel.textContent = 'Game running — have fun!';
    overlayFill.classList.remove('indeterminate');
    overlayFill.style.width = '100%';
    clearTimeout(Number(overlay.dataset.hideSoon || 0));
    overlay.dataset.hideSoon = String(setTimeout(hideOverlay, 350));
  }
});

// =====================================================================
// PROGRESS -- coalesced to one DOM write per animation frame.
//
// A first launch downloads a couple of thousand asset files and the main
// process reported after every single one. Each report did five
// getElementById() lookups (a fresh tree walk each time, none cached) and
// then wrote .style.width, which invalidates layout. Two thousand forced
// style/layout passes arriving faster than the compositor can present is
// what made downloading feel like the app had hung -- the bar was being
// updated far more often than the screen could possibly show it.
//
// Now every report just parks its values in a slot and a single rAF does
// the writing. Anything arriving between two frames is overwritten rather
// than drawn, which is free and, since a monitor can only show one value
// per frame anyway, loses nothing visible.
// =====================================================================
const progressEls = {
  label:     document.getElementById('launch-progress-label'),
  speed:     document.getElementById('launch-progress-speed'),
  fill:      document.getElementById('launch-progress-fill'),
  pct:       document.getElementById('launch-progress-pct'),
  ovSpeed:   document.getElementById('overlay-speed'),
  ovPct:     document.getElementById('overlay-pct'),
};
let progressPending = null;
let progressQueued = false;

function flushProgress() {
  progressQueued = false;
  const p = progressPending;
  if (!p) return;
  progressPending = null;

  // Only touch a node when the value it shows actually changed. Assigning an
  // identical string to textContent still dirties the node in Blink.
  if (overlayLabel.textContent !== p.label) overlayLabel.textContent = p.label;
  if (progressEls.label && progressEls.label.textContent !== p.label) progressEls.label.textContent = p.label;

  if (progressEls.speed && progressEls.speed.textContent !== p.spd) progressEls.speed.textContent = p.spd;
  if (progressEls.ovSpeed && progressEls.ovSpeed.textContent !== p.spd) progressEls.ovSpeed.textContent = p.spd;

  if (p.percent !== null && p.percent !== undefined) {
    overlayFill.classList.remove('indeterminate');
    // Rounded to whole percent: sub-pixel bar widths are invisible and each
    // distinct value is another layout.
    const wpct = `${p.whole}%`;
    if (overlayFill.style.width !== wpct) overlayFill.style.width = wpct;
    if (progressEls.fill && progressEls.fill.style.width !== wpct) progressEls.fill.style.width = wpct;
    if (progressEls.ovPct && progressEls.ovPct.textContent !== wpct) progressEls.ovPct.textContent = wpct;
    if (progressEls.pct && progressEls.pct.textContent !== wpct) progressEls.pct.textContent = wpct;
  } else {
    overlayFill.classList.add('indeterminate');
  }
}

window.nebula.onProgress(({ launchId, label, percent, bytesPerSec }) => {
  if (launchId && overlayLaunchId && launchId !== overlayLaunchId) return;
  if (gameWindowUp || gameProcessStarted) return;
  progressPending = {
    label,
    spd: fmtSpeed(bytesPerSec),
    percent,
    // 100% is reserved for "game window is up" (set by the log watcher).
    whole: percent == null ? 0 : Math.min(99, Math.round(percent)),
  };
  if (!progressQueued) { progressQueued = true; requestAnimationFrame(flushProgress); }
});

window.nebula.onClosed(({ launchId, code }) => {
  // Playtime and XP are banked by the main process as the session runs, so
  // there is nothing to award here — doing it here as well was double
  // counting on top of the launch bonus.
  runningLaunches.delete(launchId);
  myLaunchIds.delete(launchId);
  if (latestLaunchId === launchId) {
    latestLaunchId = runningLaunches.size ? Array.from(runningLaunches.keys()).pop() : null;
  }
  if (overlayLaunchId === launchId) { hideOverlay(); overlayLaunchId = null; }
  renderRunningIndicator();
  updateLaunchButtons();
  launchProgress.classList.add('hidden');
  if (code !== 0 && code !== null && !crashState) showToast('Game exited', `Exit code ${code} — check the monitor window for the log.`, 'error');
});

// ---------- crash auto-fix dialog ----------
const crashModal = document.getElementById('crash-modal');
const crashFixList = document.getElementById('crash-fix-list');
const crashStatus = document.getElementById('crash-status');
const crashApplyBtn = document.getElementById('crash-apply');
const crashDismissBtn = document.getElementById('crash-dismiss');
const crashReportBtn = document.getElementById('crash-report');
let crashState = null; // { launchId, instanceName, versionNumber, loader, phase: 'ask'|'applying'|'done' }

let dismissedCrashId = null;
function closeCrashModal() {
  if (crashState?.phase === 'checking') dismissedCrashId = crashState.launchId;
  crashModal.classList.add('hidden');
  crashState = null;
  window.nebula.crashDialogClosed();
}

window.nebula.onCrashAnalysis((a) => {
  if (crashState?.phase === 'applying' || a.launchId === dismissedCrashId) return;
  crashState = { ...a, phase: a.pending ? 'checking' : 'ask' };
  if (overlayLaunchId === a.launchId || !overlayLaunchId) hideOverlay();
  const label = versionLoaderLabel(a.versionNumber, (a.loader || 'vanilla').toLowerCase());
  document.getElementById('crash-title').textContent = `${label} crashed`;
  if (a.pending) {
    document.getElementById('crash-summary').textContent = 'SolarClient is finding out what went wrong and how to fix it…';
    crashFixList.innerHTML = '';
    crashFixList.classList.add('hidden');
    crashStatus.textContent = 'Reading your mods…';
    crashStatus.classList.remove('hidden');
    crashReportBtn.classList.add('hidden');
    crashApplyBtn.classList.remove('hidden');
    crashApplyBtn.disabled = true;
    crashApplyBtn.textContent = 'Finding fixes…';
    crashDismissBtn.disabled = false;
    crashDismissBtn.textContent = 'Not now';
    crashModal.classList.remove('hidden');
    return;
  }
  document.getElementById('crash-summary').textContent = a.fixes.length
    ? `${a.summary} Would you like to apply the fixes?`
    : a.summary;
  crashFixList.innerHTML = a.fixes.map(f => `
    <li data-id="${escapeHtml(f.id)}"><span class="crash-fix-mark"></span>
      <div><div class="crash-fix-label">${escapeHtml(f.label)}</div>
      ${f.detail ? `<div class="crash-fix-detail">${escapeHtml(f.detail)}</div>` : ''}</div></li>`).join('');
  crashFixList.classList.toggle('hidden', !a.fixes.length);
  crashStatus.classList.add('hidden');
  crashReportBtn.classList.toggle('hidden', !a.hasReport);
  crashApplyBtn.classList.toggle('hidden', !a.fixes.length);
  crashApplyBtn.disabled = false;
  crashApplyBtn.textContent = 'Apply fixes';
  crashDismissBtn.disabled = false;
  crashDismissBtn.textContent = a.fixes.length ? 'Not now' : 'Close';
  crashModal.classList.remove('hidden');
});

window.nebula.onFixProgress(({ label }) => {
  if (crashState?.phase !== 'applying' && crashState?.phase !== 'checking') return;
  crashStatus.textContent = label || 'Working…';
});

crashDismissBtn.addEventListener('click', closeCrashModal);
crashModal.addEventListener('click', (e) => { if (e.target === crashModal && crashState?.phase !== 'applying') closeCrashModal(); });
crashReportBtn.addEventListener('click', () => { if (crashState) window.nebula.openCrashReport(crashState.launchId); });

crashApplyBtn.addEventListener('click', async () => {
  if (!crashState) return;
  if (crashState.phase === 'done') {
    const { instanceName, versionNumber, loader } = crashState;
    closeCrashModal();
    const sel = document.getElementById('launch-instance-select');
    const want = `${instanceName}|${versionNumber}|${loader}`;
    if ([...sel.options].some(o => o.value === want)) sel.value = want;
    launchInstance();
    return;
  }
  crashState.phase = 'applying';
  crashApplyBtn.disabled = true;
  crashDismissBtn.disabled = true;
  crashApplyBtn.textContent = 'Fixing…';
  crashStatus.textContent = 'Working…';
  crashStatus.classList.remove('hidden');
  try {
    const { results, memoryMaxGB } = await window.nebula.applyCrashFixes(crashState.launchId);
    for (const r of results) {
      const li = crashFixList.querySelector(`li[data-id="${CSS.escape(r.id)}"]`);
      if (!li) continue;
      li.classList.add(r.ok ? 'ok' : 'fail');
      if (!r.ok && r.error) {
        const d = document.createElement('div');
        d.className = 'crash-fix-detail';
        d.textContent = r.error;
        li.lastElementChild.appendChild(d);
      }
    }
    if (memoryMaxGB) {
      theme.memMax = memoryMaxGB;
      theme.memMin = Math.min(theme.memMin || 2, memoryMaxGB);
      saveTheme();
      const slider = document.getElementById('mem-max');
      if (slider) { slider.value = memoryMaxGB; document.getElementById('mem-max-label').textContent = memoryMaxGB; }
    }
    const failed = results.filter(r => !r.ok).length;
    crashStatus.textContent = failed
      ? `${results.length - failed} of ${results.length} fixes applied.`
      : 'All fixes applied.';
    crashState.phase = 'done';
    crashApplyBtn.textContent = 'Launch again';
    crashApplyBtn.disabled = false;
    crashDismissBtn.textContent = 'Close';
    crashDismissBtn.disabled = false;
    loadInstalledMods().catch(() => { /* mods page not set up yet */ });
  } catch (err) {
    crashState.phase = 'ask';
    crashStatus.textContent = err.message;
    crashApplyBtn.textContent = 'Apply fixes';
    crashApplyBtn.disabled = false;
    crashDismissBtn.disabled = false;
  }
});

// pick up games that were already running (e.g. after a UI reload)
window.nebula.listRunning().then(list => {
  for (const r of list) { runningLaunches.set(r.id, { instanceName: r.instanceName, accountName: r.accountName }); latestLaunchId = r.id; }
  renderRunningIndicator();
  updateLaunchButtons();
});

// =====================================================================
// VERSION SWITCHER POPOVER — switch instance or spin up a new version
// straight from the launch page; new picks start downloading immediately.
// =====================================================================
const versionPopover = document.getElementById('version-popover');
let popLoader = 'vanilla';

document.getElementById('version-chip').addEventListener('click', (e) => {
  e.stopPropagation();
  if (versionPopover.classList.contains('hidden')) openVersionPopover();
  else versionPopover.classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!versionPopover.classList.contains('hidden') && !versionPopover.contains(e.target)) {
    versionPopover.classList.add('hidden');
  }
});
document.querySelectorAll('.pop-loader-btn').forEach(b => {
  b.addEventListener('click', async () => {
    document.querySelectorAll('.pop-loader-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    popLoader = b.dataset.loader;
    // Repaint immediately with whatever we know, then again once the
    // loader's supported-version list lands, so the grid never sits blank.
    renderVersionArtGrid(document.getElementById('pop-version-search').value);
    await ensureLoaderSupport(popLoader);
    renderVersionArtGrid(document.getElementById('pop-version-search').value);
  });
});

// Hard minimum Minecraft version per loader. This is a belt-and-braces
// copy of the same floor the main process enforces: the meta-API list can
// come back null when offline, and previously that disabled filtering
// entirely and let Fabric show up on 1.0 again. The floor applies whether
// or not the network call succeeded.
const LOADER_MIN_VERSION = { fabric: '1.14', quilt: '1.19' };

function compareMcVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10));
  const pb = String(b).split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (Number.isNaN(x) || x === undefined) return (Number.isNaN(y) || y === undefined) ? 0 : -1;
    if (Number.isNaN(y) || y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

function meetsLoaderFloor(loader, mcVersion) {
  const floor = LOADER_MIN_VERSION[loader];
  if (!floor) return true;
  if (!/^\d+(\.\d+)*$/.test(String(mcVersion))) return true; // snapshots pass through
  return compareMcVersions(mcVersion, floor) >= 0;
}

// loader -> Set of Minecraft versions it actually ships for. `null` means
// "unknown" (offline, or vanilla, which supports everything) and disables
// list filtering — but never disables the floor above.
const loaderSupport = new Map([['vanilla', null]]);
const loaderSupportPending = new Map();

function ensureLoaderSupport(loader) {
  if (loaderSupport.has(loader)) return Promise.resolve(loaderSupport.get(loader));
  if (loaderSupportPending.has(loader)) return loaderSupportPending.get(loader);
  const p = window.nebula.loaderGameVersions(loader)
    .then(list => {
      const set = Array.isArray(list) && list.length ? new Set(list) : null;
      loaderSupport.set(loader, set);
      loaderSupportPending.delete(loader);
      return set;
    })
    .catch(() => { loaderSupport.set(loader, null); loaderSupportPending.delete(loader); return null; });
  loaderSupportPending.set(loader, p);
  return p;
}

// Each major version family gets a biome scene as its artwork — reusing the
// same procedural generators that power the launcher backgrounds, so the
// picker has real art instead of flat gradient tiles.
const VERSION_ART = ['plains', 'cherry', 'frozen', 'ocean', 'nether', 'end', 'sunset'];
function versionArtFor(groupKey) {
  let h = 0;
  for (const c of groupKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const id = VERSION_ART[h % VERSION_ART.length];
  const bg = window.NEBULA_BACKGROUNDS?.[id];
  if (!bg?.make) return '';
  if (!sceneCache[id]) sceneCache[id] = bg.make();
  return sceneCache[id];
}

let popInstalledKeys = new Set();

const RECENT_LAUNCHES_KEY = 'nebula-recent-launches';
const RECENT_LAUNCHES_MAX = 3;

function loadRecentLaunches() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_LAUNCHES_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(r => r && r.versionNumber && r.name) : [];
  } catch {
    return [];
  }
}

/** Remember a successful launch; keep last 3 unique version|loader keys (most recent first). */
function rememberRecentLaunch(inst) {
  const loader = (inst.loader || 'vanilla').toLowerCase();
  const key = `${inst.versionNumber}|${loader}`;
  const entry = {
    name: inst.name,
    versionNumber: inst.versionNumber,
    loader,
    group: inst.group || String(inst.versionNumber).replace(/^(\d+\.\d+).*/, '$1.x'),
    lastAt: Date.now(),
  };
  const next = [entry, ...loadRecentLaunches().filter(r => `${r.versionNumber}|${(r.loader || 'vanilla').toLowerCase()}` !== key)]
    .slice(0, RECENT_LAUNCHES_MAX);
  localStorage.setItem(RECENT_LAUNCHES_KEY, JSON.stringify(next));
}

function renderRecentLaunchList(instances, sel) {
  const el = document.getElementById('pop-recent-list');
  if (!el) return;
  const byKey = new Map(instances.map(i => [`${i.name}|${i.versionNumber}|${(i.loader || 'vanilla').toLowerCase()}`, i]));
  const stored = loadRecentLaunches();
  const recent = stored
    .map(r => {
      const loader = (r.loader || 'vanilla').toLowerCase();
      const inst = byKey.get(`${r.name}|${r.versionNumber}|${loader}`)
        || instances.find(i => i.versionNumber === r.versionNumber && (i.loader || 'vanilla').toLowerCase() === loader)
        || null;
      return inst ? { inst, lastAt: r.lastAt || 0 } : null;
    })
    .filter(Boolean)
    .reduce((acc, row) => {
      const k = `${row.inst.versionNumber}|${(row.inst.loader || 'vanilla').toLowerCase()}`;
      if (acc.seen.has(k)) return acc;
      acc.seen.add(k);
      acc.list.push(row);
      return acc;
    }, { seen: new Set(), list: [] }).list
    .slice(0, RECENT_LAUNCHES_MAX);

  el.innerHTML = '';
  if (!recent.length) {
    el.innerHTML = '<p class="dim" style="margin:0;">Launch a version to pin it here.</p>';
    return;
  }
  for (const { inst } of recent) {
    const key = loaderKey(inst);
    const val = `${inst.name}|${inst.versionNumber}|${inst.loader}`;
    const item = document.createElement('div');
    item.className = 'pop-item' + (sel.value === val ? ' active' : '');
    item.innerHTML = `
      <div class="pop-badge">${(inst.group || '').replace('.x', '') || inst.versionNumber}</div>
      <div>${escapeHtml(inst.versionNumber)} <span class="loader-tag">\u00b7 ${loaderLabel(key)}</span></div>
      ${sel.value === val ? '<span class="pop-check">●</span>' : ''}
    `;
    item.addEventListener('click', () => {
      sel.value = val;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      sel._refreshCustomSelect?.();
      versionPopover.classList.add('hidden');
    });
    el.appendChild(item);
  }
}

async function openVersionPopover() {
  versionPopover.classList.remove('hidden');
  const gen = (openVersionPopover._gen = (openVersionPopover._gen || 0) + 1);
  try { await ensureBackgrounds(); } catch { /* art tiles fall back to empty */ }
  if (gen !== openVersionPopover._gen) return;
  ensureLoaderSupport(popLoader).then(() => {
    if (gen !== openVersionPopover._gen) return;
    renderVersionArtGrid(document.getElementById('pop-version-search').value);
  });
  const sel = document.getElementById('launch-instance-select');
  const instances = await window.nebula.listInstances();
  if (gen !== openVersionPopover._gen) return;
  popInstalledKeys = new Set(instances.map(i => `${i.versionNumber}|${(i.loader || 'vanilla').toLowerCase()}`));

  renderRecentLaunchList(instances, sel);
  renderVersionArtGrid();
}

function renderVersionArtGrid(filter = '') {
  const groupsEl = document.getElementById('pop-version-groups');
  if (versionGroupsFailed && !versionGroups.length) {
    groupsEl.innerHTML = '<p class="dim" style="margin:0;">Couldn\'t load versions. Check your connection and reopen.</p>';
    return;
  }
  if (!versionGroups.length) { groupsEl.innerHTML = '<p class="dim" style="margin:0;">Loading versions…</p>'; return; }
  const q = filter.trim().toLowerCase();
  groupsEl.innerHTML = '';

  const supported = loaderSupport.get(popLoader) ?? null;
  let hiddenByLoader = 0;

  for (const g of versionGroups) {
    const versions = g.versions.filter(v => {
      if (q && !v.toLowerCase().includes(q)) return false;
      if (!meetsLoaderFloor(popLoader, v)) { hiddenByLoader++; return false; }
      if (supported && !supported.has(v)) { hiddenByLoader++; return false; }
      return true;
    });
    if (!versions.length) continue;

    const label = document.createElement('div');
    label.className = 'va-group-label';
    label.textContent = `Minecraft ${g.group.replace('.x', '')}`;
    groupsEl.appendChild(label);

    const art = versionArtFor(g.group);
    for (const v of versions) {
      const tile = document.createElement('div');
      const installed = popInstalledKeys.has(`${v}|${popLoader}`);
      tile.className = 'version-art' + (installed ? ' installed' : '');
      tile.innerHTML = `
        <div class="va-scene"></div>
        <div class="va-shade"></div>
        <div class="va-num">${v}</div>
        ${installed ? '<div class="va-tag">OWNED</div>' : ''}
      `;
      tile.querySelector('.va-scene').style.backgroundImage = art;
      tile.title = `Create a ${popLoader} instance on ${v}`;
      tile.addEventListener('click', () => quickCreateFromVersion(v));
      groupsEl.appendChild(tile);
    }
  }
  if (!groupsEl.children.length) {
    groupsEl.innerHTML = supported
      ? `<p class="dim" style="margin:0;">${popLoader[0].toUpperCase()}${popLoader.slice(1)} doesn't have a build for any version matching that.</p>`
      : '<p class="dim" style="margin:0;">No versions match that search.</p>';
  } else if (hiddenByLoader) {
    const note = document.createElement('p');
    note.className = 'dim va-loader-note';
    note.textContent = `${hiddenByLoader} version${hiddenByLoader === 1 ? '' : 's'} hidden — no ${popLoader} build exists for ${hiddenByLoader === 1 ? 'it' : 'them'}.`;
    groupsEl.appendChild(note);
  }
}

document.getElementById('pop-version-search').addEventListener('input', debounce((e) => {
  renderVersionArtGrid(e.target.value);
}, 180));

async function quickCreateFromVersion(versionNumber) {
  const supported = loaderSupport.get(popLoader) ?? null;
  if (!meetsLoaderFloor(popLoader, versionNumber)) {
    return showToast(
      `No ${popLoader} for ${versionNumber}`,
      `${popLoader[0].toUpperCase()}${popLoader.slice(1)} only works on ${LOADER_MIN_VERSION[popLoader]} and newer.`,
      'error',
    );
  }
  if (supported && !supported.has(versionNumber)) {
    return showToast(
      `No ${popLoader} for ${versionNumber}`,
      `${popLoader[0].toUpperCase()}${popLoader.slice(1)} has never published a build for Minecraft ${versionNumber}.`,
      'error',
    );
  }
  versionPopover.classList.add('hidden');
  const existing = await window.nebula.listInstances();
  let name = popLoader === 'vanilla' ? versionNumber : `${versionNumber} ${popLoader}`;
  let n = 2;
  while (existing.some(i => i.name === name && i.versionNumber === versionNumber)) name = `${versionNumber} ${popLoader !== 'vanilla' ? popLoader + ' ' : ''}#${n++}`;

  await window.nebula.createInstance({ name, versionNumber, loader: popLoader });
  await refreshInstances();
  const sel = document.getElementById('launch-instance-select');
  sel.value = `${name}|${versionNumber}|${popLoader}`;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  sel._refreshCustomSelect?.();
  showToast('Instance created', `${name} — downloading in the background now.`, 'success');
}

// ---------- settings: friends ----------
(async function initFriendsSettings() {
  if (!document.getElementById('set-friends-state')) return;
  const map = {
    'set-notify-follow': 'notifyOnFollow',
    'set-notify-followback': 'notifyOnFollowBack',
    'set-notify-message': 'notifyOnMessage',
    'set-show-online': 'showOnlineStatus',
  };
  const snap = await window.nebula.friendsSnapshot();
  for (const [elId, key] of Object.entries(map)) {
    const el = document.getElementById(elId);
    if (!el) continue;
    el.checked = !!snap.settings[key];
    el.addEventListener('change', async () => {
      await window.nebula.friendsSetSetting({ key, value: el.checked });
    });
  }
  const privateBox = document.getElementById('set-private-profile');
  if (privateBox && window.nebula.profileMeta) {
    window.nebula.profileMeta().then((m) => { privateBox.checked = !!m?.private; }).catch(() => {});
    privateBox.addEventListener('change', () => {
      window.nebula.profileSetMeta({ private: privateBox.checked })
        .catch((e) => showToast("Couldn't save", e?.message || String(e), 'error'));
    });
  }
  // No URL box: the backend ships with the launcher. This just reports
  // whether we're actually connected, and offers a retry.
  const dot = document.getElementById('set-friends-dot');
  const state = document.getElementById('set-friends-state');
  const paintConn = (s2) => {
    const mode = s2?.mode || 'offline';
    dot.className = `fr-dot ${mode}`;
    state.textContent = mode === 'online' ? 'Connected — friends are live'
      : mode === 'reconnecting' ? 'Reconnecting…'
      : 'Not connected — sign in to use friends';
  };
  paintConn(snap);
  window.nebula.onFriendsConnection?.(() => window.nebula.friendsSnapshot().then(paintConn));
  document.getElementById('set-friends-retry').addEventListener('click', async () => {
    await window.nebula.friendsReconnect();
    showToast('Reconnecting', 'Trying the friends server again.', 'info');
  });
})();

// ---------- settings ----------
const memMax = document.getElementById('mem-max');
const memMin = document.getElementById('mem-min');
const perfToggle = document.getElementById('perf-toggle');

// restore persisted values (memory settings used to reset every restart)
memMax.value = theme.memMax; document.getElementById('mem-max-label').textContent = theme.memMax;
memMin.value = theme.memMin; document.getElementById('mem-min-label').textContent = theme.memMin;
perfToggle.checked = !!theme.perfMode;

memMax.addEventListener('input', () => {
  theme.memMax = Number(memMax.value);
  document.getElementById('mem-max-label').textContent = memMax.value;
  if (theme.memMin > theme.memMax) { theme.memMin = theme.memMax; memMin.value = theme.memMax; document.getElementById('mem-min-label').textContent = theme.memMax; }
  saveTheme();
  renderMemVis();
});
memMin.addEventListener('input', () => {
  theme.memMin = Math.min(Number(memMin.value), theme.memMax);
  memMin.value = theme.memMin;
  document.getElementById('mem-min-label').textContent = theme.memMin;
  saveTheme();
});
perfToggle.addEventListener('change', () => { theme.perfMode = perfToggle.checked; saveTheme(); syncPerfChip(); });

async function refreshAccountSettings() {
  const accounts = await window.nebula.listAccounts();
  const current = await window.nebula.currentAccount();
  const list = document.getElementById('settings-account-list');
  list.innerHTML = accounts.map(a => `
    <div class="account-list-item">
      <img src="${avatarUrl(a.id)}" alt="" onerror="this.src='${avatarUrlFallback(a.id)}'">
      <span>${a.name}${current && current.id === a.id ? ' (active)' : ''}</span>
      <button class="remove" data-id="${a.id}">Remove</button>
    </div>
  `).join('') || '<p class="dim">No accounts signed in yet.</p>';

  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.nebula.removeAccount(btn.dataset.id);
      refreshAccountSettings();
      renderAccountBox();
    });
  });
}
document.getElementById('settings-add-account').addEventListener('click', async () => {
  await doLogin();
  refreshAccountSettings();
});

document.getElementById('open-default-mods').addEventListener('click', () => window.nebula.openDefaultModsFolder());

// ---------- import mod/resourcepack from file ----------
document.getElementById('import-mod-btn').addEventListener('click', async () => {
  const selVal = document.getElementById('mods-instance-select').value;
  if (!selVal) return showToast('No instance selected', 'Pick an instance first.', 'error');
  const [instanceName, versionNumber] = selVal.split('|');

  const result = await window.nebula.importModFile({ instanceName, versionNumber, folder: 'mods' });
  if (result.imported.length) {
    showToast('Mod added', result.imported.join(', '), 'success');
    refreshInstalledContent();
  }
});

document.getElementById('import-respack-btn').addEventListener('click', async () => {
  const selVal = document.getElementById('mods-instance-select').value;
  if (!selVal) return showToast('No instance selected', 'Pick an instance first.', 'error');
  const [instanceName, versionNumber] = selVal.split('|');

  const result = await window.nebula.importModFile({ instanceName, versionNumber, folder: 'resourcepacks' });
  if (result.imported.length) {
    showToast('Resource pack added', result.imported.join(', '), 'success');
    refreshInstalledContent();
  }
});

// ---------- modpacks: import an .mrpack / export an instance ----------
document.getElementById('import-modpack-btn').addEventListener('click', async () => {
  const installId = `pack-import-${Date.now()}`;
  try {
    showDownloadBar(installId, 'Importing modpack…');
    const res = await window.nebula.modpackImport({ installId });
    finishModpackInstall(installId, res);
  } catch (err) {
    removeDownloadBar(installId);
    showToast('Modpack import failed', cleanIpcError(err), 'error');
  }
});

document.getElementById('export-modpack-btn').addEventListener('click', async () => {
  const selVal = document.getElementById('mods-instance-select').value;
  if (!selVal) return showToast('No instance selected', 'Pick the instance to export first.', 'error');
  const [instanceName, versionNumber, loader] = selVal.split('|');
  const btn = document.getElementById('export-modpack-btn');
  btn.disabled = true;
  try {
    const res = await window.nebula.modpackExport({ instanceName, versionNumber, loader });
    if (res) showToast('Modpack exported', `${instanceName}.mrpack is ready to share — anyone can import it with "Import modpack".`, 'success');
  } catch (err) {
    showToast('Export failed', cleanIpcError(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

// ---------- drag & drop mod / resource pack import ----------
(function () {
  const modsView = document.getElementById('view-mods');
  const dropHint = document.getElementById('mods-drop-hint');
  let dragDepth = 0;

  modsView.addEventListener('dragenter', (e) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    dropHint.classList.remove('hidden');
    dropHint.classList.add('active');
  });
  modsView.addEventListener('dragover', (e) => { e.preventDefault(); });
  modsView.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropHint.classList.remove('active');
  });
  modsView.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.classList.remove('active');
    dropHint.classList.add('hidden');

    const selVal = document.getElementById('mods-instance-select').value;
    if (!selVal) return showToast('No instance selected', 'Pick an instance first, then drop files.', 'error');
    const [instanceName, versionNumber] = selVal.split('|');

    const paths = Array.from(e.dataTransfer.files)
      .map(f => f.path)
      .filter(p => p && /\.(jar|zip)$/i.test(p));
    if (!paths.length) return showToast('Nothing to import', 'Drop .jar (mods) or .zip (resource packs) files.', 'error');

    try {
      const result = await window.nebula.importModPaths({ instanceName, versionNumber, paths });
      if (result.imported.length) {
        showToast('Added', result.imported.join(', '), 'success');
        refreshInstalledContent();
      }
      if (result.skipped) showToast('Some files skipped', `${result.skipped} file(s) weren't .jar or .zip.`, 'error');
    } catch (err) {
      showToast("Couldn't import", err.message, 'error');
    }
  });
})();

// =====================================================================
// SPACE FEEL — depth parallax, click ripples, stardust cursor trail.
// All honor the Customize toggles and the reduced-motion preference.
// =====================================================================
const parallaxTargets = [
  { el: document.querySelector('.blob-1'), depth: 26 },
  { el: document.querySelector('.blob-2'), depth: 40 },
  { el: document.querySelector('.blob-3'), depth: 18 },
  { el: document.getElementById('bg-scene'), depth: 10, scale: 1.04 },
];
function resetParallax() {
  for (const t of parallaxTargets) if (t.el) t.el.style.transform = '';
}
let pxRaf = null, pxX = 0, pxY = 0;
document.addEventListener('mousemove', (e) => {
  if (!theme.parallax || !theme.animations || document.body.classList.contains('skin-grabbing')) return;
  pxX = e.clientX / window.innerWidth - 0.5;
  pxY = e.clientY / window.innerHeight - 0.5;
  if (pxRaf) return;
  const apply = () => {
    pxRaf = null;
    for (const t of parallaxTargets) {
      if (!t.el) continue;
      t.el.style.transform = `translate(${(-pxX * t.depth).toFixed(1)}px, ${(-pxY * t.depth).toFixed(1)}px)${t.scale ? ` scale(${t.scale})` : ''}`;
    }
  };
  // Beta: every shift redraws all the glass over it, so cap it at 30fps like the other ambient motion.
  pxRaf = betaLayoutOn() ? setTimeout(apply, 1000 / 30) : requestAnimationFrame(apply);
});

document.addEventListener('pointerdown', (e) => {
  if (!theme.animations) return;
  const r = document.createElement('div');
  r.className = 'click-ripple';
  r.style.left = `${e.clientX}px`;
  r.style.top = `${e.clientY}px`;
  document.body.appendChild(r);
  r.animate(
    [{ transform: 'translate(-50%,-50%) scale(0.4)', opacity: 0.9 },
     { transform: 'translate(-50%,-50%) scale(3.4)', opacity: 0 }],
    { duration: 480, easing: 'cubic-bezier(0.2,0.7,0.3,1)' }
  ).onfinish = () => r.remove();
});

let lastTrail = 0;
document.addEventListener('mousemove', (e) => {
  if (!theme.trail || !theme.animations) return;
  const now = performance.now();
  if (now - lastTrail < 28) return;
  lastTrail = now;
  const d = document.createElement('div');
  d.className = 'trail-dot';
  d.style.left = `${e.clientX + (Math.random() * 8 - 4)}px`;
  d.style.top = `${e.clientY + (Math.random() * 8 - 4)}px`;
  document.body.appendChild(d);
  d.animate(
    [{ opacity: 0.9, transform: 'translate(-50%,-50%) scale(1)' },
     { opacity: 0, transform: `translate(-50%, calc(-50% + ${8 + Math.random() * 10}px)) scale(0.2)` }],
    { duration: 550, easing: 'ease-out' }
  ).onfinish = () => d.remove();
});

// =====================================================================
// AUTO-TUNE — read the actual machine, pick memory + tier, apply
// best-known in-game settings to the selected instance.
// =====================================================================
document.getElementById('autotune-btn').addEventListener('click', async () => {
  const btn = document.getElementById('autotune-btn');
  btn.disabled = true; btn.textContent = 'Reading…';
  try {
    sysInfo = null;
    const info = await window.nebula.systemInfo();
    sysInfo = info;
    theme.memMax = info.suggested.memMaxGB;
    theme.memMin = info.suggested.memMinGB;
    theme.perfMode = true;
    saveTheme();
    memMax.value = theme.memMax; document.getElementById('mem-max-label').textContent = theme.memMax;
    memMin.value = theme.memMin;
    syncPerfChip();

    const selVal = document.getElementById('launch-instance-select').value;
    let extra = '';
    if (selVal) {
      const [instanceName, versionNumber] = selVal.split('|');
      await window.nebula.applyBestSettings({ instanceName, versionNumber, tier: info.tier });
      extra = ` Settings saved for ${instanceName} and locked in for every launch.`;
    }
    await renderPerformance();
    showToast('Hardware re-detected', `${info.tier[0].toUpperCase() + info.tier.slice(1)}-tier: ${info.cores} cores, ${info.totalMemGB} GB${info.gpu ? `, ${info.gpu}` : ''} → ${theme.memMax} GB allocated.${extra}`, 'success');
  } catch (err) {
    showToast('Detection failed', err.message, 'error');
  }
  btn.disabled = false; btn.textContent = 'Re-detect hardware';
});

// =====================================================================
// COMMAND PALETTE — Ctrl/Cmd+K
// =====================================================================
const palette = document.getElementById('palette');
const paletteInput = document.getElementById('palette-input');
const paletteList = document.getElementById('palette-list');
let palSel = 0;

function switchView(view) {
  document.querySelector(`.nav-btn[data-view="${view}"]`)?.click();
}

function paletteActions() {
  const acts = [
    { icon: '▶', label: 'Launch game', hint: 'selected instance', run: () => launchInstance() },
    { icon: '■', label: 'Stop game', hint: 'most recent', run: () => latestLaunchId && window.nebula.stopGame(latestLaunchId) },
    { icon: '+', label: 'Launch another instance', run: () => launchInstance() },
    { icon: '◉', label: 'Open game monitor', run: () => latestLaunchId && window.nebula.openMonitor(latestLaunchId) },
    { icon: '⚡', label: `Performance mode: turn ${theme.perfMode ? 'off' : 'on'}`, run: () => perfChip.click() },
    { icon: '🚀', label: 'Install all performance mods & auto-tune', run: () => { switchView('launchpad'); setTimeout(() => document.getElementById('optimize-btn').click(), 250); } },
    { icon: '🔧', label: 'Re-detect hardware', run: () => { switchView('launchpad'); setTimeout(() => document.getElementById('autotune-btn').click(), 250); } },
    { icon: '🖼', label: 'Upload background photo', run: async () => { const p = await window.nebula.pickBackgroundImage(); if (p) { theme.customBgUrl = p.fileUrl; theme.bg = 'custom'; saveTheme(); applyTheme(); } } },
    { icon: '✦', label: `Animations: turn ${theme.animations ? 'off' : 'on'}`, run: () => { theme.animations = !theme.animations; saveTheme(); applyTheme(); } },
    { icon: '☁', label: `Particles: turn ${theme.particles ? 'off' : 'on'}`, run: () => { theme.particles = !theme.particles; saveTheme(); applyTheme(); } },
    { icon: '⬡', label: 'Launch Bedrock Edition', run: () => { setEdition('bedrock'); setTimeout(() => document.getElementById('bedrock-launch-btn').click(), 400); } },
    { icon: '▣', label: `Switch to ${currentEdition === 'java' ? 'Bedrock' : 'Java'} Edition`, run: () => setEdition(currentEdition === 'java' ? 'bedrock' : 'java') },
    { icon: '⌂', label: 'Go to Launchpad', run: () => switchView('launchpad') },
    { icon: '▦', label: 'Go to Versions', run: () => switchView('instances') },
    { icon: '★', label: 'Go to Content', run: () => switchView('mods') },
    { icon: '🎨', label: 'Go to Customize', run: () => switchView('customize') },
    { icon: '⚙', label: 'Go to Settings', run: () => switchView('settings') },
  ];
  for (const [id, bg] of Object.entries(window.NEBULA_BACKGROUNDS || {})) {
    acts.push({ icon: '⬡', label: `Background: ${bg.name}`, run: () => { theme.bg = id; saveTheme(); applyTheme(); renderCustomize(); } });
  }
  for (const a of ACCENTS) {
    acts.push({ icon: '●', label: `Accent: ${a.name}`, run: () => { theme.accent = a.id; saveTheme(); applyTheme(); renderCustomize(); } });
  }
  if (betaLayoutOn()) {
    for (const c of readCommunities()) {
      for (const ch of c.channels || []) {
        const u = ch.kind === 'text' ? csUnread(c, ch) : { n: 0 };
        acts.push({ icon: ch.kind === 'voice' ? '🔊' : '#', label: `${ch.name}`, hint: `${c.name}${u.n ? ` · ${u.n} new` : ''}`, run: () => openCommunityStage(c.id, ch.id) });
      }
    }
  }
  return acts;
}

function renderPalette() {
  const q = paletteInput.value.trim().toLowerCase();
  const acts = paletteActions().filter(a => !q || a.label.toLowerCase().includes(q));
  palSel = Math.min(palSel, Math.max(0, acts.length - 1));
  paletteList.innerHTML = '';
  acts.slice(0, 12).forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'palette-item' + (i === palSel ? ' sel' : '');
    item.innerHTML = `<span class="pi-icon">${a.icon}</span><span>${a.label}</span>${a.hint ? `<span class="pi-hint">${a.hint}</span>` : ''}`;
    item.addEventListener('click', () => { closePalette(); a.run(); });
    paletteList.appendChild(item);
  });
  paletteList._acts = acts.slice(0, 12);
}
function openPalette() { palette.classList.remove('hidden'); paletteInput.value = ''; palSel = 0; renderPalette(); paletteInput.focus(); }
function closePalette() { palette.classList.add('hidden'); }

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette.classList.contains('hidden') ? openPalette() : closePalette(); return; }
  if (palette.classList.contains('hidden')) return;
  if (e.key === 'Escape') { closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); palSel++; renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPalette(); }
  else if (e.key === 'Enter') { const a = paletteList._acts?.[palSel]; if (a) { closePalette(); a.run(); } }
});
paletteInput.addEventListener('input', () => { palSel = 0; renderPalette(); });
palette.addEventListener('click', (e) => { if (e.target === palette) closePalette(); });

// =====================================================================
// PERFORMANCE DASHBOARD
// =====================================================================
// The stack is per-loader. Sodium, Lithium and Krypton are Fabric mods —
// on Forge they simply don't exist, which is why this card used to just
// refuse to do anything for a Forge instance. Forge has its own ports and
// equivalents (Embeddium is the Sodium port, Radium the Lithium port), so
// it gets a real stack instead of an error. Quilt runs Fabric mods, and
// additionally needs QFAPI rather than plain Fabric API.
const PERF_STACKS = {
  fabric: [
    { slug: 'fabric-api',      title: 'Fabric API',      what: 'Required by nearly every Fabric mod', gain: 'REQ' },
    { slug: 'sodium',          title: 'Sodium',          what: 'Rewrites the chunk renderer', gain: 'BIG' },
    { slug: 'lithium',         title: 'Lithium',         what: 'Optimizes game logic & ticks', gain: 'BIG' },
    { slug: 'ferrite-core',    title: 'FerriteCore',     what: 'Cuts memory usage sharply', gain: 'RAM' },
    { slug: 'entityculling',   title: 'Entity Culling',  what: "Skips entities you can't see", gain: 'BIG' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast', what: 'Speeds up UI & text drawing', gain: 'MED' },
    { slug: 'krypton',         title: 'Krypton',         what: 'Faster networking stack', gain: 'MED' },
    { slug: 'dynamic-fps',     title: 'Dynamic FPS',     what: 'Idles the game when unfocused', gain: 'PWR' },
  ],
  quilt: [
    { slug: 'qsl',             title: 'QFAPI/QSL',       what: 'Quilt\u2019s standard library + Fabric API', gain: 'REQ' },
    { slug: 'sodium',          title: 'Sodium',          what: 'Rewrites the chunk renderer', gain: 'BIG' },
    { slug: 'lithium',         title: 'Lithium',         what: 'Optimizes game logic & ticks', gain: 'BIG' },
    { slug: 'ferrite-core',    title: 'FerriteCore',     what: 'Cuts memory usage sharply', gain: 'RAM' },
    { slug: 'entityculling',   title: 'Entity Culling',  what: "Skips entities you can't see", gain: 'BIG' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast', what: 'Speeds up UI & text drawing', gain: 'MED' },
    { slug: 'krypton',         title: 'Krypton',         what: 'Faster networking stack', gain: 'MED' },
    { slug: 'dynamic-fps',     title: 'Dynamic FPS',     what: 'Idles the game when unfocused', gain: 'PWR' },
  ],
  forge: [
    { slug: 'embeddium',       title: 'Embeddium',       what: 'Sodium\u2019s renderer, ported to Forge', gain: 'BIG' },
    { slug: 'radium',          title: 'Radium',          what: 'Lithium\u2019s tick optimizations for Forge', gain: 'BIG' },
    { slug: 'ferrite-core',    title: 'FerriteCore',     what: 'Cuts memory usage sharply', gain: 'RAM' },
    { slug: 'modernfix',       title: 'ModernFix',       what: 'Faster boot, lower memory', gain: 'BIG' },
    { slug: 'entityculling',   title: 'Entity Culling',  what: "Skips entities you can't see", gain: 'BIG' },
    { slug: 'immediatelyfast', title: 'ImmediatelyFast', what: 'Speeds up UI & text drawing', gain: 'MED' },
    { slug: 'dynamic-fps',     title: 'Dynamic FPS',     what: 'Idles the game when unfocused', gain: 'PWR' },
  ],
  vanilla: [],
};

function currentLoader() {
  const v = document.getElementById('launch-instance-select')?.value || '';
  return (v.split('|')[2] || 'vanilla').toLowerCase();
}
function perfStackFor(loader) {
  return PERF_STACKS[loader] || PERF_STACKS.vanilla;
}
// Kept as a live view of "the stack for whatever is selected right now".
let PERF_STACK = PERF_STACKS.fabric;

let sysInfo = null;
let sysInfoFetchedAt = 0;

async function renderPerformance() {
  // Re-read hardware every 5s so free RAM stays current instead of
  // showing whatever it was when the launcher opened.
  const stale = Date.now() - sysInfoFetchedAt > 5000;
  if (!sysInfo || stale) {
    try { sysInfo = await window.nebula.systemInfo(); sysInfoFetchedAt = Date.now(); }
    catch { /* keep the last good read */ }
  }
  if (sysInfo) {
    const badge = document.getElementById('perf-tier-badge');
    badge.className = `perf-tier-badge tier-${sysInfo.tier}`;
    badge.innerHTML = `<span class="ptb-label">${sysInfo.tier}-tier rig</span>`;
    document.getElementById('spec-cpu').textContent = sysInfo.cpuModel;
    document.getElementById('spec-cpu').title = sysInfo.cpuModel;
    document.getElementById('spec-gpu').textContent = sysInfo.gpu || (sysInfo.platform === 'win32' ? 'Unknown' : 'Not detected on this OS');
    document.getElementById('spec-gpu').title = sysInfo.gpu || '';
    document.getElementById('spec-ram').textContent = `${sysInfo.totalMemGB} GB total · ${sysInfo.freeMemGB} GB free`;
    const physCores = Number((String(sysInfo.cpuModel || '').match(/(\d+)-Core/i) || [])[1]) || 0;
    document.getElementById('spec-cores').textContent = physCores
      ? `${physCores} cores · ${sysInfo.cores} threads`
      : `${sysInfo.cores} threads`;

    // (No FPS gauge any more — see index.html. We report the specs we can
    // actually read and let the frame rate speak for itself in-game.)
  }

  await refreshStackStatus();
  renderMemVis();
  await renderAppliedGrid();

}

async function refreshStackStatus() {
  const stackEl = document.getElementById('mod-stack');
  const selVal = document.getElementById('launch-instance-select').value;
  const loader = currentLoader();
  PERF_STACK = perfStackFor(loader);

  const card = stackEl.closest('.stack-card');
  const btn0 = document.getElementById('optimize-btn');
  const foot0 = document.getElementById('optimize-foot');
  const title0 = card?.querySelector('.dock-title');
  if (title0) title0.textContent = loader === 'vanilla' ? 'Performance mods' : `Performance mods · ${loaderLabel(loader)}`;

  // Vanilla can't load mods at all, so the card offers the one thing that
  // does work there (Java flags + in-game settings) instead of dangling an
  // install button that can only ever fail.
  if (loader === 'vanilla') {
    stackEl.innerHTML = '<div class="stack-empty">Vanilla can\u2019t load mods — make a Fabric, Quilt or Forge instance to use these.</div>';
    document.getElementById('stack-status').textContent = selVal ? 'vanilla' : 'no instance';
    btn0.disabled = !selVal;
    btn0.querySelector('span:last-child').textContent = 'AUTO-TUNE SETTINGS';
    foot0.textContent = 'Applies best in-game settings and Java flags for your hardware.';
    return;
  }
  btn0.disabled = false;
  foot0.textContent = 'Installs and tunes each mod for your hardware.';

  let installed = new Set();
  let fileNames = [];
  if (selVal) {
    const [name, versionNumber] = selVal.split('|');
    try {
      const mods = await window.nebula.listInstalledMods({ name, versionNumber });
      // Collect EVERY identifier a mod might be known by. This used to hold
      // only projectId, and matched it against the stack's slug — so the
      // moment installs began recording Modrinth's real id ("AANobbMI")
      // instead of the slug ("sodium"), nothing matched and freshly
      // installed mods stayed grey no matter how many times you re-tuned.
      for (const m of mods) {
        fileNames.push(String(m.fileName || m.name || '').toLowerCase());
        for (const key of [m.projectId, m.slug, m.title, m.fileName, m.name]) {
          if (key) installed.add(String(key).toLowerCase().replace(/[\s_-]/g, ''));
        }
      }
    } catch { /* instance may not exist yet */ }
  }
  const norm = (v) => String(v || '').toLowerCase().replace(/[\s_-]/g, '');
  let onCount = 0;
  stackEl.innerHTML = '';
  for (const m of PERF_STACK) {
    const wanted = [norm(m.slug), norm(m.title)].filter(Boolean);
    const on = wanted.some(w =>
      installed.has(w)
      || Array.from(installed).some(x => x.includes(w) || w.includes(x))
      || fileNames.some(fn => fn.includes(String(m.slug || '').toLowerCase()) || fn.includes(String(m.title || '').toLowerCase().replace(/\s+/g, ''))),
    );
    if (on) onCount++;
    const item = document.createElement('div');
    item.className = 'stack-chip' + (on ? ' on' : '');
    item.title = `${m.title} — ${m.what}`;
    item.innerHTML = `<span class="sc-dot"></span><span class="sc-name">${m.title}</span>`;
    stackEl.appendChild(item);
  }
  const statusEl = document.getElementById('stack-status');
  statusEl.textContent = !selVal ? 'no instance' : onCount === 0 ? 'none installed' : `${onCount}/${PERF_STACK.length} installed`;
  statusEl.classList.toggle('all-on', onCount === PERF_STACK.length);
  const btn = document.getElementById('optimize-btn');
  const lbl = btn.querySelector('span:last-child');
  if (!btn.disabled) lbl.textContent = onCount === PERF_STACK.length ? 'RE-TUNE FOR THIS PC' : 'INSTALL ALL & AUTO-TUNE';
}

function renderMemVis() {
  const vis = document.getElementById('mem-vis');
  const total = sysInfo?.totalMemGB || 16;
  const slider = document.getElementById('mem-max');
  const cap = Math.max(2, Math.min(32, total - 2)); // never offer to starve the OS
  if (Number(slider.max) !== cap) slider.max = String(cap);
  const game = theme.memMax || 4;
  const rest = Math.max(0, total - game);
  // leaving under ~2GB for the OS is where things start swapping
  const risky = rest < 2;
  vis.innerHTML = `
    <div class="mem-seg ${risky ? 'danger' : 'game'}" style="flex:${game}"></div>
    <div class="mem-seg system" style="flex:${rest}"></div>
  `;
  const advice = document.getElementById('mem-advice');
  const currentlyFree = sysInfo?.freeMemGB;
  if (!sysInfo) { advice.textContent = 'Too much RAM can cause more lag, not less.'; return; }
  if (risky) { advice.textContent = `⚠ Too high for ${total} GB. Try ${Math.max(2, total - 4)} GB.`; return; }
  if (game > 8) { advice.textContent = 'Above 8 GB usually causes more lag than it fixes.'; return; }
  const freeNote = currentlyFree != null ? ` · ${currentlyFree} GB free now` : '';
  advice.textContent = `${game} GB for the game, ${rest} GB for everything else${freeNote}`;
}

async function renderAppliedGrid() {
  const grid = document.getElementById('applied-grid');
  const hint = document.getElementById('ad-hint');
  const selVal = document.getElementById('launch-instance-select').value;
  if (!selVal) { grid.innerHTML = '<p class="dim" style="margin:0;">Select an instance to see its settings.</p>'; hint.textContent = ''; return; }
  const [instanceName, versionNumber] = selVal.split('|');

  let disk = { exists: false, values: {}, profile: null };
  try { disk = await window.nebula.readSettings({ instanceName, versionNumber }); } catch { /* none yet */ }

  // Show what's ACTUALLY in options.txt right now — not what we intended.
  const v = disk.values || {};
  const cloudsVal = v.cloudStatus != null
    ? (v.cloudStatus === '0' ? 'Off' : v.cloudStatus === '1' ? 'Fast' : 'Fancy')
    : (v.renderClouds === 'false' ? 'Off' : v.renderClouds ? 'On' : '—');
  const items = [
    ['Render distance', v.renderDistance ? `${v.renderDistance} chunks` : '—'],
    ['Simulation dist.', v.simulationDistance ? `${v.simulationDistance} chunks` : '—'],
    ['Max framerate', v.maxFps ? (Number(v.maxFps) >= 260 ? 'Unlimited' : v.maxFps) : '—'],
    ['VSync', v.enableVsync === 'false' ? 'Off' : v.enableVsync === 'true' ? 'On' : '—'],
    ['Graphics', v.graphicsMode === '0' ? 'Fast' : v.graphicsMode === '1' ? 'Fancy' : v.graphicsMode === '2' ? 'Fabulous' : '—'],
    ['Clouds', cloudsVal],
    ['Particles', v.particles === '2' ? 'Minimal' : v.particles === '1' ? 'Decreased' : v.particles === '0' ? 'All' : '—'],
    ['Entity shadows', v.entityShadows === 'false' ? 'Off' : v.entityShadows === 'true' ? 'On' : '—'],
  ];
  grid.innerHTML = items.map(([k, val]) =>
    `<div class="applied-chip"><span class="ac-k">${k}</span><span class="ac-v${val === '—' ? ' none' : ''}">${val}</span></div>`
  ).join('');

  hint.textContent = !disk.exists
    ? 'not written yet — hit Optimize'
    : disk.profile
      ? `read from options.txt · re-applied every launch`
      : 'read from options.txt';
  hint.classList.toggle('good', !!disk.profile && disk.exists);
}

// ONE BUTTON: install every performance mod, tune each mod's own config for
// this PC, write the best vanilla + Sodium settings, then verify from disk.
document.getElementById('optimize-btn').addEventListener('click', async () => {
  const selVal = document.getElementById('launch-instance-select').value;
  if (!selVal) return showToast('No instance selected', 'Pick an instance first.', 'error');
  const [instanceName, versionNumber, loader] = selVal.split('|');

  const btn = document.getElementById('optimize-btn');
  const label = btn.querySelector('span:last-child');
  const foot = document.getElementById('optimize-foot');
  btn.disabled = true;

  const info = sysInfo || await window.nebula.systemInfo();
  sysInfo = info;
  PERF_STACK = perfStackFor(loader);
  // Forge is included now — it gets Embeddium/Radium/ModernFix rather than
  // the Fabric-only stack, which is why this used to bail out on Forge.
  const canMods = PERF_STACK.length > 0;

  let installed = 0, skipped = 0, failed = [];
  if (canMods) {
    label.textContent = 'INSTALLING…';
    const lookups = await Promise.all(PERF_STACK.map(async (m) => {
      try {
        const versions = await window.nebula.modVersions({ projectId: m.slug, versionNumber, loader });
        if (!versions.length) return { ...m, missing: true };
        const pick = pickModVersion(versions);
        const f = pick.files.find(x => x.primary) || pick.files[0];
        // Record Modrinth's real project id, not the slug we looked it up
        // by. The browse grid matches on project_id, so storing "sodium"
        // here meant every stack-installed mod still showed "Install".
        // Also grab the project's icon — writing '' here is why every mod
        // the stack installed showed a blank placeholder in the library.
        let iconUrl = '';
        try {
          const pRes = await fetch(`https://api.modrinth.com/v2/project/${m.slug}`);
          if (pRes.ok) iconUrl = (await pRes.json()).icon_url || '';
        } catch { /* icon is cosmetic; don't fail the install over it */ }
        return { ...m, url: f.url, filename: f.filename, iconUrl, projectId: pick.project_id || m.slug };
      } catch { return { ...m, missing: true }; }
    }));

    let done = 0;
    for (const m of lookups) {
      done++;
      if (m.missing) { skipped++; failed.push(m.title); continue; }
      foot.textContent = `Installing ${m.title} (${done}/${lookups.length})…`;
      const installId = `opt-${m.slug}-${Date.now()}`;
      try {
        showDownloadBar(installId, m.title);
        await window.nebula.installMod({
          fileUrl: m.url, fileName: m.filename, instanceName, versionNumber, folder: 'mods',
          installId, projectId: m.projectId || m.slug, slug: m.slug, title: m.title, iconUrl: m.iconUrl || '',
        });
        installed++;
      } catch { removeDownloadBar(installId); skipped++; failed.push(m.title); }
      await refreshStackStatus();
    }

    // tune every installed mod's own config to this machine
    label.textContent = 'TUNING MODS…';
    foot.textContent = 'Writing per-mod configs tuned to your hardware…';
    try {
      const res = await window.nebula.tuneMods({ instanceName, versionNumber, tier: info.tier });
      foot.textContent = `Tuned ${res.tuned.length} mod configs for your ${info.tier}-tier PC.`;
    } catch { /* best effort */ }
  }

  // vanilla + Sodium settings, saved as a profile so they're re-applied on
  // EVERY launch (Minecraft overwrites options.txt on exit otherwise)
  label.textContent = 'APPLYING…';
  try {
    await window.nebula.applyBestSettings({ instanceName, versionNumber, tier: info.tier });
  } catch (err) {
    showToast('Couldn\'t write settings', err.message, 'error');
  }

  await renderPerformance();
  btn.disabled = false;
  label.textContent = 'RE-TUNE FOR THIS PC';

  if (!canMods) {
    foot.textContent = 'Settings applied. Mods need a Fabric or Quilt instance.';
    showToast('Settings applied', `Best ${info.tier}-tier settings written and locked in for every launch. For the mod stack (2–4× FPS), create a Fabric instance.`, 'success');
  } else {
    foot.textContent = `${installed} mods installed & tuned · settings re-applied on every launch.`;
    showToast('Optimized', `${installed} mod${installed !== 1 ? 's' : ''} installed and individually tuned for your ${info.tier}-tier PC${skipped ? `. ${skipped} unavailable for ${versionNumber}${failed.length ? ` (${failed.slice(0,3).join(', ')})` : ''}` : ''}. Settings are now re-applied automatically on every launch.`, installed ? 'success' : 'error');
  }
  refreshInstalledContent();
});

// keep the legacy hidden boost button working (command palette targets it)
document.getElementById('install-boost-btn').addEventListener('click', () => {
  switchView('launchpad');
  setTimeout(() => document.getElementById('optimize-btn').click(), 200);
});

// =====================================================================
// EDITION SWITCH — Java ⇄ Bedrock
// =====================================================================
let currentEdition = 'java';
let bedrockInfo = null;
let bedrockChannel = 'release';

function setEdition(edition) {
  currentEdition = edition;
  document.querySelectorAll('#edition-switch .edition-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.edition === edition));

  const isJava = edition === 'java';
  document.querySelector('.launch-cluster').classList.toggle('hidden', !isJava);
  document.getElementById('prewarm-chip').classList.toggle('hidden', !isJava || !prewarmChip.dataset.active);
  document.getElementById('bedrock-panel').classList.toggle('hidden', isJava);
  if (!isJava) refreshBedrock();
  paintLaunchArt();
  requestAnimationFrame(placeVersionWatermark);
}
document.querySelectorAll('#edition-switch .edition-btn').forEach(btn => {
  btn.addEventListener('click', () => setEdition(btn.dataset.edition));
});
document.querySelectorAll('#bedrock-edition-switch .edition-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    bedrockChannel = btn.dataset.bedrock;
    document.querySelectorAll('#bedrock-edition-switch .edition-btn').forEach(b => b.classList.toggle('active', b === btn));
    updateBedrockButton();
  });
});

async function refreshBedrock() {
  if (!bedrockInfo) {
    try { bedrockInfo = await window.nebula.detectBedrock(); }
    catch (err) { bedrockInfo = { supported: false, installed: false, reason: err.message }; }
  }
  updateBedrockButton();
}

function updateBedrockButton() {
  const btn = document.getElementById('bedrock-launch-btn');
  const sub = document.getElementById('bedrock-sub');
  const note = document.getElementById('bedrock-note');
  const storeBtn = document.getElementById('bedrock-store-btn');
  const switcher = document.getElementById('bedrock-edition-switch');

  if (!bedrockInfo) { sub.textContent = 'Checking…'; btn.disabled = true; return; }

  if (!bedrockInfo.supported) {
    btn.disabled = true;
    sub.textContent = 'Windows only';
    note.innerHTML = bedrockInfo.reason;
    storeBtn.classList.add('hidden');
    switcher.classList.add('hidden');
    return;
  }

  switcher.classList.remove('hidden');
  const target = bedrockChannel === 'preview' ? bedrockInfo.preview : bedrockInfo.release;
  document.querySelectorAll('#bedrock-edition-switch .edition-btn').forEach(b => {
    const t = b.dataset.bedrock === 'preview' ? bedrockInfo.preview : bedrockInfo.release;
    b.classList.toggle('unavailable', !t?.installed);
  });

  if (target?.installed) {
    btn.disabled = false;
    sub.textContent = target.version ? `Minecraft for Windows ${target.version}` : 'Minecraft for Windows';
    note.innerHTML = 'Bedrock is a Microsoft Store app, so SolarClient starts your installed copy rather than downloading versions itself. <b>Discord presence still shows you playing.</b>';
    storeBtn.classList.add('hidden');
  } else {
    btn.disabled = true;
    sub.textContent = bedrockChannel === 'preview' ? 'Preview not installed' : 'Not installed';
    note.innerHTML = bedrockInfo.reason || 'Minecraft for Windows isn\'t installed yet.';
    storeBtn.classList.remove('hidden');
  }
  paintLaunchArt();
}

document.getElementById('bedrock-launch-btn').addEventListener('click', async () => {
  const btn = document.getElementById('bedrock-launch-btn');
  btn.disabled = true;
  try {
    await window.nebula.launchBedrock({ preview: bedrockChannel === 'preview' });
    showToast('Bedrock launching', 'Minecraft for Windows is starting — it may take a moment to appear.', 'success');
  } catch (err) {
    showToast('Couldn\'t launch Bedrock', err.message, 'error');
  }
  setTimeout(() => { btn.disabled = false; }, 2500);
});
document.getElementById('bedrock-store-btn').addEventListener('click', () => window.nebula.openBedrockStore());

// =====================================================================
// DISCORD SETTINGS — Rich Presence needs a real Application ID from a free
// app the user creates; Discord rejects unknown ids outright (CLOSE 4000),
// which is exactly why it silently did nothing before.
// =====================================================================
function applyDiscordState(s) {
  if (!s) return;
  updateDiscordBanner(s);

  const toggle = document.getElementById('discord-toggle');
  const details = document.getElementById('discord-details-toggle');
  if (toggle) toggle.checked = s.enabled;
  if (details) { details.checked = s.showDetails; details.disabled = !s.enabled; }

  const badge = document.getElementById('dp-status');
  if (badge) {
    if (!s.enabled) { badge.textContent = 'Off'; badge.classList.remove('live'); }
    else if (s.connected) { badge.textContent = 'Live'; badge.classList.add('live'); }
    else { badge.textContent = 'Discord not open'; badge.classList.remove('live'); }
  }
  updateDiscordPreview();
}

function updateDiscordPreview() {
  const details = document.getElementById('dp-details');
  const state = document.getElementById('dp-state');
  if (!details || !state) return;
  const showDetails = document.getElementById('discord-details-toggle')?.checked ?? true;
  const selVal = document.getElementById('launch-instance-select')?.value || '';
  const running = runningLaunches.size > 0;
  const ed = currentEdition === 'bedrock' ? 'Bedrock Edition' : 'Java Edition';
  const version = selVal ? selVal.split('|')[1] : '';
  const name = selVal ? selVal.split('|')[0] : '';
  details.textContent = running ? 'Playing Minecraft' : 'In the launcher';
  state.textContent = !running
    ? 'Browsing instances'
    : (showDetails && version ? `${ed} ${version}${name ? ` · ${name}` : ''}` : ed);

  // Big image mirrors the real presence: Minecraft while playing,
  // SolarClient while idle. Badge is SolarClient only when in-game.
  const art = document.getElementById('dp-art-img');
  const badgeImg = document.getElementById('dp-badge-img');
  if (art) art.src = running ? 'img/minecraft.png' : 'img/nebula.png?v=3';
  if (badgeImg) {
    badgeImg.src = 'img/nebula.png?v=3';
    badgeImg.style.display = running ? 'block' : 'none';
  }
}

async function refreshDiscordSettings() {
  try {
    applyDiscordState(await window.nebula.discordSettings());
  } catch (err) {
    // Swallowing this silently is how the banner ended up frozen on its
    // hardcoded HTML with nobody any the wiser.
    console.warn('[SolarClient] could not read Discord state:', err);
  }
}

// The banner lives on the launchpad, but this only ever ran when you
// opened Settings — so on the launch page the card just sat there showing
// the static "Link Discord" markup forever, no matter how many times you
// linked. Fetch on boot, and follow live state from main after that.
refreshDiscordSettings();
window.nebula.onDiscordState?.((s) => applyDiscordState(s));


document.getElementById('discord-toggle')?.addEventListener('change', async (e) => {
  await window.nebula.setDiscordEnabled(e.target.checked);
  setTimeout(refreshDiscordSettings, 500);
});
document.getElementById('discord-details-toggle')?.addEventListener('change', async (e) => {
  await window.nebula.setDiscordShowDetails(e.target.checked);
  updateDiscordPreview();
});

// ---------- launchpad Discord card — always visible ----------
function updateDiscordBanner(s) {
  const banner = document.getElementById('discord-link-banner');
  const title = document.getElementById('dlb-title');
  const sub = document.getElementById('dlb-sub');
  const btn = document.getElementById('dlb-link-btn');
  if (!banner) return;

  banner.classList.remove('hidden');
  banner.classList.toggle('discord-live', !!s.connected);

  // Once you've linked, the link is saved and the card never comes back.
  // It used to reappear as a "Link Discord" CTA every session whenever
  // Discord simply wasn't open yet, which read as if the link hadn't
  // stuck. Linking is remembered; the card is for people who haven't.
  // `linked` comes from the main store now — it's set the first time
  // Discord ever hands us a ready event and never cleared, so the CTA
  // can't come back after you've linked once.
  if (s.linked || s.connected) localStorage.setItem('nebula-discord-linked', '1');
  const everLinked = s.linked || localStorage.getItem('nebula-discord-linked') === '1';
  const dismissed = localStorage.getItem('nebula-discord-banner-dismissed') === '1';

  if (s.connected || everLinked || dismissed) {
    banner.classList.add('hidden');
    return;
  } else if (s.enabled && !s.connected) {
    title.textContent = 'Discord';
    sub.textContent = s.error || 'Open Discord and it will connect automatically';
    btn.textContent = 'Waiting…';
    btn.disabled = true;
    btn.style.opacity = '0.6';
  } else {
    title.textContent = 'Link Discord';
    sub.textContent = 'Show what you\'re playing on your Discord profile';
    btn.textContent = 'Link Discord';
    btn.disabled = false;
    btn.style.opacity = '1';
  }
}

document.getElementById('dlb-link-btn').addEventListener('click', async () => {
  const s = await window.nebula.discordSettings();
  if (s.appId) {
    // A built-in (or previously-saved) app ID already exists — just turn
    // it on. No settings detour, no ID box, matches what "Link Discord"
    // should feel like for a normal user.
    const btn = document.getElementById('dlb-link-btn');
    btn.disabled = true; btn.textContent = 'Linking…';
    await window.nebula.setDiscordEnabled(true);
    // You asked once. That's the link. Whether Discord happens to be
    // running this second is a separate question and shouldn't make the
    // button come back.
    localStorage.setItem('nebula-discord-linked', '1');
    const updated = await window.nebula.discordSettings();
    applyDiscordState(updated);
    btn.disabled = false; btn.textContent = 'Link Discord';
    if (updated.connected) showToast('Discord linked', updated.user ? `Showing on Discord as ${updated.user}.` : 'Rich Presence is live.', 'success');
    else showToast('Almost there', updated.error || 'Open Discord desktop and this will connect automatically.', 'error');
    return;
  }
  // No app ID configured anywhere yet — this build genuinely can't turn
  // Rich Presence on until the developer adds one, so send to Settings
  // where that's explained rather than pretending a click here would work.
  document.querySelector('.nav-btn[data-view="settings"]').click();
  const advanced = document.getElementById('ds-advanced');
  if (advanced) advanced.open = true;
  document.getElementById('discord-appid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('discord-appid')?.focus();
});
document.getElementById('dlb-dismiss-btn').addEventListener('click', () => {
  localStorage.setItem('nebula-discord-banner-dismissed', '1');
  document.getElementById('discord-link-banner').classList.add('hidden');
});


// =====================================================================
// SKINS — library, apply, and a pixel editor.
// =====================================================================
let skinsViewer = null;
let skinLibrary = [];
let selectedSkin = null;

function ensureSkinsViewer() {
  if (!window.Skin3D) {
    ensureSkin3D().then(() => {
      if (window.Skin3D && !skinsViewer) ensureSkinsViewer();
      if (selectedSkin) selectSkin(selectedSkin);
    });
    return null;
  }
  if (!skinsViewer) {
    skinsViewer = new Skin3D(document.getElementById('skins-canvas'), { yaw: 0.5 });
    document.getElementById('skins-overlay').addEventListener('change', (e) => {
      skinsViewer.setOverlay(e.target.checked);
    });
    document.querySelectorAll('#view-toggle .model-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#view-toggle .model-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // Front/back are now just preset angles — you can drag anywhere.
        skinsViewer.yaw = btn.dataset.view === 'back' ? Math.PI : 0.5;
        skinsViewer.pitch = 0;
        skinsViewer.requestRender();
      });
    });
    document.querySelectorAll('#model-toggle .model-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#model-toggle .model-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        skinsViewer.setSlim(btn.dataset.model === 'slim');
        if (selectedSkin) selectedSkin.model = btn.dataset.model;
      });
    });
  }
  return skinsViewer;
}

function selectSkin(entry) {
  selectedSkin = entry;
  const v = ensureSkinsViewer();
  if (!v) return;
  v.setSkin(entry.dataUrl).then(() => {
    // detectSlim runs on load; reflect whatever it found unless the entry
    // has an explicit model saved from a previous apply.
    const model = entry.model || (v.slim ? 'slim' : 'classic');
    v.setSlim(model === 'slim');
    document.querySelectorAll('#model-toggle .model-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.model === model));
  }).catch(err => showToast('Could not load skin', err.message, 'error'));

  document.getElementById('skins-preview-name').textContent = entry.name;
  document.getElementById('skin-apply-btn').disabled = false;
  document.getElementById('skin-edit-btn').disabled = false;
  document.querySelectorAll('.skin-tile').forEach(t =>
    t.classList.toggle('active', t.dataset.id === entry.id));
}

async function refreshSkins() {
  skinLibrary = await window.nebula.skinsList();
  const grid = document.getElementById('skins-grid');
  grid.innerHTML = '';
  if (!skinLibrary.length) {
    grid.innerHTML = '<p class="dim" style="grid-column:1/-1;">Nothing here yet — upload a PNG or start a new skin.</p>';
    return;
  }
  for (const entry of skinLibrary) {
    const tile = document.createElement('div');
    tile.className = 'skin-tile' + (selectedSkin?.id === entry.id ? ' active' : '');
    tile.dataset.id = entry.id;
    tile.innerHTML = `
      <canvas class="skin-tile-face" width="72" height="72"></canvas>
      <div class="skin-tile-name" title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</div>
      <button class="skin-tile-del" title="Remove from library"><svg class="trash-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>
    `;
    // Draw just the head (with hat layer) as the thumbnail — cheap, and it
    // reads better at this size than a whole body would.
    const img = new Image();
    img.onload = () => {
      const g = tile.querySelector('canvas').getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 8, 8, 8, 8, 0, 0, 72, 72);
      g.drawImage(img, 40, 8, 8, 8, 0, 0, 72, 72);
    };
    img.src = entry.dataUrl;

    tile.addEventListener('click', (e) => {
      if (e.target.classList.contains('skin-tile-del')) return;
      selectSkin(entry);
    });
    tile.querySelector('.skin-tile-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await showConfirm(`Remove "${entry.name}" from your library? The skin on your account isn't affected.`,
        { title: 'Remove skin?', confirmLabel: 'Remove' });
      if (!ok) return;
      await window.nebula.skinsDelete({ id: entry.id });
      if (selectedSkin?.id === entry.id) {
        selectedSkin = null;
        document.getElementById('skin-apply-btn').disabled = true;
        document.getElementById('skin-edit-btn').disabled = true;
        document.getElementById('skins-preview-name').textContent = 'No skin selected';
      }
      refreshSkins();
    });
    grid.appendChild(tile);
  }
  if (!selectedSkin && skinLibrary.length) selectSkin(skinLibrary[0]);
}

document.getElementById('skin-import-btn').addEventListener('click', async () => {
  const added = await window.nebula.skinsImport();
  if (added.length) showToast('Added to library', `${added.length} skin${added.length === 1 ? '' : 's'} imported.`, 'success');
  await refreshSkins();
});

document.getElementById('skin-apply-btn').addEventListener('click', async () => {
  if (!selectedSkin) return;
  const btn = document.getElementById('skin-apply-btn');
  const model = document.querySelector('#model-toggle .model-btn.active')?.dataset.model || 'classic';
  btn.disabled = true; btn.textContent = 'Applying…';
  try {
    await window.nebula.skinsApply({ id: selectedSkin.id, model });
    showToast('Skin applied', 'Mojang has it — it can take a minute to show elsewhere.', 'success');
    const me = await window.nebula.currentAccount().catch(() => null);
    if (me) rememberAppliedSkin(me.id, selectedSkin.dataUrl, model);
    heroSkinRun++;   // a load still in flight must not overwrite this
    // Paint the hero from the local file immediately rather than waiting
    // on Mojang's CDN. Re-fetching by UUID served a cached copy of the OLD
    // skin for minutes, so the launchpad appeared not to update at all.
    if (heroViewer) {
      await heroViewer.setSkin(selectedSkin.dataUrl).catch(() => {});
      heroViewer.setSlim(model === 'slim');
      applyHeroCosmetic();
      document.getElementById('skin-canvas')?.classList.remove('hidden');
      document.getElementById('skin-render').style.display = 'none';
    } else {
      const current = await window.nebula.currentAccount();
      if (current) mountHeroSkin(current.id);
    }
  } catch (err) {
    showToast('Couldn\u2019t apply skin', err.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Apply to my account';
  }
});

// drag & drop PNGs onto the library
const skinsDropTarget = document.getElementById('view-skins');
skinsDropTarget.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.getElementById('skins-drop-hint').classList.add('active');
});
skinsDropTarget.addEventListener('dragleave', () => {
  document.getElementById('skins-drop-hint').classList.remove('active');
});
skinsDropTarget.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.getElementById('skins-drop-hint').classList.remove('active');
  const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.png'));
  if (!files.length) return showToast('Not a skin', 'Drop a .png skin file.', 'error');
  for (const f of files) {
    const dataUrl = await new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(f);
    });
    await window.nebula.skinsSaveDataUrl({ dataUrl, name: f.name.replace(/\.png$/i, ''), model: 'classic' });
  }
  showToast('Added to library', `${files.length} skin${files.length === 1 ? '' : 's'} imported.`, 'success');
  refreshSkins();
});

// ---------------------------------------------------------------------
// SKIN EDITOR — paints directly on the 64x64 texture, with the 3D model
// updating live so you can see where a pixel actually lands.
// ---------------------------------------------------------------------
const editor = {
  el: document.getElementById('skin-editor'),
  canvas: document.getElementById('se-canvas'),
  ctx: null,
  viewer: null,
  tool: 'pencil',
  color: '#8b5cf6',
  undoStack: [],
  showGrid: true,
  editing: null,
  painting: false,
  part: 'all',
  layer: 'inner',
  mode: 'paint',
  redoStack: [],
};

// Texture rectangles per body part, split by layer. Selecting a part masks
// everything else off, so you cannot paint into the neighbouring region by
// accident — which on a 64x64 sheet is very easy to do.
const SE_PARTS = {
  head: { inner: [0, 0, 32, 16],  outer: [32, 0, 32, 16] },
  body: { inner: [16, 16, 24, 16], outer: [16, 32, 24, 16] },
  armR: { inner: [40, 16, 16, 16], outer: [40, 32, 16, 16] },
  armL: { inner: [32, 48, 16, 16], outer: [48, 48, 16, 16] },
  legR: { inner: [0, 16, 16, 16],  outer: [0, 32, 16, 16] },
  legL: { inner: [16, 48, 16, 16], outer: [0, 48, 16, 16] },
};

// Which rectangles the current part+layer selection allows editing.
function activeRects() {
  const parts = editor.part === 'all' ? Object.keys(SE_PARTS) : [editor.part];
  const layers = editor.layer === 'both' ? ['inner', 'outer'] : [editor.layer];
  const out = [];
  for (const p of parts) for (const l of layers) if (SE_PARTS[p]) out.push(SE_PARTS[p][l]);
  return out;
}
function inActiveArea(x, y) {
  return activeRects().some(([rx, ry, rw, rh]) => x >= rx && x < rx + rw && y >= ry && y < ry + rh);
}

const SE_PALETTE = [
  '#000000', '#3c3c3c', '#7c7c7c', '#c8c8c8', '#ffffff',
  '#8b5cf6', '#6d28d9', '#2563eb', '#0ea5e9', '#14b8a6',
  '#22c55e', '#84cc16', '#eab308', '#f97316', '#dc2626',
  '#ec4899', '#7c2d12', '#a16207', '#4a2f1a', '#f5deb3',
];

// Which model part a texture pixel belongs to — shown in the footer so
// you're never guessing which of the 64x64 squares is the left sleeve.
const SE_REGIONS = [
  { x: 8, y: 0, w: 16, h: 8, name: 'Head — top/bottom' },
  { x: 0, y: 8, w: 32, h: 8, name: 'Head — sides' },
  { x: 32, y: 0, w: 32, h: 16, name: 'Hat layer' },
  { x: 16, y: 16, w: 24, h: 16, name: 'Body' },
  { x: 40, y: 16, w: 16, h: 16, name: 'Right arm' },
  { x: 0, y: 16, w: 16, h: 16, name: 'Right leg' },
  { x: 16, y: 32, w: 24, h: 16, name: 'Jacket' },
  { x: 40, y: 32, w: 16, h: 16, name: 'Right sleeve' },
  { x: 0, y: 32, w: 16, h: 16, name: 'Right trouser' },
  { x: 32, y: 48, w: 16, h: 16, name: 'Left arm' },
  { x: 48, y: 48, w: 16, h: 16, name: 'Left sleeve' },
  { x: 16, y: 48, w: 16, h: 16, name: 'Left leg' },
  { x: 0, y: 48, w: 16, h: 16, name: 'Left trouser' },
];
function regionAt(x, y) {
  const hit = SE_REGIONS.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  return hit ? hit.name : 'unused';
}

function openSkinEditor(entry) {
  editor.editing = entry || null;
  editor.ctx = editor.canvas.getContext('2d', { willReadFrequently: true });
  editor.ctx.imageSmoothingEnabled = false;
  editor.ctx.clearRect(0, 0, 64, 64);
  editor.undoStack = [];

  const start = () => {
    editor.el.classList.remove('hidden');
    if (!editor.viewer) {
      if (!window.Skin3D) {
        ensureSkin3D().then(() => start());
        return;
      }
      editor.viewer = new Skin3D(document.getElementById('se-model'), { yaw: 0.5, zoom: 1.05 });
      editor.viewer.paintMode = true;
      wireModelPainting(editor.viewer);
    }
    syncEditorPreview();
    drawEditorGrid();
  };

  if (entry) {
    document.getElementById('se-name').value = `${entry.name} (copy)`;
    const img = new Image();
    img.onload = () => { editor.ctx.drawImage(img, 0, 0, 64, 64); start(); };
    img.src = entry.dataUrl;
  } else {
    // A blank 64x64 is unusable as a starting point — you'd be drawing a
    // person from nothing. Start from a plain base body instead.
    document.getElementById('se-name').value = 'New skin';
    paintBaseSkin(editor.ctx);
    start();
  }
}

// A neutral starting figure: skin-tone head/arms, shirt, trousers.
function paintBaseSkin(ctx) {
  const put = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const SKIN = '#c68642', SHIRT = '#8b5cf6', PANTS = '#3b3663', SHOE = '#2a2440', HAIR = '#3a2a1c';
  put(0, 8, 32, 8, SKIN); put(8, 0, 16, 8, HAIR);           // head
  put(8, 8, 8, 8, HAIR);                                     // back of head hair
  put(16, 16, 24, 16, SHIRT);                                // body
  put(40, 16, 16, 16, SKIN); put(32, 48, 16, 16, SKIN);      // arms
  put(0, 16, 16, 16, PANTS); put(16, 48, 16, 16, PANTS);     // legs
  put(0, 16, 16, 4, SHOE); put(16, 48, 16, 4, SHOE);         // feet tops
  // eyes
  put(9, 12, 2, 1, '#ffffff'); put(13, 12, 2, 1, '#ffffff');
  put(10, 12, 1, 1, '#4b3ca8'); put(14, 12, 1, 1, '#4b3ca8');
}

// Painting directly on the 3D body. A click is inverted back through the
// face's own texture transform (Skin3D.pick), so the pixel you hit is the
// pixel you see — including on the back and the insides of limbs, which is
// the whole point of doing it on the model rather than the flat sheet.
function wireModelPainting(viewer) {
  const el = viewer.canvas;
  let painting = false;
  let rotating = false;
  let rx = 0, ry = 0;

  const paintAt = (e, isStart) => {
    const hit = viewer.pick(e.clientX, e.clientY, editor.layer);
    if (!hit) return;
    // Respect the part and layer you've selected, exactly as on the sheet.
    if (editor.part !== 'all' && hit.part !== editor.part) return;
    if (editor.layer !== 'both' && hit.layer !== editor.layer) return;
    if (!inActiveArea(hit.x, hit.y)) return;

    if (isStart) pushUndo();
    if (editor.tool === 'picker') {
      const p = editor.ctx.getImageData(hit.x, hit.y, 1, 1).data;
      if (p[3] > 0) {
        window.setEditorColor?.('#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join(''));
      }
      return;
    }
    if (editor.tool === 'eraser') editor.ctx.clearRect(hit.x, hit.y, 1, 1);
    else if (editor.tool === 'fill') { if (isStart) floodFill(hit.x, hit.y, hexToRgba(editor.color)); }
    else { editor.ctx.fillStyle = editor.color; editor.ctx.fillRect(hit.x, hit.y, 1, 1); }

    document.getElementById('se-part-label').textContent =
      `${hit.part} · ${hit.layer} · ${hit.face} (${hit.x},${hit.y})`;
    syncEditorPreview();
  };

  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('mousedown', (e) => {
    // Right button always rotates, whichever mode you're in, so you never
    // have to break a painting session just to see the other side.
    // Both dragging and painting drive frames fast, so both drop the model
    // to native scale for the duration and let the sharp supersampled pass
    // run once things settle.
    viewer.beginInteraction();
    if (e.button === 2 || editor.mode === 'rotate') {
      rotating = true; rx = e.clientX; ry = e.clientY;
      el.classList.add('grabbing');
    } else if (e.button === 0) {
      painting = true; paintAt(e, true);
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (rotating) {
      viewer.yaw += (e.clientX - rx) * 0.014;
      viewer.pitch = Math.max(-0.6, Math.min(0.6, viewer.pitch + (e.clientY - ry) * 0.008));
      rx = e.clientX; ry = e.clientY;
      viewer.requestRender();
    } else if (painting) {
      paintAt(e, false);
    }
  });
  window.addEventListener('mouseup', () => {
    if (painting) syncEditorPreview();
    if (painting || rotating) viewer.endInteraction();
    painting = false; rotating = false;
    el.classList.remove('grabbing');
  });
  el.addEventListener('dblclick', () => { viewer.yaw = 0.5; viewer.pitch = 0; viewer.requestRender(); });
}

// Rebuilding the model after a brush stroke reads the texture canvas
// directly rather than round-tripping through a PNG data URL, and is
// coalesced to one update per frame. A brush drag fires far more pointer
// events than the screen has frames, and the encode/decode cost about
// 15ms per event — which is what made painting feel like it was catching.
// setSkinFromCanvas keeps yaw/pitch, so there is no camera to restore.
let editorSyncQueued = false;
function syncEditorPreview() {
  if (!editor.viewer || editorSyncQueued) return;
  editorSyncQueued = true;
  requestAnimationFrame(() => {
    editorSyncQueued = false;
    if (editor.viewer) editor.viewer.setSkinFromCanvas(editor.canvas);
  });
}

function drawEditorGrid() {
  const grid = document.getElementById('se-grid');
  const wrap = editor.canvas.getBoundingClientRect();
  const size = Math.round(wrap.width) || 448;
  grid.width = size; grid.height = size;
  const g = grid.getContext('2d');
  g.clearRect(0, 0, size, size);
  if (!editor.showGrid) return;
  const cell = size / 64;
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  for (let i = 0; i <= 64; i++) {
    const p = Math.round(i * cell) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  // heavier lines at the 8px part boundaries
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  for (let i = 0; i <= 64; i += 8) {
    const p = Math.round(i * cell) + 0.5;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  drawEditorMask();
}

// Dim everything outside the selected part/layer. Drawn on the grid canvas
// so it never touches the actual texture.
function drawEditorMask() {
  const grid = document.getElementById('se-grid');
  const g = grid.getContext('2d');
  const size = grid.width;
  const cell = size / 64;
  const rects = activeRects();
  if (editor.part === 'all' && editor.layer === 'both') return;

  g.save();
  g.beginPath();
  g.rect(0, 0, size, size);
  for (const [x, y, w, h] of rects) {
    g.rect(x * cell, y * cell, w * cell, h * cell);   // punch holes
  }
  g.fillStyle = 'rgba(6,4,14,0.72)';
  g.fill('evenodd');
  g.restore();

  g.strokeStyle = 'var(--accent)';
  g.strokeStyle = '#8b5cf6';
  g.lineWidth = 2;
  for (const [x, y, w, h] of rects) {
    g.strokeRect(x * cell + 1, y * cell + 1, w * cell - 2, h * cell - 2);
  }
}

function pushUndo() {
  editor.undoStack.push(editor.ctx.getImageData(0, 0, 64, 64));
  editor.redoStack.length = 0;   // a new stroke invalidates the redo chain
  if (editor.undoStack.length > 60) editor.undoStack.shift();
}

function editorPixelAt(e) {
  const r = editor.canvas.getBoundingClientRect();
  return {
    x: Math.floor(((e.clientX - r.left) / r.width) * 64),
    y: Math.floor(((e.clientY - r.top) / r.height) * 64),
  };
}

function hexToRgba(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

function floodFill(x, y, rgba) {
  const img = editor.ctx.getImageData(0, 0, 64, 64);
  const d = img.data;
  const idx = (px, py) => (py * 64 + px) * 4;
  const start = idx(x, y);
  const target = [d[start], d[start + 1], d[start + 2], d[start + 3]];
  if (target.every((v, i) => v === rgba[i])) return;
  // Constrain the fill to the region you clicked in, so filling the shirt
  // can never bleed into the sleeve texture next door.
  const region = SE_REGIONS.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
  const inBounds = (px, py) => region
    ? px >= region.x && px < region.x + region.w && py >= region.y && py < region.y + region.h
    : px >= 0 && px < 64 && py >= 0 && py < 64;

  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (!inBounds(px, py)) continue;
    const i = idx(px, py);
    if (d[i] !== target[0] || d[i + 1] !== target[1] || d[i + 2] !== target[2] || d[i + 3] !== target[3]) continue;
    d[i] = rgba[0]; d[i + 1] = rgba[1]; d[i + 2] = rgba[2]; d[i + 3] = rgba[3];
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  editor.ctx.putImageData(img, 0, 0);
}

function applyEditorTool(e, isStart) {
  const { x, y } = editorPixelAt(e);
  if (x < 0 || x > 63 || y < 0 || y > 63) return;
  const allowed = inActiveArea(x, y);
  document.getElementById('se-part-label').textContent =
    `${x}, ${y} — ${regionAt(x, y)}${allowed ? '' : ' (masked)'}`;
  if (!editor.painting || !allowed) return;

  if (editor.tool === 'picker') {
    const p = editor.ctx.getImageData(x, y, 1, 1).data;
    if (p[3] > 0) {
      const hex = '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
      window.setEditorColor?.(hex);
    }
    return;
  }
  if (isStart) pushUndo();
  if (editor.tool === 'eraser') {
    editor.ctx.clearRect(x, y, 1, 1);
  } else if (editor.tool === 'fill') {
    if (isStart) floodFill(x, y, hexToRgba(editor.color));
  } else {
    editor.ctx.fillStyle = editor.color;
    editor.ctx.fillRect(x, y, 1, 1);
  }
}

(function wireEditor() {
  const c = editor.canvas;
  let previewTimer = null;
  const schedulePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(syncEditorPreview, 120);
  };

  c.addEventListener('mousedown', (e) => { editor.painting = true; applyEditorTool(e, true); schedulePreview(); });
  c.addEventListener('mousemove', (e) => { applyEditorTool(e, false); if (editor.painting) schedulePreview(); });
  window.addEventListener('mouseup', () => {
    if (editor.painting) { editor.painting = false; syncEditorPreview(); }
  });

  document.querySelectorAll('.se-tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.se-tool[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      editor.tool = btn.dataset.tool;
    });
  });
  document.getElementById('se-undo').addEventListener('click', () => {
    const prev = editor.undoStack.pop();
    if (!prev) return;
    editor.redoStack.push(editor.ctx.getImageData(0, 0, 64, 64));
    editor.ctx.putImageData(prev, 0, 0);
    syncEditorPreview();
  });
  document.getElementById('se-redo').addEventListener('click', () => {
    const next = editor.redoStack.pop();
    if (!next) return;
    editor.undoStack.push(editor.ctx.getImageData(0, 0, 64, 64));
    editor.ctx.putImageData(next, 0, 0);
    syncEditorPreview();
  });

  // ---- paint / rotate mode ----
  document.querySelectorAll('#se-mode .se-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#se-mode .se-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      editor.mode = btn.dataset.mode;
      const el = document.getElementById('se-model');
      el.classList.toggle('rotating', editor.mode === 'rotate');
    });
  });

  // ---- part isolation ----
  document.querySelectorAll('#se-parts [data-part]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#se-parts [data-part]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      editor.part = btn.dataset.part;
      // Hide the other parts in the preview so you can see what you're on.
      const hidden = editor.part === 'all'
        ? []
        : Object.keys(SE_PARTS).filter(p => p !== editor.part);
      editor.viewer?.setHiddenParts(hidden);
      drawEditorGrid();
    });
  });

  // ---- inner / outer layer ----
  document.querySelectorAll('#se-layer-toggle .se-layer-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#se-layer-toggle .se-layer-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      editor.layer = btn.dataset.layer;
      // Working on the outer layer is pointless if it's hidden in preview.
      editor.viewer?.setOverlay(editor.layer !== 'inner' ? true : editor.viewer.showOverlay);
      drawEditorGrid();
    });
  });
  document.getElementById('se-grid-toggle').addEventListener('click', () => {
    editor.showGrid = !editor.showGrid;
    drawEditorGrid();
  });

  // ---- colour wheel (hue ring + saturation/value square + hex) ----
  const wheel = document.getElementById('se-wheel');
  const sv = document.getElementById('se-sv');
  const hexInput = document.getElementById('se-hex');
  let hsv = { h: 258, s: 0.65, v: 0.96 };

  function hsvToRgb(h, sat, val) {
    const c = val * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = val - c;
    const t = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60) % 6];
    return t.map(v => Math.round((v + m) * 255));
  }
  function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  function hexToHsv(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
    }
    return { h: (h * 60 + 360) % 360, s: mx ? d / mx : 0, v: mx };
  }

  function paintWheel() {
    const g = wheel.getContext('2d');
    const size = wheel.width, r = size / 2, inner = r * 0.72;
    g.clearRect(0, 0, size, size);
    // hue ring, drawn as fine wedges
    for (let a = 0; a < 360; a++) {
      g.beginPath();
      g.arc(r, r, r - 1, (a - 0.7) * Math.PI / 180, (a + 0.7) * Math.PI / 180);
      g.arc(r, r, inner, (a + 0.7) * Math.PI / 180, (a - 0.7) * Math.PI / 180, true);
      g.closePath();
      g.fillStyle = `hsl(${a},100%,50%)`;
      g.fill();
    }
    // hue marker
    const rad = hsv.h * Math.PI / 180;
    const mr = (r + inner) / 2;
    g.beginPath();
    g.arc(r + Math.cos(rad) * mr, r + Math.sin(rad) * mr, 6, 0, Math.PI * 2);
    g.strokeStyle = '#fff'; g.lineWidth = 2.5; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 1; g.stroke();
  }

  function paintSV() {
    const g = sv.getContext('2d');
    const size = sv.width;
    const base = g.createLinearGradient(0, 0, size, 0);
    base.addColorStop(0, '#fff');
    base.addColorStop(1, `hsl(${hsv.h},100%,50%)`);
    g.fillStyle = base; g.fillRect(0, 0, size, size);
    const dark = g.createLinearGradient(0, 0, 0, size);
    dark.addColorStop(0, 'rgba(0,0,0,0)');
    dark.addColorStop(1, '#000');
    g.fillStyle = dark; g.fillRect(0, 0, size, size);
    g.beginPath();
    g.arc(hsv.s * size, (1 - hsv.v) * size, 5, 0, Math.PI * 2);
    g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 1; g.stroke();
  }

  function syncColor(fromHex) {
    if (fromHex) hsv = hexToHsv(fromHex);
    const hex = rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
    editor.color = hex;
    hexInput.value = hex;
    document.getElementById('se-hex-chip').style.background = hex;
    paintWheel(); paintSV();
  }

  const wheelDrag = (e) => {
    const r = wheel.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2;
    const dy = e.clientY - r.top - r.height / 2;
    hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    syncColor();
  };
  let onWheel = false, onSV = false;
  wheel.addEventListener('mousedown', (e) => { onWheel = true; wheelDrag(e); });
  const svDrag = (e) => {
    const r = sv.getBoundingClientRect();
    hsv.s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    syncColor();
  };
  sv.addEventListener('mousedown', (e) => { onSV = true; svDrag(e); });
  window.addEventListener('mousemove', (e) => { if (onWheel) wheelDrag(e); else if (onSV) svDrag(e); });
  window.addEventListener('mouseup', () => { onWheel = false; onSV = false; });
  hexInput.addEventListener('change', () => {
    const v = hexInput.value.trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) syncColor(v); else hexInput.value = editor.color;
  });
  syncColor();
  window.setEditorColor = (hex) => syncColor(hex);

  const sw = document.getElementById('se-swatches');
  SE_PALETTE.forEach(hex => {
    const b = document.createElement('button');
    b.className = 'se-swatch';
    b.style.background = hex;
    b.title = hex;
    b.addEventListener('click', () => window.setEditorColor(hex));
    sw.appendChild(b);
  });

  window.addEventListener('keydown', (e) => {
    if (editor.el.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeEditor();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); document.getElementById('se-undo').click(); }
    const map = { b: 'pencil', e: 'eraser', i: 'picker', g: 'fill' };
    if (map[e.key.toLowerCase()]) {
      document.querySelector(`.se-tool[data-tool="${map[e.key.toLowerCase()]}"]`)?.click();
    }
  });

  function closeEditor() { editor.el.classList.add('hidden'); }
  document.getElementById('se-close').addEventListener('click', closeEditor);
  document.getElementById('se-cancel').addEventListener('click', closeEditor);
  document.getElementById('se-save').addEventListener('click', async () => {
    const name = document.getElementById('se-name').value.trim() || 'New skin';
    const model = document.querySelector('#model-toggle .model-btn.active')?.dataset.model || 'classic';
    await window.nebula.skinsSaveDataUrl({ dataUrl: editor.canvas.toDataURL('image/png'), name, model });
    closeEditor();
    selectedSkin = null;
    await refreshSkins();
    showToast('Saved to library', `"${name}" is ready to apply.`, 'success');
  });
  window.addEventListener('resize', () => { if (!editor.el.classList.contains('hidden')) drawEditorGrid(); });
})();

document.getElementById('skin-new-btn').addEventListener('click', () => openSkinEditor(null));
document.getElementById('skin-edit-btn').addEventListener('click', () => {
  if (selectedSkin) openSkinEditor(selectedSkin);
});


// A small text prompt in the app's own styling. window.prompt is blocked
// in Electron renderers, and showConfirm only answers yes/no.
function showPrompt(title, placeholder = '', initial = '', { allowEmpty = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sync-modal';
    wrap.innerHTML = `
      <div class="sync-card glass" style="width:min(420px,92vw);">
        <div class="sync-title">${escapeHtml(title)}</div>
        <div class="cf-key-row" style="margin-top:14px;">
          <input id="prompt-input" placeholder="${escapeHtml(placeholder)}" spellcheck="false">
        </div>
        <div class="sync-actions" style="margin-top:16px;">
          <button class="pill-btn" data-act="cancel">Cancel</button>
          <button class="pill-btn primary" data-act="ok">OK</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#prompt-input');
    input.value = initial;
    input.focus();
    const done = (v) => { wrap.remove(); resolve(v); };
    const value = () => (allowEmpty ? input.value.trim() : input.value.trim() || null);
    wrap.querySelector('[data-act="ok"]').addEventListener('click', () => done(value()));
    wrap.querySelector('[data-act="cancel"]').addEventListener('click', () => done(null));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(value());
      if (e.key === 'Escape') done(null);
    });
  });
}

// =====================================================================
// FRIENDS UI
// =====================================================================
let friendsState = null;
let frTab = 'friends';
let frConversation = null;   // { kind: 'dm'|'group', id }
let frReplyTo = null;        // { id, name, text }
let frEditing = null;        // { id, text }
let frRendered = { key: null, sig: null, ids: new Set() };
const FR_DOTS_SVG = '<svg viewBox="0 0 16 4" width="14" height="4" aria-hidden="true"><circle cx="2" cy="2" r="1.6"/><circle cx="8" cy="2" r="1.6"/><circle cx="14" cy="2" r="1.6"/></svg>';
const FR_ICONS = {
  call: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.12.37 2.33.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  server: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 10h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zm3-7a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm0 10a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm4-10v2h7V6zm0 10v2h7v-2z"/></svg>',
  members: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm7.5 0a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM9 13c-3.3 0-7 1.6-7 4.5V20h14v-2.5C16 14.6 12.3 13 9 13zm7.5 0c-.5 0-1 .03-1.5.1 1.3.95 2 2.25 2 3.9V20h5v-2.3c0-2.6-3-4.7-5.5-4.7z"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm3 5v2h10V9zm0 4v2h7v-2z"/></svg>',
};
const FR_EMOJI = ['😀', '😂', '🤣', '😊', '😍', '😎', '🤔', '😅', '😭', '😡', '👍', '👎', '👏', '🙏', '🔥', '💯',
  '❤️', '💜', '✨', '🎉', '👀', '💀', '🤝', '⛏️', '🗡️', '🛡️', '💎', '🧱', '🌙', '⭐', '☄️', '🚀'];

function frStatusLabel(p) {
  if (p.status === 'in_game') {
    return p.activity?.instanceName ? `In game · ${p.activity.instanceName}` : 'In game';
  }
  return p.status === 'online' ? 'Online' : 'Offline';
}

// Player faces. mc-heads.net is blocked on some networks and sometimes
// hands back Steve, which is why some people saw skins and others didn't.
// So every face is also cut out of the player's real skin from Mojang
// (fetched by the main process) and cached here; mc-heads is only what
// shows for the split second before that's ready.
// `var` + lazy setup: frAvatar can be called before this part of the file runs.
var FACE_STORE_KEY = 'solar.faces.v1';
var FACE_TTL_MS = 12 * 60 * 60 * 1000;
var faceState = null;
var FACE_PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#2b2540"/><rect x="1" y="3" width="2" height="1" fill="#4a4266"/><rect x="5" y="3" width="2" height="1" fill="#4a4266"/></svg>');
function cleanFaceId(uuid) { return String(uuid || '').replace(/-/g, '').toLowerCase(); }

function faces() {
  if (faceState) return faceState;
  faceState = {
    cache: new Map(),   // uuid -> data URL
    tried: new Map(),   // uuid -> when we last asked Mojang
    failed: new Set(),  // Mojang had no skin for these
    queue: [],
    busy: 0,
    saveTimer: null,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(FACE_STORE_KEY) || '{}');
    const now = Date.now();
    for (const [id, v] of Object.entries(saved)) {
      if (v && v.d && now - v.at < FACE_TTL_MS) faceState.cache.set(id, v.d);
    }
  } catch { /* corrupt cache: start fresh */ }
  return faceState;
}

function saveFaces() {
  const F = faces();
  clearTimeout(F.saveTimer);
  F.saveTimer = setTimeout(() => {
    try {
      const prev = JSON.parse(localStorage.getItem(FACE_STORE_KEY) || '{}');
      const now = Date.now();
      const out = {};
      for (const [id, v] of Object.entries(prev)) if (v && now - v.at < FACE_TTL_MS) out[id] = v;
      for (const [id, d] of F.cache) if (!out[id]) out[id] = { d, at: now };
      const keys = Object.keys(out);
      for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete out[k];
      localStorage.setItem(FACE_STORE_KEY, JSON.stringify(out));
    } catch { /* storage full: the in-memory cache still works */ }
  }, 800);
}

/** Head + hat layer from a 64x64 (or old 64x32) skin, as a 32px data URL. */
function cutFace(skinDataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const k = img.width / 64;
      ctx.drawImage(img, 8 * k, 8 * k, 8 * k, 8 * k, 0, 0, 32, 32);
      // Old 64x32 skins often fill the hat layer with solid colour, which
      // Minecraft ignores. Only draw a hat that has see-through pixels, or a
      // fully covering one on a modern skin that isn't one flat colour.
      const probe = document.createElement('canvas');
      probe.width = 8; probe.height = 8;
      const pctx = probe.getContext('2d');
      pctx.drawImage(img, 40 * k, 8 * k, 8 * k, 8 * k, 0, 0, 8, 8);
      const hat = pctx.getImageData(0, 0, 8, 8).data;
      let seeThrough = false; let flat = true;
      for (let i = 0; i < hat.length; i += 4) {
        if (hat[i + 3] < 255) seeThrough = true;
        if (hat[i] !== hat[0] || hat[i + 1] !== hat[1] || hat[i + 2] !== hat[2]) flat = false;
      }
      const legacy = img.height * 2 === img.width;
      if (seeThrough || (!legacy && !flat)) ctx.drawImage(img, 40 * k, 8 * k, 8 * k, 8 * k, 0, 0, 32, 32);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('bad skin image'));
    img.src = skinDataUrl;
  });
}

function applyFace(id, src) {
  for (const img of document.querySelectorAll('img')) {
    const s = img.getAttribute('src') || '';
    if (img.dataset.faceFor === id || (s.includes(id) && /mc-heads\.net|crafatar\.com/.test(s))) {
      img.dataset.faceFor = id;
      img.style.visibility = '';
      img.src = src;
    }
  }
}

function backupFace(id) { return `https://crafatar.com/avatars/${id}?size=32&overlay`; }

function pumpFaces() {
  const F = faces();
  while (F.busy < 3 && F.queue.length) {
    const id = F.queue.shift();
    F.busy++;
    window.nebula.skinTextureFor(id)
      .then(async (tex) => {
        if (!tex?.dataUrl) throw new Error('default skin');
        const face = await cutFace(tex.dataUrl);
        F.cache.set(id, face);
        saveFaces();
        applyFace(id, face);
      })
      .catch(() => {
        // Mojang didn't give us a skin. Any face that already failed to load
        // gets one more try from a second face service.
        F.failed.add(id);
        for (const img of document.querySelectorAll(`img[data-face-for="${id}"]`)) {
          if ((img.getAttribute('src') || '').startsWith('data:image/svg')) img.src = backupFace(id);
        }
      })
      .finally(() => { F.busy--; pumpFaces(); });
  }
}

function queueFace(id) {
  const F = faces();
  if (F.cache.has(id) || F.queue.includes(id)) return;
  const last = F.tried.get(id) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  F.tried.set(id, Date.now());
  F.failed.delete(id);
  F.queue.push(id);
  pumpFaces();
}

function frAvatar(uuid) {
  const id = cleanFaceId(uuid);
  if (!/^[0-9a-f]{32}$/.test(id)) return `https://mc-heads.net/avatar/${uuid}/32`;
  const hit = faces().cache.get(id);
  if (hit) return hit;
  queueFace(id);
  return `https://mc-heads.net/avatar/${id}/32`;
}

// If mc-heads can't be reached, swap in a neutral face while the Mojang
// copy loads instead of letting the image vanish. Runs before the image's
// own onerror, which only fires if every source has failed.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const s = img.getAttribute('src') || '';
  const m = s.match(/mc-heads\.net\/(?:avatar|head)\/([0-9a-f-]{32,36})/i);
  if (!m) return;
  const id = cleanFaceId(m[1]);
  const F = faces();
  e.stopPropagation();
  img.dataset.faceFor = id;
  img.src = F.cache.get(id) || (F.failed.has(id) ? backupFace(id) : FACE_PLACEHOLDER);
  queueFace(id);
}, true);

// A group icon is either a custom uploaded image (stored inline as a data:
// URL) or a friend's UUID whose face stands in for it. This returns the
// right <img src> for whichever it is.
function groupIconSrc(icon) {
  if (!icon) return null;
  return String(icon).startsWith('data:') ? icon : frAvatar(icon);
}

/**
 * Turn a chosen image File into a small square data: URL suitable for a
 * group icon — downscaled to 64px and JPEG-compressed so it stays a few KB
 * and fits inside one backend message.
 */
function imageFileToIcon(file, size = 64, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('Pick an image file.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be loaded.'));
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        // Cover-crop to a centred square so non-square images aren't squashed.
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function renderFriendsView() {
  const s = friendsState;
  if (!s) return;

  document.getElementById('fr-c-friends').textContent = s.counts.friends;
  document.getElementById('fr-c-following').textContent = s.counts.following;
  document.getElementById('fr-c-followers').textContent = s.counts.followers;

  const statusEl = document.getElementById('fr-status');
  const textEl = document.getElementById('fr-status-text');
  statusEl.className = `fr-status ${s.mode}`;
  textEl.textContent = s.mode === 'online' ? 'Connected'
    : s.mode === 'reconnecting' ? 'Reconnecting…'
    : 'Offline mode — set a server in Settings';

  const badge = document.getElementById('friends-nav-badge');
  const total = s.counts.unread + s.invites.length;
  badge.textContent = total > 99 ? '99+' : String(total);
  badge.classList.toggle('hidden', total === 0);

  // ---- people list ----
  const list = document.getElementById('fr-list');
  const query = (document.getElementById('fr-search')?.value || '').trim().toLowerCase();
  const all = frTab === 'friends' ? s.friends
    : frTab === 'following' ? s.following
    : frTab === 'followers' ? s.followers
    : s.blocked;
  const lastAt = (p) => frLastMessage('dm', p.uuid)?.at || 0;
  const people = all
    .filter(p => !query || String(p.name || '').toLowerCase().includes(query))
    .sort((a, b) => frIsOn(b) - frIsOn(a) || (b.unread || 0) - (a.unread || 0)
      || lastAt(b) - lastAt(a) || String(a.name).localeCompare(String(b.name)));
  list.innerHTML = '';
  if (!people.length) {
    list.innerHTML = `<p class="dim fr-empty">${
      query ? `Nobody here matches \u201c${escapeHtml(query)}\u201d. Press Follow to add them by username.`
      : frTab === 'friends' ? 'Nobody yet. Follow someone, and once they follow back they show up here.'
      : frTab === 'blocked' ? 'Nobody blocked.'
      : frTab === 'following' ? "You aren't following anyone yet."
      : 'No followers yet.'}</p>`;
  }
  let section = null;
  for (const p of people) {
    const on = frTab !== 'blocked' && frIsOn(p);
    const sec = frTab === 'blocked' ? 'Blocked' : on ? 'Online' : 'Offline';
    if (sec !== section) {
      section = sec;
      const n = people.filter(x => (frTab === 'blocked' ? 'Blocked' : frIsOn(x) ? 'Online' : 'Offline') === sec).length;
      const h = document.createElement('div');
      h.className = `fr-sec${sec === 'Online' ? ' on' : sec === 'Blocked' ? ' blocked' : ''}`;
      h.innerHTML = `<span>${sec}</span><b>${n}</b>`;
      list.appendChild(h);
    }
    const last = frLastMessage('dm', p.uuid);
    const st = p.status || 'offline';
    const sub = st === 'in_game' || !last ? frStatusLabel(p) : frPreview(last, 'dm');
    const row = document.createElement('div');
    row.className = `fr-person ${st}` + (frConversation?.id === p.uuid ? ' active' : '')
      + (p.unread ? ' has-unread' : '') + (p.blocked ? ' is-blocked' : '');
    row.innerHTML = `
      <div class="fr-face-wrap" ${personAttr(p.uuid, p.name)} title="View profile">
        <img class="fr-face" src="${frAvatar(p.uuid)}" alt="">
        <span class="fr-presence ${st}"></span>
      </div>
      <div class="fr-person-text">
        <div class="fr-name"><span class="fr-name-txt">${escapeHtml(p.name)}</span>${reportFlag(p.uuid, p.name)}</div>
        <div class="fr-sub ${st === 'in_game' ? 'playing' : ''}">${escapeHtml(sub)}</div>
      </div>
      <div class="fr-side">
        ${last ? `<span class="fr-when">${frAgo(last.at)}</span>` : ''}
        ${p.unread ? `<span class="fr-unread">${p.unread > 99 ? '99+' : p.unread}</span>` : ''}
      </div>
      <button class="fr-more" title="Options" aria-label="Options">${FR_DOTS_SVG}</button>
    `;
    row.querySelector('.fr-face').onerror = (e) => { e.target.style.visibility = 'hidden'; };
    row.addEventListener('click', (e) => {
      if (e.target.closest('.fr-more, .rflag')) return;
      if (p.blocked) return;
      openConversation({ kind: 'dm', id: p.uuid, name: p.name });
    });
    row.querySelector('.fr-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showPersonMenu(p, e.currentTarget);
    });
    list.appendChild(row);
  }

  // ---- groups ----
  const groups = document.getElementById('fr-groups');
  groups.innerHTML = '';
  const shownGroups = s.groups
    .filter(g => !query || String(g.name || '').toLowerCase().includes(query))
    .sort((a, b) => (frLastMessage('group', b.id)?.at || 0) - (frLastMessage('group', a.id)?.at || 0));
  if (!shownGroups.length) {
    groups.innerHTML = `<p class="dim fr-empty">${query ? 'No group chats match.' : 'No group chats yet.'}</p>`;
  }
  for (const g of shownGroups) {
    const last = frLastMessage('group', g.id);
    const row = document.createElement('div');
    row.className = 'fr-person fr-group' + (frConversation?.id === g.id ? ' active' : '') + (g.unread ? ' has-unread' : '');
    row.innerHTML = `
      <div class="fr-group-icon">${g.icon
        ? `<img src="${groupIconSrc(g.icon)}" alt="">`
        : escapeHtml(g.name.slice(0, 2).toUpperCase())}</div>
      <div class="fr-person-text">
        <div class="fr-name"><span class="fr-name-txt">${escapeHtml(g.name)}</span></div>
        <div class="fr-sub">${last ? escapeHtml(frPreview(last, 'group'))
          : `${g.members.length} member${g.members.length === 1 ? '' : 's'}${g.isOwner ? ' · you own this' : ''}`}</div>
      </div>
      <div class="fr-side">
        ${last ? `<span class="fr-when">${frAgo(last.at)}</span>` : ''}
        ${g.unread ? `<span class="fr-unread">${g.unread > 99 ? '99+' : g.unread}</span>` : ''}
      </div>
    `;
    row.addEventListener('click', () => openConversation({ kind: 'group', id: g.id, name: g.name }));
    groups.appendChild(row);
  }

  renderConversation();
  renderInvites();
  frTabInk();
}

function frIsOn(p) { return p?.status === 'online' || p?.status === 'in_game' ? 1 : 0; }

function frLastMessage(kind, id) {
  const s = friendsState;
  const msgs = kind === 'dm' ? (s?.dms?.[id] || []) : (s?.groups?.find(g => g.id === id)?.messages || []);
  return msgs[msgs.length - 1] || null;
}

function frPreview(m, kind) {
  const s = friendsState;
  const mine = m.mine || m.from === s?.self?.id;
  const body = m.invite
    ? (m.invite.kind === 'world' ? 'Sent a world invite' : 'Sent a server invite')
    : String(m.text || '').replace(/\s+/g, ' ');
  const who = mine ? 'You' : kind === 'group' ? (m.name || s?.people?.[m.from]?.name || '') : '';
  return who ? `${who}: ${body}` : body;
}

function frAgo(at) {
  const d = Date.now() - (at || 0);
  if (d < 60e3) return 'now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
  if (d < 6 * 86400e3) return new Date(at).toLocaleDateString([], { weekday: 'short' });
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function frDayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function frDayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400e3);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function frTabInk() {
  const tabs = document.getElementById('fr-tabs');
  if (!tabs || !tabs.offsetWidth) return;
  let ink = tabs.querySelector('.fr-tab-ink');
  if (!ink) {
    ink = document.createElement('span');
    ink.className = 'fr-tab-ink';
    tabs.prepend(ink);
  }
  const t = tabs.querySelector('.fr-tab.active');
  if (!t) return;
  ink.style.transform = `translateX(${t.offsetLeft}px)`;
  ink.style.width = `${t.offsetWidth}px`;
}

function renderConversation() {
  const s = friendsState;
  const head = document.getElementById('fr-chat-title');
  const actions = document.getElementById('fr-chat-actions');
  const box = document.getElementById('fr-messages');
  const input = document.getElementById('fr-input');
  const send = document.getElementById('fr-send');

  const main = box.closest('.fr-main');
  const emoji = document.getElementById('fr-emoji');

  if (!frConversation) {
    main?.classList.add('fr-idle');
    head.innerHTML = ''; delete head.dataset.html;
    actions.innerHTML = ''; delete actions.dataset.html;
    input.placeholder = 'Message';
    input.disabled = true; send.disabled = true;
    if (emoji) emoji.disabled = true;
    frRenderIdle(box);
    frRendered = { key: null, sig: null, ids: new Set() };
    document.getElementById('fr-jump')?.classList.add('hidden');
    return;
  }
  main?.classList.remove('fr-idle');
  input.disabled = false; send.disabled = false;
  if (emoji) emoji.disabled = false;

  const key = `${frConversation.kind}:${frConversation.id}`;
  let messages = [];
  let headHtml = '';
  let actionsHtml = '';
  if (frConversation.kind === 'dm') {
    const person = [...s.friends, ...s.following, ...s.followers].find(p => p.uuid === frConversation.id);
    const headName = person?.name || frConversation.name;
    const st = person?.status || 'offline';
    headHtml = `
      <div class="fr-face-wrap fr-head-avatar" ${personAttr(frConversation.id, headName)} title="View profile">
        <img class="fr-face" src="${frAvatar(frConversation.id)}" alt="">
        <span class="fr-presence ${st}"></span>
      </div>
      <div class="fr-head-text">
        <div class="fr-head-line"><span class="fr-head-name" ${personAttr(frConversation.id, headName)}>${escapeHtml(headName)}</span>${reportFlag(frConversation.id, headName)}</div>
        <div class="fr-head-status ${st}">${escapeHtml(person ? frStatusLabel(person) : 'Not following')}</div>
      </div>`;
    input.placeholder = `Message ${headName}`;
    messages = s.dms[frConversation.id] || [];
    const canCall = (s.friends || []).some(p => p.uuid === frConversation.id);
    actionsHtml = `
      ${canCall ? `<button class="fr-hbtn call" data-act="call" title="Voice call" aria-label="Voice call">${FR_ICONS.call}</button>` : ''}
      <button class="fr-hbtn" data-act="invite-server" title="Invite to a server" aria-label="Invite to a server">${FR_ICONS.server}</button>
      <button class="fr-hbtn" data-act="more" title="More" aria-label="More">${FR_DOTS_SVG}</button>`;
  } else {
    const g = s.groups.find(x => x.id === frConversation.id);
    const name = g?.name || frConversation.name;
    const online = (g?.members || []).filter(m => frIsOn([...s.friends, ...s.following].find(p => p.uuid === m.uuid))).length;
    headHtml = `
      <div class="fr-group-icon fr-head-avatar">${g?.icon
        ? `<img src="${groupIconSrc(g.icon)}" alt="">`
        : escapeHtml(String(name).slice(0, 2).toUpperCase())}</div>
      <div class="fr-head-text">
        <div class="fr-head-line"><span class="fr-head-name">${escapeHtml(name)}</span></div>
        <div class="fr-head-status group">${g ? `${g.members.length} member${g.members.length === 1 ? '' : 's'}${online ? ` · ${online} online` : ''}${g.isOwner ? ' · you own this' : ''}` : ''}</div>
      </div>`;
    input.placeholder = `Message ${name}`;
    messages = g?.messages || [];
    actionsHtml = `
      ${g?.isOwner ? `<button class="fr-hbtn" data-act="invite-server" title="Invite group to a server" aria-label="Invite group to a server">${FR_ICONS.server}</button>` : ''}
      <button class="fr-hbtn" data-act="members" title="Members" aria-label="Members">${FR_ICONS.members}</button>
      <button class="fr-hbtn" data-act="more" title="More" aria-label="More">${FR_DOTS_SVG}</button>`;
  }
  if (head.dataset.html !== headHtml) {
    head.dataset.html = headHtml;
    head.innerHTML = headHtml;
    head.querySelectorAll('img').forEach(i => { i.onerror = () => { i.style.visibility = 'hidden'; }; });
  }
  if (actions.dataset.html !== actionsHtml) {
    actions.dataset.html = actionsHtml;
    actions.innerHTML = actionsHtml;
    actions.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (b.dataset.act === 'more') showChatMenu(b);
        else handleChatAction(b.dataset.act);
      });
    });
  }
  const ownsGroup = frConversation.kind === 'group' && !!s.groups.find(x => x.id === frConversation.id)?.isOwner;

  // Presence and unread counts change far more often than the messages do;
  // rebuilding the thread on every one of those resets hover and scroll.
  const sig = `${key}|${s.self?.id}|${frEditing?.id || ''}|${ownsGroup}|`
    + messages.map(m => `${m.id}:${m.edited ? 1 : 0}:${m.text || ''}`).join('\u0001');
  if (frRendered.sig === sig) { renderReplyBar(); return; }
  const switched = frRendered.key !== key;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const prevTop = box.scrollTop;
  const seen = switched ? null : frRendered.ids;

  box.innerHTML = '';
  if (!messages.length) {
    const who = frConversation.kind === 'dm' ? escapeHtml(frConversation.name || 'them') : 'the group';
    box.innerHTML = `<div class="fr-thread-empty">
      <div class="fr-te-icon">👋</div>
      <div class="fr-te-title">Say hi to ${who}</div>
      <div class="fr-te-sub">This is the start of your conversation.</div>
    </div>`;
  }
  let prev = null;
  let mineFresh = false;
  for (const m of messages) {
    const mine = m.mine || m.from === s.self?.id;
    // Everyone is shown by their in-game name and face, including you.
    // Saying "You" made your own messages read differently from everyone
    // else's and hid which account had actually sent them.
    const senderUuid = mine ? s.self?.id : m.from;
    const senderName = mine
      ? (s.self?.name || 'You')
      : (m.name || s.people?.[m.from]?.name || frConversation.name);

    if (!prev || frDayKey(prev.m.at) !== frDayKey(m.at)) {
      const sep = document.createElement('div');
      sep.className = 'fr-day';
      sep.innerHTML = `<span>${escapeHtml(frDayLabel(m.at))}</span>`;
      box.appendChild(sep);
      prev = null;
    }
    const cont = !!prev && prev.sender === senderUuid && !prev.m.invite && !m.reply
      && (m.at - prev.m.at) < 5 * 60 * 1000;
    prev = { m, sender: senderUuid };

    const editing = frEditing?.id === m.id;
    const fresh = seen && !seen.has(m.id);
    if (fresh && mine) mineFresh = true;
    const time = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el = document.createElement('div');
    el.className = `fr-msg-row ${mine ? 'mine' : ''}${cont ? ' cont' : ''}${fresh ? ' fr-new' : ''}`;
    el.dataset.id = m.id;
    const where = frConversation.kind === 'dm' ? 'Direct message' : `Group: ${s.groups.find(x => x.id === frConversation.id)?.name || 'group chat'}`;
    el.innerHTML = `
      <img class="fr-msg-face" src="${frAvatar(senderUuid)}" alt="" ${personAttr(senderUuid, senderName)}>
      <div class="fr-msg-col">
        ${cont ? '' : `<div class="fr-msg-meta">
          <span class="fr-msg-who" ${personAttr(senderUuid, senderName)}>${escapeHtml(senderName)}</span>
          ${mine ? '' : reportFlag(senderUuid, senderName, { where, text: m.text, at: m.at })}
          <span class="fr-msg-time">${time}</span>
          ${m.edited ? '<span class="fr-msg-edited">edited</span>' : ''}
        </div>`}
        ${m.reply ? `<div class="fr-msg-quote"><b>${escapeHtml(m.reply.name || 'Message')}</b> ${escapeHtml(m.reply.text || '')}</div>` : ''}
        ${editing
          ? `<div class="fr-msg-editwrap"><input class="fr-msg-edit" maxlength="500"><span class="fr-msg-edit-hint">Enter to save · Esc to cancel</span></div>`
          : `<div class="fr-msg ${mine ? 'mine' : ''}" title="${escapeHtml(new Date(m.at).toLocaleString())}">${linkifyText(m.text)}${cont && m.edited ? ' <span class="fr-msg-edited">(edited)</span>' : ''}</div>`}
      </div>
      ${cont ? `<span class="fr-msg-hover-time">${time}</span>` : ''}
      <button class="fr-msg-more" title="More" aria-label="Message options">${FR_DOTS_SVG}</button>`;
    el.querySelector('.fr-msg-face').onerror = (e) => { e.target.style.visibility = 'hidden'; };
    el.querySelector('.fr-msg-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showMessageMenu(m, { mine, ownsGroup, senderName }, e.currentTarget);
    });
    if (editing) {
      const inp = el.querySelector('.fr-msg-edit');
      inp.value = frEditing.text;
      inp.addEventListener('input', () => { frEditing.text = inp.value; });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { frEditing = null; renderConversation(); }
        if (e.key === 'Enter') saveMessageEdit(m.id, inp.value);
      });
      requestAnimationFrame(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); });
    }

    if (m.invite) el.querySelector('.fr-msg-col').appendChild(buildInviteCard(m.invite, mine));
    box.appendChild(el);
  }

  const freshCount = seen ? messages.filter(m => !seen.has(m.id)).length : 0;
  frRendered = { key, sig, ids: new Set(messages.map(m => m.id)) };
  const jump = document.getElementById('fr-jump');
  if (switched) {
    box.classList.remove('fr-swap');
    void box.offsetWidth;
    box.classList.add('fr-swap');
    box.scrollTop = box.scrollHeight;
    jump?.classList.add('hidden');
  } else if (frEditing) {
    box.scrollTop = prevTop;
  } else if (nearBottom || mineFresh) {
    box.scrollTop = box.scrollHeight;
    jump?.classList.add('hidden');
  } else {
    box.scrollTop = prevTop;
    if (freshCount) jump?.classList.remove('hidden');
  }
  renderReplyBar();
}

/** No conversation open: offer the people you'd most likely talk to. */
function frRenderIdle(box) {
  const s = friendsState;
  const picks = [...(s.friends || [])]
    .filter(p => !p.blocked)
    .sort((a, b) => frIsOn(b) - frIsOn(a)
      || (frLastMessage('dm', b.uuid)?.at || 0) - (frLastMessage('dm', a.uuid)?.at || 0))
    .slice(0, 6);
  const sig = 'idle|' + picks.map(p => `${p.uuid}:${p.status}`).join(',');
  if (box.dataset.idle === sig && box.querySelector('.fr-idle-hero')) return;
  box.dataset.idle = sig;
  box.innerHTML = `
    <div class="fr-idle-hero">
      <div class="fr-idle-orb">${FR_ICONS.chat}</div>
      <div class="fr-idle-title">Your messages</div>
      <div class="fr-idle-sub">${picks.length
        ? 'Pick someone on the left, or jump straight into a chat.'
        : 'Follow someone. Once they follow you back, you can chat here.'}</div>
      ${picks.length ? `<div class="fr-idle-picks">${picks.map(p => `
        <button class="fr-idle-pick ${p.status || 'offline'}" data-uuid="${escapeHtml(p.uuid)}" title="Message ${escapeHtml(p.name)}">
          <span class="fr-face-wrap"><img class="fr-face" src="${frAvatar(p.uuid)}" alt=""><span class="fr-presence ${p.status || 'offline'}"></span></span>
          <span class="fr-idle-name">${escapeHtml(p.name)}</span>
          <span class="fr-idle-st">${escapeHtml(frStatusLabel(p))}</span>
        </button>`).join('')}</div>` : ''}
      <div class="fr-idle-actions">
        <button class="pill-btn" data-idle="find">Find people</button>
        ${(s.friends || []).length ? '<button class="pill-btn primary" data-idle="group">New group chat</button>' : ''}
      </div>
    </div>`;
  box.querySelectorAll('.fr-idle-pick').forEach(b => b.addEventListener('click', () => {
    const p = picks.find(x => x.uuid === b.dataset.uuid);
    if (p) openConversation({ kind: 'dm', id: p.uuid, name: p.name });
  }));
  box.querySelectorAll('.fr-idle-pick img').forEach(i => { i.onerror = () => { i.style.visibility = 'hidden'; }; });
  box.querySelector('[data-idle="find"]')?.addEventListener('click', () => document.getElementById('fr-search')?.focus());
  box.querySelector('[data-idle="group"]')?.addEventListener('click', () => openGroupPicker());
}

function showChatMenu(anchor) {
  document.querySelector('.fr-menu')?.remove();
  const s = friendsState;
  const conv = frConversation;
  if (!conv) return;
  const g = conv.kind === 'group' ? s.groups.find(x => x.id === conv.id) : null;
  const items = conv.kind === 'dm'
    ? [['View profile', 'profile', 'beta-only'], ['Clear chat', 'clear', '']]
    : [['Members', 'members', ''], ['Clear chat', 'clear', ''], [g?.isOwner ? 'Delete group' : 'Leave group', 'leave', 'danger']];
  const menu = document.createElement('div');
  menu.className = 'fr-menu';
  menu.innerHTML = items.map(([label, act, cls]) => `<button data-act="${act}" class="${cls}">${label}</button>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  menu.style.top = `${r.bottom + 6}px`;
  menu.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    menu.remove();
    if (b.dataset.act === 'profile') openProfile({ uuid: conv.id, name: conv.name });
    else handleChatAction(b.dataset.act);
  }));
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function showEmojiPicker(anchor) {
  const open = document.querySelector('.fr-emoji-pop');
  if (open) { open.remove(); return; }
  const pop = document.createElement('div');
  pop.className = 'fr-emoji-pop';
  pop.innerHTML = FR_EMOJI.map(e => `<button type="button">${e}</button>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.left)}px`;
  pop.style.top = `${r.top - pop.offsetHeight - 8}px`;
  const input = document.getElementById('fr-input');
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    e.stopPropagation();
    const at = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? at;
    const next = input.value.slice(0, at) + b.textContent + input.value.slice(end);
    if (next.length > 500) return;
    input.value = next;
    input.focus();
    input.setSelectionRange(at + b.textContent.length, at + b.textContent.length);
    input.dispatchEvent(new Event('input'));
  });
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (pop.contains(e.target)) { document.addEventListener('click', off, { once: true }); return; }
    pop.remove();
  }, { once: true }), 0);
}

function renderReplyBar() {
  const bar = document.getElementById('fr-reply-bar');
  if (!bar) return;
  if (!frReplyTo || !frConversation) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="fr-reply-label">Replying to <b>${escapeHtml(frReplyTo.name)}</b></span>
    <span class="fr-reply-text">${escapeHtml(frReplyTo.text)}</span>
    <button class="fr-reply-x" title="Cancel reply" aria-label="Cancel reply">&times;</button>`;
  bar.querySelector('.fr-reply-x').addEventListener('click', () => { frReplyTo = null; renderReplyBar(); });
}

async function saveMessageEdit(id, text) {
  const conv = frConversation;
  frEditing = null;
  try {
    await window.nebula.friendsEditMessage({ kind: conv.kind, conversationId: conv.id, id, text });
  } catch (err) { showToast("Couldn't edit", err.message, 'error'); }
  renderConversation();
}

function showMessageMenu(m, { mine, ownsGroup, senderName }, anchor) {
  document.querySelector('.fr-menu')?.remove();
  const conv = frConversation;
  const items = [['Reply', 'reply']];
  if (m.text) items.push(['Copy text', 'copy']);
  if (mine && !m.invite) items.push(['Edit', 'edit']);
  if (mine || ownsGroup) items.push(['Delete for everyone', 'delete-all']);
  items.push(['Delete for me', 'delete-me']);
  const sender = !mine ? (m.from || (conv?.kind === 'dm' ? conv.id : null)) : null;
  if (sender) items.push(['Report', 'report']);

  const menu = document.createElement('div');
  menu.className = 'fr-menu';
  menu.innerHTML = items.map(([label, act]) =>
    `<button data-act="${act}" class="${act.startsWith('delete') || act === 'report' ? 'danger' : ''} ${act === 'report' ? 'beta-only' : ''}">${label}</button>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 180, r.left)}px`;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;

  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', async () => {
      menu.remove();
      const act = b.dataset.act;
      try {
        if (act === 'report') {
          openReport({
            uuid: sender, name: senderName,
            context: { where: conv?.kind === 'dm' ? 'Direct message' : `Group "${conv?.name || 'chat'}"`, text: m.text || '', at: m.at },
          });
        } else if (act === 'reply') {
          frReplyTo = { id: m.id, name: senderName, text: String(m.text || '').slice(0, 120) };
          renderReplyBar();
          document.getElementById('fr-input').focus();
        } else if (act === 'copy') {
          await navigator.clipboard.writeText(m.text || '');
          showToast('Copied', 'Message copied to clipboard.', 'success');
        } else if (act === 'edit') {
          frEditing = { id: m.id, text: m.text || '' };
          renderConversation();
        } else if (act === 'delete-all' || act === 'delete-me') {
          const all = act === 'delete-all';
          const ok = await showConfirm(
            all ? 'Delete this message for everyone in the chat? This can\'t be undone.'
                : 'Delete this message? It only disappears for you.',
            { title: 'Delete message?', confirmLabel: 'Delete' });
          if (!ok) return;
          if (frReplyTo?.id === m.id) frReplyTo = null;
          await window.nebula.friendsDeleteMessage({ kind: conv.kind, conversationId: conv.id, id: m.id, forEveryone: all });
        }
      } catch (err) { showToast('Failed', err.message, 'error'); }
    });
  });
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

/**
 * The invite itself, rendered inside the conversation with a Join button.
 * For a server it also pings for the MOTD and player count, because an
 * address on its own tells you nothing about whether it's worth joining.
 */
function buildInviteCard(invite, mine) {
  const card = document.createElement('div');
  card.className = `fr-invite-card ${invite.kind}`;
  const title = invite.kind === 'world'
    ? escapeHtml(invite.worldName || 'their world')
    : escapeHtml(invite.address || '');
  card.innerHTML = `
    <div class="fr-ic-icon">${invite.kind === 'world' ? '🌍' : '🖧'}</div>
    <div class="fr-ic-text">
      <div class="fr-ic-title">${title}</div>
      <div class="fr-ic-sub" data-role="sub">${invite.kind === 'world'
        ? `${escapeHtml(invite.hostName || 'Host')}'s world${invite.versionNumber ? ` · ${escapeHtml(invite.versionNumber)}` : ''}`
        : 'Checking server…'}</div>
    </div>
    ${mine ? '<span class="fr-ic-sent">Sent</span>' : '<button class="pill-btn primary fr-ic-join">Join</button>'}`;

  if (!mine) {
    card.querySelector('.fr-ic-join').addEventListener('click', () => joinInvite(invite));
  }

  if (invite.kind === 'server' && invite.address) {
    const sub = card.querySelector('[data-role="sub"]');
    window.nebula.serverPing({ address: invite.address }).then(r => {
      if (r.offline) { sub.textContent = r.reason || 'Server appears offline'; sub.classList.add('offline'); return; }
      const bits = [];
      if (r.motd) bits.push(r.motd);
      if (r.online != null) bits.push(`${r.online}/${r.max} online`);
      if (r.version) bits.push(r.version);
      sub.textContent = bits.join(' · ') || 'Online';
      if (r.favicon) {
        const ic = card.querySelector('.fr-ic-icon');
        ic.innerHTML = `<img src="${r.favicon}" alt="">`;
        ic.classList.add('has-favicon');
      }
    }).catch(() => { sub.textContent = 'Could not reach that server'; sub.classList.add('offline'); });
  }
  return card;
}

// The invite strip is a nudge, not a permanent list: an invite shows for a
// few minutes, or disappears the moment you actually look at its chat —
// whichever comes first. After that it still lives in the conversation, you
// just aren't nagged by the banner. "Seen" ids persist so they don't come
// back on reload.
const INVITE_STRIP_MS = 3 * 60 * 1000;
let seenInvites = new Set(JSON.parse(localStorage.getItem('seenInvites') || '[]'));
function markInviteSeen(id) {
  if (!id || seenInvites.has(id)) return;
  seenInvites.add(id);
  try { localStorage.setItem('seenInvites', JSON.stringify([...seenInvites].slice(-300))); } catch { /* full */ }
}

// A compact strip of recent invites, so you don't have to open a
// conversation to act on one.
function renderInvites() {
  const wrap = document.getElementById('fr-invites');
  const s = friendsState;
  wrap.innerHTML = '';
  const now = Date.now();
  const fresh = (s.invites || []).filter(inv =>
    !seenInvites.has(inv.id) && (now - (inv.at || 0) < INVITE_STRIP_MS));
  for (const inv of fresh) {
    const card = document.createElement('div');
    card.className = 'fr-invite glass liquid-glass';
    card.innerHTML = `
      <img class="fr-face" src="${frAvatar(inv.hostUuid)}" alt="">
      <div class="fr-invite-text">
        <div class="fr-name">${escapeHtml(inv.hostName || 'Someone')} invited you</div>
        <div class="fr-sub">${inv.kind === 'world'
          ? `to their world \u201c${escapeHtml(inv.worldName || '')}\u201d`
          : `to ${escapeHtml(inv.address || '')}`}</div>
      </div>
      <button class="pill-btn primary" data-act="join">Join</button>
      <button class="pill-btn" data-act="open">Open chat</button>`;
    card.querySelector('.fr-face').onerror = (e) => { e.target.style.visibility = 'hidden'; };
    card.querySelector('[data-act="join"]').addEventListener('click', () => joinInvite(inv));
    card.querySelector('[data-act="open"]').addEventListener('click', () => {
      const name = inv.conversationKind === 'group'
        ? (s.groups.find(g => g.id === inv.conversationId)?.name || 'Group')
        : (s.people?.[inv.conversationId]?.name || inv.hostName);
      openConversation({ kind: inv.conversationKind, id: inv.conversationId, name });
    });
    wrap.appendChild(card);
  }
}

async function joinInvite(inv) {
  try {
    const target = await window.nebula.friendsJoinInvite({ inviteId: inv.id });
    const sel = document.getElementById('launch-instance-select');
    if (!sel?.value) {
      return showToast('Pick an instance first', 'Choose which instance to join with on the Launchpad.', 'error');
    }
    showToast('Joining…', `Connecting to ${target.name || target.address}`, 'success');
    switchView('launchpad');
    const [name, versionNumber, loader] = sel.value.split('|');
    await window.nebula.launchGame({
      instanceName: name, name, versionNumber, loader, joinServer: target.address,
    });
  } catch (err) {
    // Usually "the host left" — say so plainly rather than failing silently.
    showToast("Can't join", err.message, 'error');
  }
}

function openConversation(conv) {
  if (frConversation?.kind !== conv.kind || frConversation?.id !== conv.id) { frReplyTo = null; frEditing = null; }
  frConversation = conv;
  // Looking at a chat counts as seeing its invites — drop them from the strip.
  for (const inv of (friendsState?.invites || [])) {
    if (inv.conversationKind === conv.kind && inv.conversationId === conv.id) markInviteSeen(inv.id);
  }
  window.nebula.friendsMarkRead({ conversationId: conv.id });
  renderFriendsView();
  document.getElementById('fr-input').focus();
}

// Re-render the strip periodically so invites time out on their own, even
// with no other activity.
setInterval(() => { if (!document.hidden && friendsState) renderInvites(); }, 30000);

function showPersonMenu(p, anchor) {
  document.querySelector('.fr-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'fr-menu';
  const items = p.blocked
    ? [['View profile', 'profile'], ['Unblock', 'unblock'], ['Report', 'report']]
    : [
        ['View profile', 'profile'],
        p.following ? ['Unfollow', 'unfollow'] : ['Follow', 'follow'],
        ['Message', 'dm'],
        ['Report', 'report'],
        ['Block', 'block'],
      ];
  menu.innerHTML = items.map(([label, act]) =>
    `<button data-act="${act}" class="${act === 'block' || act === 'report' ? 'danger' : ''} ${act === 'report' || act === 'profile' ? 'beta-only' : ''}">${label}</button>`).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(window.innerWidth - 160, r.left)}px`;
  menu.style.top = `${r.bottom + 4}px`;

  menu.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', async () => {
      menu.remove();
      try {
        if (b.dataset.act === 'follow') await window.nebula.friendsFollow({ uuid: p.uuid, name: p.name });
        if (b.dataset.act === 'unfollow') await window.nebula.friendsUnfollow({ uuid: p.uuid });
        if (b.dataset.act === 'block') {
          const ok = await showConfirm(
            `Block ${p.name}? They'll be removed from your friends and won't be able to follow or message you.`,
            { title: 'Block?', confirmLabel: 'Block' });
          if (ok) await window.nebula.friendsBlock({ uuid: p.uuid });
        }
        if (b.dataset.act === 'unblock') await window.nebula.friendsUnblock({ uuid: p.uuid });
        if (b.dataset.act === 'report') openReport({ uuid: p.uuid, name: p.name });
        if (b.dataset.act === 'profile') openProfile({ uuid: p.uuid, name: p.name });
        if (b.dataset.act === 'dm') openConversation({ kind: 'dm', id: p.uuid, name: p.name });
      } catch (err) { showToast('Failed', err.message, 'error'); }
    });
  });
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function handleChatAction(act) {
  if (!frConversation) return;
  if (act === 'call') {
    window.scMedia?.call({ uuid: frConversation.id, name: frConversation.name });
    return;
  }
  try {
    if (act === 'clear') {
      const ok = await showConfirm(
        'Clear this chat? Every message is removed from your launcher. The other people keep their copy.',
        { title: 'Clear chat?', confirmLabel: 'Clear' });
      if (!ok) return;
      frReplyTo = null; frEditing = null;
      await window.nebula.friendsClearConversation({ kind: frConversation.kind, conversationId: frConversation.id });
      return;
    }
    if (act === 'leave') {
      // The backend deletes the group when its OWNER leaves and just removes
      // you when a member leaves — so the label and confirmation match which
      // one you are, and deleting (which affects everyone) always confirms.
      const g = friendsState?.groups.find(x => x.id === frConversation.id);
      const owner = !!g?.isOwner;
      const ok = await showConfirm(
        owner
          ? `Delete "${g?.name || 'this group'}"? This removes the group chat for everyone in it. This can't be undone.`
          : `Leave "${g?.name || 'this group'}"? You'll stop receiving its messages.`,
        { title: owner ? 'Delete group?' : 'Leave group?', confirmLabel: owner ? 'Delete' : 'Leave' });
      if (!ok) return;
      await window.nebula.friendsLeaveGroup({ groupId: frConversation.id });
      frConversation = null;
      renderFriendsView();
      return;
    }
    if (act === 'members') return openGroupMembers(frConversation.id);


    if (act === 'invite-server') {
      // Just the address — no display name to invent, since the server's
      // own MOTD is fetched and shown on the card.
      const address = await showPrompt('Server address', 'play.example.com');
      if (!address) return;
      await window.nebula.friendsSendInvite({
        kind: 'server', address,
        conversationKind: frConversation.kind, conversationId: frConversation.id,
      });
      showToast('Invite sent', address, 'success');
    }
  } catch (err) { showToast('Failed', err.message, 'error'); }
}

/**
 * Pick exactly who goes in a group, rather than sweeping in every friend.
 * Also used to set the group picture, which everyone in the group sees.
 */
async function openGroupPicker(existingGroupId = null) {
  const s = friendsState;
  if (!s.friends.length) {
    return showToast('No friends yet', 'Follow someone, and once they follow back you can group up.', 'error');
  }
  const existing = existingGroupId ? s.groups.find(g => g.id === existingGroupId) : null;
  const chosen = new Set(existing ? existing.members.map(m => m.uuid) : []);
  let icon = existing?.icon || null;

  const wrap = document.createElement('div');
  wrap.className = 'sync-modal';
  wrap.innerHTML = `
    <div class="sync-card glass" style="width:min(480px,94vw);">
      <div class="sync-title">${existing ? 'Group members' : 'New group chat'}</div>
      <div class="gp-head">
        <div class="gp-icon" id="gp-icon"></div>
        <div class="gp-head-fields">
          <input id="gp-name" placeholder="Group name" maxlength="40" value="${escapeHtml(existing?.name || '')}">
          <div class="gp-icon-row">
            <button class="pill-btn" id="gp-upload" type="button">Upload image…</button>
            <span class="gp-icon-hint">or tap a face below</span>
          </div>
          <input type="file" id="gp-file" accept="image/*" style="display:none">
        </div>
      </div>
      <div class="gp-list" id="gp-list"></div>
      <div class="sync-actions">
        <button class="pill-btn" data-act="cancel">Cancel</button>
        <button class="pill-btn primary" data-act="ok">${existing ? 'Save' : 'Create'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const iconEl = wrap.querySelector('#gp-icon');
  const paintIcon = () => {
    const src = groupIconSrc(icon);
    iconEl.innerHTML = src
      ? `<img src="${src}" alt="">`
      : `<span>${escapeHtml((wrap.querySelector('#gp-name').value || 'G').slice(0, 2).toUpperCase())}</span>`;
  };
  wrap.querySelector('#gp-name').addEventListener('input', paintIcon);
  paintIcon();

  // Upload a custom image as the group picture.
  const fileInput = wrap.querySelector('#gp-file');
  wrap.querySelector('#gp-upload').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      icon = await imageFileToIcon(file);
      list.querySelectorAll('.gp-pic').forEach(b => b.classList.remove('on'));
      paintIcon();
    } catch (err) { showToast('Bad image', err.message, 'error'); }
    fileInput.value = '';
  });

  const list = wrap.querySelector('#gp-list');
  for (const p of s.friends) {
    const row = document.createElement('div');
    row.className = 'gp-row' + (chosen.has(p.uuid) ? ' on' : '');
    row.innerHTML = `
      <img class="fr-face" src="${frAvatar(p.uuid)}" alt="">
      <div class="fr-person-text">
        <div class="fr-name">${escapeHtml(p.name)}</div>
        <div class="fr-sub">${escapeHtml(frStatusLabel(p))}</div>
      </div>
      <button class="gp-pic" title="Use as group picture">★</button>
      <span class="gp-check">✓</span>`;
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('gp-pic')) {
        icon = p.uuid; paintIcon();
        list.querySelectorAll('.gp-pic').forEach(b => b.classList.remove('on'));
        e.target.classList.add('on');
        return;
      }
      if (chosen.has(p.uuid)) chosen.delete(p.uuid); else chosen.add(p.uuid);
      row.classList.toggle('on', chosen.has(p.uuid));
    });
    list.appendChild(row);
  }

  const close = () => wrap.remove();
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const name = wrap.querySelector('#gp-name').value.trim();
    if (!name) return showToast('Name it first', 'Give the group a name.', 'error');
    if (!chosen.size) return showToast('Nobody selected', 'Pick at least one friend.', 'error');
    try {
      if (existing) {
        await window.nebula.friendsSetGroupIcon({ groupId: existing.id, icon });
        for (const u of chosen) {
          if (!existing.members.some(m => m.uuid === u)) {
            await window.nebula.friendsAddToGroup({ groupId: existing.id, uuid: u });
          }
        }
        for (const m of existing.members) {
          if (m.uuid !== friendsState.self?.id && !chosen.has(m.uuid)) {
            await window.nebula.friendsRemoveFromGroup({ groupId: existing.id, uuid: m.uuid });
          }
        }
      } else {
        await window.nebula.friendsCreateGroup({ name, members: [...chosen], icon });
      }
      close();
      showToast(existing ? 'Group updated' : 'Group created', `${chosen.size} member${chosen.size === 1 ? '' : 's'}.`, 'success');
    } catch (err) { showToast('Failed', err.message, 'error'); }
  });
}

function openGroupMembers(groupId) { return openGroupPicker(groupId); }

async function frSend() {
  const input = document.getElementById('fr-input');
  const text = input.value.trim();
  if (!text || !frConversation) return;
  input.value = '';
  const replyTo = frReplyTo?.id || null;
  frReplyTo = null;
  renderReplyBar();
  try {
    if (frConversation.kind === 'dm') await window.nebula.friendsSendDm({ uuid: frConversation.id, text, replyTo });
    else await window.nebula.friendsSendGroupMessage({ groupId: frConversation.id, text, replyTo });
  } catch (err) { showToast("Couldn't send", err.message, 'error'); }
}

(function wireFriends() {
  if (!document.getElementById('view-friends')) return;

  // Tabs change width when the sidebar does (narrow: only the open one keeps its name).
  const frTabsEl = document.getElementById('fr-tabs');
  if (frTabsEl) new ResizeObserver(() => frTabInk()).observe(frTabsEl);
  document.querySelectorAll('#fr-tabs .fr-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#fr-tabs .fr-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      frTab = t.dataset.tab;
      renderFriendsView();
    });
  });

  const frInput = document.getElementById('fr-input');
  const frCompose = document.getElementById('fr-compose');
  const frLeft = document.getElementById('fr-left');
  const syncCompose = () => {
    const n = frInput.value.length;
    frCompose.classList.toggle('ready', !!frInput.value.trim());
    frLeft.classList.toggle('hidden', n < 400);
    frLeft.classList.toggle('low', n >= 480);
    frLeft.textContent = String(500 - n);
  };
  frInput.addEventListener('input', syncCompose);
  document.getElementById('fr-send').addEventListener('click', () => { frSend(); syncCompose(); });
  frInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { frSend(); syncCompose(); }
    if (e.key === 'Escape' && frReplyTo) { frReplyTo = null; renderReplyBar(); }
  });
  document.getElementById('fr-emoji').addEventListener('click', (e) => {
    e.stopPropagation();
    showEmojiPicker(e.currentTarget);
  });

  const frBox = document.getElementById('fr-messages');
  const frJump = document.getElementById('fr-jump');
  let frPinned = true;
  frBox.addEventListener('scroll', () => {
    frPinned = frBox.scrollHeight - frBox.scrollTop - frBox.clientHeight < 90;
    if (frPinned) frJump.classList.add('hidden');
  }, { passive: true });
  new ResizeObserver(() => {
    if (frPinned && frConversation) frBox.scrollTop = frBox.scrollHeight;
  }).observe(frBox);
  frJump.addEventListener('click', () => {
    frBox.scrollTo({ top: frBox.scrollHeight, behavior: 'smooth' });
    frJump.classList.add('hidden');
  });

  const frSearch = document.getElementById('fr-search');
  frSearch.addEventListener('input', () => { if (friendsState) renderFriendsView(); });
  frSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('fr-add-btn').click();
    if (e.key === 'Escape' && frSearch.value) { frSearch.value = ''; renderFriendsView(); }
  });
  window.addEventListener('resize', () => requestAnimationFrame(frTabInk));
  document.querySelector('[data-view="friends"]')?.addEventListener('click', () => setTimeout(frTabInk, 30));

  document.getElementById('fr-add-btn').addEventListener('click', async () => {
    const v = document.getElementById('fr-search').value.trim();
    if (!v) return;
    try {
      // A UUID follows directly; a name has to be resolved through Mojang
      // so we store a stable id rather than a name that can change.
      let uuid = v.replace(/-/g, '');
      let name = v;
      if (!/^[0-9a-f]{32}$/i.test(uuid)) {
        const r = await window.nebula.lookupPlayer?.({ name: v });
        if (!r || !r.id) return showToast('Not found', `No Minecraft account named "${v}".`, 'error');
        uuid = r.id; name = r.name;
      }
      await window.nebula.friendsFollow({ uuid, name });
      document.getElementById('fr-search').value = '';
      showToast('Following', `You're now following ${name}.`, 'success');
    } catch (err) { showToast("Couldn't follow", err.message, 'error'); }
  });

  document.getElementById('fr-new-group').addEventListener('click', () => openGroupPicker());

  window.nebula.onFriendsChanged((snap) => {
    friendsState = snap;
    syncCommunitiesFromSnap(snap);
    if (document.getElementById('view-friends')?.classList.contains('active')) renderFriendsView();
  });
  window.nebula.onFriendsConnection(() => window.nebula.friendsSnapshot().then(s => {
    friendsState = s;
    syncCommunitiesFromSnap(s);
    if (document.getElementById('view-friends')?.classList.contains('active')) renderFriendsView();
  }));
  window.nebula.onFriendsNotify((n) => showToast(n.title, n.body, n.kind === 'invite' ? 'info' : 'success'));

  // Friends snapshot is for the Friends tab — keep it off cold start.
  setTimeout(() => {
    window.nebula.friendsSnapshot().then(s => { friendsState = s; syncCommunitiesFromSnap(s); renderFriendsView(); });
  }, 1500);
})();


// =====================================================================
// SERVERS — host a Minecraft server on this PC.
// =====================================================================
let serversState = null;
let srvConsoleId = null;

function renderServers() {
  const s = serversState;
  if (!s) return;
  const list = document.getElementById('srv-list');
  list.innerHTML = '';

  if (!s.servers.length) {
    list.innerHTML = '<p class="dim" style="grid-column:1/-1;">No servers yet. Create one and it will run right here on your PC.</p>';
    return;
  }

  for (const srv of s.servers) {
    const card = document.createElement('div');
    card.className = `srv-card glass liquid-glass ${srv.running ? (srv.ready ? 'up' : 'starting') : 'down'}`;
    card.innerHTML = `
      <div class="srv-top">
        <div>
          <div class="srv-name">${escapeHtml(srv.displayName)}</div>
          <div class="srv-addr" title="Not connected to DNS yet">${escapeHtml(srv.address)}</div>
        </div>
        <span class="srv-state">${srv.running ? (srv.ready ? 'Online' : 'Starting…') : 'Offline'}</span>
      </div>
      <div class="srv-meta">
        <span>${escapeHtml(srv.versionNumber)}</span>
        <span>${srv.ramGB} GB RAM</span>
        <span>${escapeHtml(srv.difficulty)}${srv.hardcore ? ' · hardcore' : ''}</span>
        <span>${escapeHtml(srv.gamemode)}</span>
      </div>
      ${srv.running && srv.players.length
        ? `<div class="srv-players">${srv.players.map(p => `<span>${escapeHtml(p)}</span>`).join('')}</div>`
        : ''}
      <div class="srv-actions">
        ${srv.running
          ? '<button class="pill-btn" data-act="stop">Stop</button>'
          : '<button class="pill-btn primary" data-act="start">Start</button>'}
        <button class="pill-btn" data-act="console">Console</button>
        ${srv.running ? '' : '<button class="pill-btn" data-act="edit">Settings</button>'}
        ${srv.running ? '' : '<button class="pill-btn" data-act="delete">Delete</button>'}
      </div>`;

    card.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', () => handleServerAction(srv, b.dataset.act));
    });
    list.appendChild(card);
  }
}

async function handleServerAction(srv, act) {
  try {
    if (act === 'start') {
      if (!srv.eulaAccepted) {
        const ok = await showConfirm(
          'Minecraft servers require you to accept Mojang\u2019s End User Licence Agreement (minecraft.net/eula). Accept it for this server?',
          { title: 'Accept the Minecraft EULA?', confirmLabel: 'I accept' });
        if (!ok) return;
        await window.nebula.serversAcceptEula({ id: srv.id });
      }
      openServerConsole(srv.id);
      showToast('Starting server', 'The first run downloads the server and generates the world.', 'info');
      await window.nebula.serversStart({ id: srv.id });
    }
    if (act === 'stop') {
      await window.nebula.serversStop({ id: srv.id });
      showToast('Stopping', 'Saving the world and shutting down.', 'info');
    }
    if (act === 'console') openServerConsole(srv.id);
    if (act === 'edit') openServerDialog(srv);
    if (act === 'delete') {
      const ok = await showConfirm(
        `Delete "${srv.displayName}"? Choose whether to keep the world files in the next step.`,
        { title: 'Delete server?', confirmLabel: 'Delete' });
      if (!ok) return;
      const wipe = await showConfirm(
        'Also delete the world and all its files? This cannot be undone.',
        { title: 'Delete world files too?', confirmLabel: 'Delete everything' });
      if (wipe) await window.nebula.serversDeleteFiles({ id: srv.id });
      await window.nebula.serversRemove({ id: srv.id });
    }
  } catch (err) { showToast('Failed', err.message, 'error'); }
}

async function openServerConsole(id) {
  srvConsoleId = id;
  const box = document.getElementById('srv-console');
  box.classList.remove('hidden');
  const srv = serversState?.servers.find(x => x.id === id);
  document.getElementById('srv-console-title').textContent = `Console — ${srv?.displayName || ''}`;
  const logEl = document.getElementById('srv-log');
  logEl.innerHTML = '';
  const logs = await window.nebula.serversLogs({ id });
  for (const l of logs) appendServerLog(l, true);
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function appendServerLog(entry, force = false) {
  if (!force && entry.id !== srvConsoleId) return;
  const logEl = document.getElementById('srv-log');
  if (!logEl) return;
  const line = document.createElement('div');
  line.className = `srv-log-line ${entry.level || 'info'}`;
  line.textContent = entry.line;
  logEl.appendChild(line);
  while (logEl.children.length > 800) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

async function openServerDialog(existing = null) {
  const s = serversState;
  const versions = await window.nebula.listVersionsGrouped();
  const flat = versions.flatMap(g => g.versions).slice(0, 60);
  const sys = s.system;

  const wrap = document.createElement('div');
  wrap.className = 'sync-modal';
  wrap.innerHTML = `
    <div class="sync-card glass" style="width:min(560px,94vw); max-height:92vh; overflow:auto;">
      <div class="sync-title">${existing ? 'Server settings' : 'New server'}</div>
      <p class="sync-sub">Runs on this PC. Your address is reserved now and will work once the domain is connected.</p>

      <div class="srv-field">
        <label>Server name</label>
        <input id="sd-name" maxlength="24" placeholder="my-smp" value="${escapeHtml(existing?.displayName || '')}">
        <div class="srv-addr-preview" id="sd-addr">—</div>
      </div>

      <div class="srv-row">
        <div class="srv-field"><label>Minecraft version</label>
          <select id="sd-version">${flat.map(v =>
            `<option value="${v}" ${existing?.versionNumber === v ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="srv-field"><label>RAM: <b id="sd-ram-label">${existing?.ramGB || sys.suggestedGB} GB</b></label>
          <input type="range" id="sd-ram" min="1" max="${sys.maxAllocGB}" value="${existing?.ramGB || sys.suggestedGB}">
          <div class="srv-hint">This PC has ${sys.totalRamGB} GB. Leave room for the OS and your own game.</div></div>
      </div>

      <div class="srv-row">
        <div class="srv-field"><label>Difficulty</label>
          <select id="sd-difficulty">${s.options.difficulties.map(d =>
            `<option value="${d}" ${existing?.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
        <div class="srv-field"><label>Mode</label>
          <select id="sd-gamemode">${s.options.gamemodes.map(g =>
            `<option value="${g}" ${existing?.gamemode === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
      </div>

      <div class="srv-row">
        <div class="srv-field"><label>World type</label>
          <select id="sd-leveltype">${s.options.levelTypes.map(l =>
            `<option value="${l.id}" ${existing?.levelType === l.id ? 'selected' : ''}>${l.label}</option>`).join('')}</select></div>
        <div class="srv-field"><label>Max players</label>
          <input id="sd-max" type="number" min="1" max="200" value="${existing?.maxPlayers || 10}"></div>
      </div>

      <div class="srv-field"><label>Seed (optional)</label>
        <input id="sd-seed" placeholder="leave blank for random" value="${escapeHtml(existing?.seed || '')}"></div>

      <label class="toggle-inline">
        <label class="toggle"><input type="checkbox" id="sd-hardcore" ${existing?.hardcore ? 'checked' : ''}><span class="toggle-track"><span class="toggle-thumb"></span></span></label>
        <span>Hardcore <span class="hint">one life, difficulty locked to hard</span></span>
      </label>
      <label class="toggle-inline">
        <label class="toggle"><input type="checkbox" id="sd-pvp" ${existing?.pvp !== false ? 'checked' : ''}><span class="toggle-track"><span class="toggle-thumb"></span></span></label>
        <span>PvP</span>
      </label>

      <div class="sync-actions">
        <button class="pill-btn" data-act="cancel">Cancel</button>
        <button class="pill-btn primary" data-act="ok">${existing ? 'Save' : 'Create'}</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const nameEl = wrap.querySelector('#sd-name');
  const addrEl = wrap.querySelector('#sd-addr');
  const slugify = (v) => String(v || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const paintAddr = () => {
    const slug = slugify(nameEl.value);
    addrEl.textContent = slug.length >= 3 ? `${slug}.nebulahosting.co` : 'at least 3 characters';
    addrEl.classList.toggle('ok', slug.length >= 3);
  };
  nameEl.addEventListener('input', paintAddr); paintAddr();

  const ram = wrap.querySelector('#sd-ram');
  ram.addEventListener('input', () => { wrap.querySelector('#sd-ram-label').textContent = `${ram.value} GB`; });

  // Hardcore forces hard difficulty, exactly as the game does.
  const hardcore = wrap.querySelector('#sd-hardcore');
  const diff = wrap.querySelector('#sd-difficulty');
  const syncHardcore = () => { if (hardcore.checked) { diff.value = 'hard'; diff.disabled = true; } else diff.disabled = false; };
  hardcore.addEventListener('change', syncHardcore); syncHardcore();

  const close = () => wrap.remove();
  wrap.querySelector('[data-act="cancel"]').addEventListener('click', close);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('[data-act="ok"]').addEventListener('click', async () => {
    const cfg = {
      name: nameEl.value.trim(),
      versionNumber: wrap.querySelector('#sd-version').value,
      ramGB: parseInt(ram.value, 10),
      difficulty: diff.value,
      gamemode: wrap.querySelector('#sd-gamemode').value,
      hardcore: hardcore.checked,
      levelType: wrap.querySelector('#sd-leveltype').value,
      seed: wrap.querySelector('#sd-seed').value.trim(),
      maxPlayers: parseInt(wrap.querySelector('#sd-max').value, 10) || 10,
      pvp: wrap.querySelector('#sd-pvp').checked,
    };
    try {
      if (existing) await window.nebula.serversUpdate({ id: existing.id, patch: cfg });
      else await window.nebula.serversCreate(cfg);
      close();
      showToast(existing ? 'Saved' : 'Server created', cfg.name, 'success');
    } catch (err) { showToast('Failed', err.message, 'error'); }
  });
}

(function wireServers() {
  if (!document.getElementById('view-servers')) return;
  document.getElementById('srv-new').addEventListener('click', () => openServerDialog());
  document.getElementById('srv-console-close').addEventListener('click', () => {
    document.getElementById('srv-console').classList.add('hidden');
    srvConsoleId = null;
  });
  const runCmd = async () => {
    const input = document.getElementById('srv-cmd');
    const cmd = input.value.trim();
    if (!cmd || !srvConsoleId) return;
    input.value = '';
    try { await window.nebula.serversCommand({ id: srvConsoleId, command: cmd }); }
    catch (err) { showToast('Command failed', err.message, 'error'); }
  };
  document.getElementById('srv-cmd-send').addEventListener('click', runCmd);
  document.getElementById('srv-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCmd(); });

  window.nebula.onServersChanged((snap) => { serversState = snap; renderServers(); });
  window.nebula.onServersLog((entry) => appendServerLog(entry));
  window.nebula.onServersProgress(({ id, message }) => appendServerLog({ id, line: `» ${message}`, level: 'info' }));
  // Snapshot is for the Servers tab — don't compete with first paint.
  setTimeout(() => {
    if (document.body.classList.contains('beta-layout')) return;
    window.nebula.serversSnapshot().then(s => { serversState = s; renderServers(); });
  }, 1800);
})();

// initial load — only what the launchpad needs before the window shows.
refreshInstances();
syncPerfChip();
updateLaunchState();

// Versions grid + customize thumbs are for other tabs — load after paint.
const afterPaint = (fn, ms = 0) => {
  const run = () => setTimeout(fn, ms);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 500 + ms });
  else requestAnimationFrame(() => requestAnimationFrame(run));
};
afterPaint(() => { ensureBackgrounds().then(() => loadVersionGroups()); }, 50);
// renderCustomize() builds 7 procedural scene thumbs — only when Customize opens
// (nav already calls it). Don't pay that cost on every cold start.

// ---------------------------------------------------------------------
// Auto-update UI — always-visible Updates menu (stable + beta + check).
// Popup only for STABLE updates (never auto-popup for beta).
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// Person menu for anyone seen in live chat or the online list: follow,
// message, invite, block. Messaging and invites need a mutual follow (the
// server drops them otherwise), so those say so instead of failing quietly.
// ---------------------------------------------------------------------
function showPeopleMenu(person, x, y) {
  document.querySelector('.people-menu')?.remove();
  const s = friendsState || {};
  const has = (list) => (list || []).some(p => p.uuid === person.uuid);
  const blocked = has(s.blocked), following = has(s.following), friend = has(s.friends);
  const items = blocked
    ? [['View profile', 'profile'], ['Unblock', 'unblock'], ['Report', 'report']]
    : [
        ['View profile', 'profile'],
        following ? ['Unfollow', 'unfollow'] : ['Follow', 'follow'],
        ['Message', 'dm'],
        ['Call', 'call'],
        ['Invite to server', 'invite'],
        ['Report', 'report'],
        ['Block', 'block'],
      ];
  const menu = document.createElement('div');
  menu.className = 'fr-menu people-menu';
  menu.innerHTML = `<div class="pm-head"><img class="pm-face" src="${frAvatar(person.uuid)}" alt="">${escapeHtml(person.name || 'Player')}</div>`
    + items.map(([label, act]) => `<button data-act="${act}" class="${act === 'block' || act === 'report' ? 'danger' : ''} ${act === 'report' || act === 'profile' ? 'beta-only' : ''}">${label}</button>`).join('');
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - mw - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - mh - 6))}px`;
  const needFriend = () => {
    showToast('Follow each other first', `You can message and invite ${person.name} once you follow each other.`, 'info');
  };
  menu.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    menu.remove();
    const act = b.dataset.act;
    try {
      if (act === 'follow') { await window.nebula.friendsFollow({ uuid: person.uuid, name: person.name }); showToast('Following', person.name, 'success'); }
      if (act === 'unfollow') await window.nebula.friendsUnfollow({ uuid: person.uuid });
      if (act === 'unblock') await window.nebula.friendsUnblock({ uuid: person.uuid });
      if (act === 'report') openReport({ uuid: person.uuid, name: person.name });
      if (act === 'profile') openProfile({ uuid: person.uuid, name: person.name });
      if (act === 'block') {
        const ok = await showConfirm(
          `Block ${person.name}? They'll be removed from your friends and won't be able to follow or message you.`,
          { title: 'Block?', confirmLabel: 'Block' });
        if (ok) await window.nebula.friendsBlock({ uuid: person.uuid });
      }
      if (act === 'dm') {
        if (!friend) return needFriend();
        switchView('friends');
        openConversation({ kind: 'dm', id: person.uuid, name: person.name });
      }
      if (act === 'call') {
        if (!friend) return needFriend();
        window.scMedia?.call({ uuid: person.uuid, name: person.name });
      }
      if (act === 'invite') {
        if (!friend) return needFriend();
        const address = await showPrompt('Server address', 'play.example.com');
        if (!address) return;
        await window.nebula.friendsSendInvite({ kind: 'server', address, conversationKind: 'dm', conversationId: person.uuid });
        showToast('Invite sent', `${person.name} · ${address}`, 'success');
      }
    } catch (err) { showToast('Failed', err.message, 'error'); }
  }));
  const dismiss = (e) => {
    if (menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('mousedown', dismiss, true);
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
}

// ---------------------------------------------------------------------
// Live chat — one room shared by everyone signed in to the launcher.
// ---------------------------------------------------------------------
(function wireLiveChat() {
  const chip = document.getElementById('chat-chip');
  const panel = document.getElementById('live-chat');
  if (!chip || !panel) return;
  const list = document.getElementById('live-chat-list');
  const sub = document.getElementById('live-chat-sub');
  const input = document.getElementById('live-chat-input');
  const sendBtn = document.getElementById('live-chat-send');
  const badge = document.getElementById('chat-chip-badge');
  const viewersEl = document.getElementById('live-chat-viewers');
  const viewersN = document.getElementById('live-chat-viewers-n');
  const facesEl = document.getElementById('live-chat-faces');
  const head = document.getElementById('live-chat-head');
  let state = { connected: false, signedIn: false, messages: [], canModerate: false, selfId: null };

  // Drag the panel by its header anywhere inside the window; remembered.
  const POS_KEY = 'sc.liveChatPos';
  const clampPos = (x, y) => {
    const w = panel.offsetWidth || 360, h = panel.offsetHeight || 400;
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      // Beta: the bottom edge stops the panel like the sides do, so pushing past it pops out.
      y: Math.max(40, Math.min(y, window.innerHeight - (betaLayoutOn() ? h + 8 : Math.min(h, 120)))),
    };
  };
  const placeAt = (x, y) => {
    const p = clampPos(x, y);
    panel.style.left = `${p.x}px`;
    panel.style.top = `${p.y}px`;
    panel.style.right = 'auto';
    return p;
  };
  const restorePos = () => {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) placeAt(p.x, p.y);
    } catch { /* ignore */ }
  };
  head.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || lcFloat.win) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    panel.classList.add('dragging');
    const move = scPerFrame((ev) => {
      placeAt(ev.clientX - ox, ev.clientY - oy);
      scFloatDrag(lcFloat, ev, { x: ev.clientX - ox, y: ev.clientY - oy, w: r.width, h: r.height });
    });
    const up = (ev) => {
      move.flush();
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      panel.classList.remove('dragging');
      const b = panel.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) })); } catch { /* full */ }
      scFloatDrop(lcFloat, ev, { x: ox, y: oy });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // Resize from any corner; the size is remembered with the position.
  const SIZE_KEY = 'sc.liveChatSize';
  const MIN_W = 330, MIN_H = 320;
  const applySize = (w, h) => {
    const sw = Math.max(MIN_W, Math.min(w, window.innerWidth - 16));
    const sh = Math.max(MIN_H, Math.min(h, window.innerHeight - 48));
    panel.style.width = `${sw}px`;
    panel.style.height = `${sh}px`;
  };
  const restoreSize = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
      if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) applySize(s.w, s.h);
    } catch { /* ignore */ }
  };
  const saveLayout = () => {
    const b = panel.getBoundingClientRect();
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(b.left), y: Math.round(b.top) }));
      localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(b.width), h: Math.round(b.height) }));
    } catch { /* full */ }
  };
  panel.querySelectorAll('.lc-rz').forEach((grip) => grip.addEventListener('mousedown', (e) => {
    scResize(e, grip, { f: lcFloat, panel, minW: MIN_W, minH: MIN_H, save: saveLayout });
  }));
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || lcFloat.win) return;
    panel.style.left = ''; panel.style.top = ''; panel.style.right = '';
    panel.style.width = ''; panel.style.height = '';
    try { localStorage.removeItem(POS_KEY); localStorage.removeItem(SIZE_KEY); } catch { /* ignore */ }
  });
  window.addEventListener('resize', () => {
    if (!isOpen() || lcFloat.win) return;
    if (panel.style.width) applySize(panel.offsetWidth, panel.offsetHeight);
    if (!panel.style.left) return;
    const b = panel.getBoundingClientRect();
    placeAt(b.left, b.top);
  });
  const isOpen = () => !panel.classList.contains('hidden');
  // No unread counter on the chip: in a busy room it never stops climbing.
  badge?.classList.add('hidden');

  // Up to three faces, then "+N", then the count. Only rebuilt when the
  // room changes, so the faces don't reload on every message.
  function renderViewers() {
    let people = Array.isArray(state.people) ? state.people : [];
    // Beta: you're in the room while it's open, so your head always leads.
    const me = String(state.selfId || '').replace(/-/g, '').toLowerCase();
    if (betaLayoutOn() && me && isOpen()) {
      const mine = people.find((p) => p.uuid.toLowerCase() === me) || { uuid: me, name: state.selfName || 'You' };
      people = [mine, ...people.filter((p) => p !== mine)];
    }
    const count = Math.max(1, state.viewers, people.length);
    const shown = people.slice(0, 3);
    viewersN.textContent = String(count);
    const key = `${shown.map(p => p.uuid).join(',')}|${count}`;
    if (facesEl.dataset.key !== key) {
      facesEl.dataset.key = key;
      facesEl.innerHTML = '';
      for (const p of shown) {
        const img = document.createElement('img');
        img.className = 'lcv-face';
        img.alt = '';
        img.title = p.name;
        img.onerror = () => img.remove();
        img.src = frAvatar(p.uuid);
        facesEl.appendChild(img);
      }
      const extra = count - shown.length;
      if (shown.length && extra > 0) {
        const more = document.createElement('span');
        more.className = 'lcv-more';
        more.textContent = `+${Math.min(extra, 99)}`;
        facesEl.appendChild(more);
      }
    }
    const others = count - people.length;
    viewersEl.title = people.length
      ? `In live chat: ${people.map(p => p.name).join(', ')}${others > 0 ? ` and ${others} more` : ''}`
      : 'People with live chat open';
  }

  // ---- beta live chat ----
  const LC_SEEN_KEY = 'sc.lc.seenAt';
  const jumpBtn = document.getElementById('lc-jump');
  const jumpLabel = document.getElementById('lc-jump-label');
  const replyBar = document.getElementById('lc-replybar');
  const countEl = document.getElementById('lc-count');
  let replyTo = null;
  let lcSeenIds = new Set();
  let lcUnreadFrom = 0;
  let lcBelow = 0;
  let lcMentions = 0;
  const sentHistory = [];
  let historyAt = -1;
  const ROLE_SVG = {
    owner: '<path d="M3 7l4.5 3.5L12 4l4.5 6.5L21 7l-2 11H5L3 7zm2.3 13h13.4v2H5.3v-2z"/>',
    admin: '<path d="M12 2 4 5v6c0 5.25 3.4 10.1 8 11 4.6-.9 8-5.75 8-11V5l-8-3z"/>',
    manager: '<path d="M12 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM8.2 12.4 6.5 21l5.5-3 5.5 3-1.7-8.6"/>',
    verified: '<path d="M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12zm-12.91 4.72-3.8-3.81 1.48-1.48 2.32 2.33 5.85-5.87 1.48 1.48-7.33 7.35z"/>',
    'solar+': '<path d="M12 2l2.6 6.9L22 9.3l-5.7 4.6 1.9 7.1L12 17l-6.2 4 1.9-7.1L2 9.3l7.4-.4z"/>',
  };
  const ICON = {
    reply: '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
    at: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 5 18.66l-1-1.73A8 8 0 1 1 20 12v1.5a1.5 1.5 0 0 1-3 0V12a5 5 0 1 0-1.46 3.53A3.5 3.5 0 0 0 22 13.5V12A10 10 0 0 0 12 2zm0 13a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  };
  const roleBadge = (role) => {
    const k = String(role || '').toLowerCase();
    return ROLE_SVG[k] ? `<svg class="lc-badge" data-role="${k}" viewBox="0 0 24 24" aria-label="${escapeHtml(role)}"><title>${escapeHtml(role)}</title>${ROLE_SVG[k]}</svg>` : '';
  };
  const chatPeople = () => {
    const seen = new Map();
    for (const p of state.people || []) if (p?.name) seen.set(p.name.toLowerCase(), { uuid: p.uuid, name: p.name });
    for (const m of state.messages || []) if (m?.name && !seen.has(m.name.toLowerCase())) seen.set(m.name.toLowerCase(), { uuid: m.from, name: m.name });
    return [...seen.values()].filter((p) => p.name !== myName());
  };
  scMentionAuto(input, chatPeople);
  const setReply = (m) => {
    replyTo = m ? { name: m.name || 'Player', text: scParseReply(m.text)?.body || m.text } : null;
    replyBar.classList.toggle('hidden', !replyTo);
    if (replyTo) {
      panel.querySelector('#lc-reply-name').textContent = replyTo.name;
      panel.querySelector('#lc-reply-quote').textContent = replyTo.text.slice(0, 80);
      input.focus();
    }
  };
  document.getElementById('lc-reply-x').addEventListener('click', () => setReply(null));
  const mention = (name) => { scInsert(input, `${input.value && !/\s$/.test(input.value) ? ' ' : ''}@${name} `); };
  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); showToast('Copied', 'Message copied to your clipboard.', 'success'); }
    catch { showToast("Couldn't copy", 'Clipboard is not available.', 'error'); }
  };
  const msgMenu = (m, x, y) => {
    const mine = !!state.selfId && m.from === state.selfId;
    const body = scParseReply(m.text)?.body || m.text;
    scMenu(x, y, [
      ['Reply', () => setReply(m), { hint: 'R' }],
      ...(mine ? [] : [[`Mention @${m.name || 'Player'}`, () => mention(m.name || 'Player')]]),
      ['Copy text', () => copyText(body)],
      '-',
      ...(mine ? [['Delete for everyone', () => window.nebula.chatDelete({ id: m.id }).catch((err) => showToast("Couldn't delete", err.message, 'error')), { danger: true }]]
        : [['View profile', () => openProfile({ uuid: m.from, name: m.name })],
          ['Player options…', () => showPeopleMenu({ uuid: m.from, name: m.name || 'Player' }, x, y)],
          ['Report', () => openReport({ uuid: m.from, name: m.name, context: { where: 'Live chat', text: m.text, at: m.at } }), { danger: true }]]),
    ], { title: m.name || 'Player' });
  };
  const atBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const paintJump = () => {
    jumpBtn.classList.toggle('hidden', lcBelow <= 0 || atBottom());
    jumpLabel.textContent = lcBelow === 1 ? '1 new message' : `${lcBelow} new messages`;
  };
  list.addEventListener('scroll', () => { if (atBottom()) { lcBelow = 0; } paintJump(); });
  jumpBtn.addEventListener('click', () => { list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); lcBelow = 0; paintJump(); });

  function renderBeta(ready) {
    sub.textContent = !state.signedIn ? 'Sign in to chat'
      : !state.connected ? 'Connecting…'
      : state.available === false ? 'Chat server is offline'
      : 'Messages last 1 hour';
    const wasBottom = atBottom() || !render.scrolled;
    const prevTop = list.scrollTop;
    const msgs = state.messages;
    if (!msgs.length) {
      list.innerHTML = `<div class="lc-empty"><div class="lc-empty-ic">${ICON.reply}</div><b>${
        ready ? 'It\'s quiet in here' : 'Live chat is offline'}</b><span>${
        ready ? 'Say hi. Everyone on SolarClient can see live chat.' : 'Live chat opens once you\'re signed in and online.'}</span></div>`;
      lcSeenIds = new Set(state.messages.map((m) => m.id));
      return;
    }
    const me = myName();
    let html = '';
    let prev = null;
    let newCount = 0;
    let dividerDone = false;
    for (const m of msgs) {
      const mine = !!state.selfId && m.from === state.selfId;
      const isNew = render.scrolled && !lcSeenIds.has(m.id);
      if (isNew && !mine) newCount++;
      if (!dividerDone && lcUnreadFrom && m.at > lcUnreadFrom && !mine && prev) {
        html += '<div class="lc-divider"><span>New</span></div>';
        dividerDone = true;
        prev = null;
      }
      const cont = prev && prev.from === m.from && m.at - prev.at < 5 * 60 * 1000;
      const reply = scParseReply(m.text);
      const body = reply ? reply.body : m.text;
      const mentioned = !mine && scMentionsMe(body, me);
      const time = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const role = String(m.role || '').toLowerCase();
      const big = SC_EMOJI_ONLY.test(body.trim());
      html += `<div class="lc-msg ${mine ? 'mine' : ''} ${cont ? 'cont' : ''} ${mentioned ? 'mention' : ''} ${isNew ? 'is-new' : ''}" data-id="${escapeHtml(m.id)}" data-role="${escapeHtml(role)}">
        ${cont ? `<span class="lc-gutter" title="${escapeHtml(new Date(m.at).toLocaleString())}">${escapeHtml(time)}</span>`
          : `<img class="lc-face" src="${frAvatar(m.from)}" alt="" ${personAttr(m.from, m.name)}>`}
        <div class="lc-body">
          ${reply ? `<div class="lc-reply" data-jump="${escapeHtml(reply.to)}">${ICON.reply}<b>@${escapeHtml(reply.to)}</b><span>${escapeHtml(reply.quote)}</span></div>` : ''}
          ${cont ? '' : `<div class="lc-meta"><span class="lc-name" ${personAttr(m.from, m.name)}>${escapeHtml(m.name || 'Player')}</span>${roleBadge(m.role)}<time class="lc-time" title="${escapeHtml(new Date(m.at).toLocaleString())}">${escapeHtml(time)}</time></div>`}
          <div class="lc-text${big ? ' big' : ''}">${scRich(body, { me })}</div>
        </div>
        <div class="lc-tools">
          <button type="button" data-t="reply" title="Reply">${ICON.reply}</button>
          ${mine ? '' : `<button type="button" data-t="at" title="Mention">${ICON.at}</button>`}
          <button type="button" data-t="copy" title="Copy text">${ICON.copy}</button>
          ${mine ? `<button type="button" data-t="del" class="danger" title="Delete for everyone">${ICON.del}</button>`
            : reportFlag(m.from, m.name, { where: 'Live chat', text: m.text, at: m.at })}
          <button type="button" data-t="more" title="More">${ICON.more}</button>
        </div>
      </div>`;
      prev = m;
    }
    if (lastBlocked && Date.now() - lastBlocked.at < 60000) {
      html += `<div class="lc-blocked"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><span>${escapeHtml(lastBlocked.reason)}</span></div>`;
    }
    list.innerHTML = html;
    lcSeenIds = new Set(state.messages.map((m) => m.id));
    if (wasBottom) {
      list.scrollTop = list.scrollHeight;
      lcBelow = 0;
      render.scrolled = true;
    } else {
      list.scrollTop = prevTop;
      lcBelow += newCount;
    }
    paintJump();
  }

  list.addEventListener('click', (e) => {
    if (!betaLayoutOn()) return;
    const row = e.target.closest('.lc-msg');
    const m = row && state.messages.find((x) => x.id === row.dataset.id);
    const jump = e.target.closest('.lc-reply');
    if (jump) {
      const to = jump.dataset.jump.toLowerCase();
      const idx = state.messages.indexOf(m);
      const target = state.messages.slice(0, idx).reverse().find((x) => (x.name || '').toLowerCase() === to);
      const el = target && list.querySelector(`.lc-msg[data-id="${CSS.escape(target.id)}"]`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
      return;
    }
    const t = e.target.closest('.lc-tools button[data-t]');
    if (!t || !m) return;
    e.stopPropagation();
    const act = t.dataset.t;
    if (act === 'reply') setReply(m);
    else if (act === 'at') mention(m.name || 'Player');
    else if (act === 'copy') copyText(scParseReply(m.text)?.body || m.text);
    else if (act === 'del') window.nebula.chatDelete({ id: m.id }).catch((err) => showToast("Couldn't delete", err.message, 'error'));
    else if (act === 'more') { const r = scRect(t); msgMenu(m, r.left, r.bottom + 4); }
  });
  list.addEventListener('contextmenu', (e) => {
    if (!betaLayoutOn()) return;
    const row = e.target.closest('.lc-msg');
    const m = row && state.messages.find((x) => x.id === row.dataset.id);
    if (!m) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    msgMenu(m, e.clientX, e.clientY);
  }, true);

  document.getElementById('lc-emoji-btn').addEventListener('click', (e) => {
    if (input.disabled) return;
    scEmojiPicker(e.currentTarget, (em) => scInsert(input, em));
  });
  input.addEventListener('input', () => {
    if (!betaLayoutOn()) return;
    const n = input.value.length;
    countEl.textContent = n >= 240 ? `${300 - n}` : '';
    countEl.classList.toggle('warn', n >= 280);
  });
  function render() {
    const ready = state.connected && state.signedIn && state.available !== false;
    input.disabled = !ready; sendBtn.disabled = !ready;
    if (betaLayoutOn()) {
      const hasViewers = ready && typeof state.viewers === 'number';
      viewersEl.classList.toggle('hidden', !hasViewers);
      if (hasViewers) renderViewers();
      renderBeta(ready);
      return;
    }
    sub.textContent = !state.signedIn ? 'Sign in to chat'
      : !state.connected ? 'Connecting…'
      : state.available === false ? 'Chat server is offline' : 'Everyone on SolarClient';
    const hasViewers = ready && typeof state.viewers === 'number';
    viewersEl.classList.toggle('hidden', !hasViewers);
    if (hasViewers) renderViewers();
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = '';
    if (!state.messages.length) {
      list.innerHTML = `<p class="live-chat-empty">${ready ? 'No messages yet — say hi to everyone.' : 'Live chat opens once you\'re signed in and online.'}</p>`;
      return;
    }
    for (const m of state.messages) {
      const mine = !!state.selfId && m.from === state.selfId;
      const el = document.createElement('div');
      el.className = `lc-msg ${mine ? 'mine' : ''}`;
      const role = m.role && m.role !== 'member' ? `<span class="lc-role" data-role="${escapeHtml(String(m.role).toLowerCase())}">${escapeHtml(m.role)}</span>` : '';
      el.innerHTML = `
        <img class="lc-face" src="${frAvatar(m.from)}" alt="" ${personAttr(m.from, m.name)}>
        <div class="lc-body">
          <div class="lc-meta"><span class="lc-name" ${personAttr(m.from, m.name)}>${escapeHtml(m.name || 'Player')}</span>${role}
            ${mine ? '' : reportFlag(m.from, m.name, { where: 'Live chat', text: m.text, at: m.at })}
            <span class="lc-time">${new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
          <div class="lc-text">${linkifyText(m.text)}</div>
        </div>
        ${mine ? '<button class="lc-del" title="Delete for everyone">Delete</button>' : ''}`;
      el.querySelector('.lc-face').onerror = (e) => { e.target.style.visibility = 'hidden'; };
      if (!mine) {
        el.title = 'Right-click for options';
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          showPeopleMenu({ uuid: m.from, name: m.name || 'Player' }, e.clientX, e.clientY);
        });
      }
      el.querySelector('.lc-del')?.addEventListener('click', () => {
        window.nebula.chatDelete({ id: m.id }).catch((err) => showToast("Couldn't delete", err.message, 'error'));
      });
      list.appendChild(el);
    }
    if (lastBlocked && Date.now() - lastBlocked.at < 60000) {
      const note = document.createElement('div');
      note.className = 'lc-blocked';
      note.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg><span>${escapeHtml(lastBlocked.reason)}</span>`;
      list.appendChild(note);
    }
    if (nearBottom || !render.scrolled) { list.scrollTop = list.scrollHeight; render.scrolled = true; }
  }
  let lastBlocked = null;

  scPanelScale(panel, 400);
  function open() {
    panel.classList.remove('hidden');
    restoreSize();
    restorePos();
    scFloatFit(lcFloat, { glide: false });
    popDown(panel, chip);
    chip.classList.add('open');
    lcUnreadFrom = Number(localStorage.getItem(LC_SEEN_KEY) || 0);
    lcMentions = 0;
    badge?.classList.add('hidden');
    render.scrolled = false;
    render();
    if (!input.disabled) input.focus();
    window.nebula.chatPresence?.(true).catch(() => {});
    window.nebula.chatEnsure?.().then((g) => {
      if (!g) return;
      state = g; render();
      if (!input.disabled && isOpen()) input.focus();
    }).catch(() => {});
  }
  function close() {
    if (lcFloat.win) { scDock('chat', { shut: true }); return; }
    try { localStorage.setItem(LC_SEEN_KEY, String(Date.now())); } catch { /* full */ }
    chip.classList.remove('open');
    window.nebula.chatPresence?.(false).catch(() => {});
    popClose(panel, () => panel.classList.add('hidden'));
  }
  const lcFloat = scFloatAdd('chat', {
    panel, host: panel, chip, closeBtn: document.getElementById('live-chat-close'), btnClass: 'sc-hbtn',
    title: 'Live chat', isOpen, close,
    place: (x, y) => placeAt(x, y),
    save: saveLayout,
    restore: () => { restoreSize(); restorePos(); },
    resize: applySize,
  });

  // Slow mode: one message every few seconds (moderators skip it). The main process enforces it too.
  let slowUntil = 0;
  let slowTick = null;
  const compose = sendBtn.closest('.live-chat-compose');
  function paintSlow() {
    const left = Math.ceil((slowUntil - Date.now()) / 1000);
    const on = left > 0;
    compose?.classList.toggle('lc-slowing', on);
    sendBtn.textContent = on ? `${left}s` : 'Send';
    sendBtn.title = on ? `Slow mode: you can send again in ${left}s` : '';
    if (!on) { clearInterval(slowTick); slowTick = null; }
  }
  function startSlow(ms) {
    slowUntil = Date.now() + ms;
    compose?.style.setProperty('--slow-ms', `${ms}ms`);
    compose?.classList.remove('lc-slowing'); void compose?.offsetWidth;
    clearInterval(slowTick);
    slowTick = setInterval(paintSlow, 200);
    paintSlow();
  }
  async function send() {
    const typed = input.value.trim();
    if (!typed) return;
    if (Date.now() < slowUntil) {
      compose?.classList.remove('lc-slow-nudge'); void compose?.offsetWidth; compose?.classList.add('lc-slow-nudge');
      return;
    }
    if (!state.canModerate) startSlow(state.slowMs || 5000);
    let text = typed;
    if (betaLayoutOn()) {
      text = scShortcodes(typed);
      if (replyTo) text = scReplyText(replyTo.name, replyTo.text, text, 300);
      sentHistory.unshift(typed);
      sentHistory.length = Math.min(sentHistory.length, 20);
      historyAt = -1;
    }
    input.value = '';
    input.dispatchEvent(new Event('input'));
    const hadReply = replyTo;
    setReply(null);
    try { await window.nebula.chatSend({ text }); }
    catch (err) {
      input.value = typed;
      if (hadReply) setReply({ name: hadReply.name, text: hadReply.text });
      const msg = String(err.message || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      const wait = /Slow mode.*?(\d+)s/.exec(msg);
      if (wait) startSlow(Number(wait[1]) * 1000);
      else { slowUntil = 0; paintSlow(); showToast("Couldn't send", msg, 'error'); }
    }
  }

  chip.addEventListener('click', () => (isOpen() ? close() : open()));
  document.getElementById('live-chat-close').addEventListener('click', close);
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
    if (e.key === 'Escape') {
      if (betaLayoutOn() && replyTo) { setReply(null); return; }
      close();
    }
    if (!betaLayoutOn()) return;
    if (e.key === 'ArrowUp' && (!input.value || historyAt >= 0) && sentHistory.length) {
      e.preventDefault();
      historyAt = Math.min(sentHistory.length - 1, historyAt + 1);
      input.value = sentHistory[historyAt];
    } else if (e.key === 'ArrowDown' && historyAt >= 0) {
      e.preventDefault();
      historyAt -= 1;
      input.value = historyAt >= 0 ? sentHistory[historyAt] : '';
    }
  });

  window.nebula.onChatGlobal?.((g) => {
    const before = new Set((state.messages || []).map((m) => m.id));
    state = g;
    if (g.blocked || g.muted) {
      lastBlocked = { reason: g.error || "Message not sent. It breaks the chat rules.", at: Date.now() };
      showToast(g.muted ? 'Muted in live chat' : 'Message not sent', escapeHtml(g.muted ? g.error : 'It breaks the SolarClient live chat rules.'), 'error');
    } else if (g.error) showToast('Live chat', escapeHtml(g.error), 'error');
    if (betaLayoutOn() && before.size) {
      const pings = (g.messages || []).filter((m) => !before.has(m.id) && m.from !== g.selfId
        && scMentionsMe(scParseReply(m.text)?.body || m.text));
      if (pings.length) {
        if (!isOpen() || document.hidden) scPing();
        if (!isOpen()) {
          lcMentions += pings.length;
          badge.textContent = lcMentions > 9 ? '9+' : `@${lcMentions}`;
          badge.classList.remove('hidden');
          const m = pings[pings.length - 1];
          showToast(`${m.name || 'Someone'} mentioned you`, escapeHtml((scParseReply(m.text)?.body || m.text).slice(0, 120)), 'info');
        }
      }
    }
    if (isOpen()) render();
  });
  window.nebula.chatState?.().then((g) => { if (g) { state = g; if (isOpen()) render(); } }).catch(() => {});
})();

(function wireUpdateSystem() {
  const modal = document.getElementById('update-modal');
  const titleEl = document.getElementById('update-title');
  const notesEl = document.getElementById('update-notes');
  const errEl = document.getElementById('update-error');
  const fromEl = document.getElementById('update-from');
  const toEl = document.getElementById('update-to');
  const channelBadge = document.getElementById('update-channel-badge');
  const policyBadge = document.getElementById('update-policy-badge');
  const primaryBtn = document.getElementById('update-primary');
  const secondaryBtn = document.getElementById('update-secondary');
  const progressWrap = document.getElementById('update-progress-wrap');
  const progressLabel = document.getElementById('update-progress-label');
  const progressFill = document.getElementById('update-progress-fill');
  const progressPct = document.getElementById('update-progress-pct');
  const progressBytes = document.getElementById('update-progress-bytes');
  const progressEta = document.getElementById('update-progress-eta');
  const notesWrap = document.getElementById('update-notes-wrap');
  const updateChip = document.getElementById('update-chip');
  const updatesMenu = document.getElementById('updates-menu');
  const updatesCheck = document.getElementById('updates-check');
  const stableMeta = document.getElementById('updates-stable-meta');
  const stableGo = document.getElementById('updates-stable-go');
  const betaMeta = document.getElementById('updates-beta-meta');
  const betaGo = document.getElementById('updates-beta-go');
  const switchStable = document.getElementById('updates-switch-stable');
  if (!modal || !primaryBtn || !secondaryBtn || !window.nebula?.onUpdateState) return;

  let lastState = null;
  let panelMode = 'offer'; // offer | ready | downloading
  let downloadWhich = 'stable';
  let popupShownFor = null;

  const fmtMB = (b) => `${(Math.max(0, b) / 1048576).toFixed(1)} MB`;
  function fmtEta(sec) {
    if (!sec || !Number.isFinite(sec)) return '';
    if (sec < 60) return `${Math.max(1, Math.round(sec))}s left`;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}m ${String(s).padStart(2, '0')}s left`;
  }
  function paintProgress(pct, state, { installing = false } = {}) {
    const n = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (progressWrap) {
      progressWrap.classList.remove('hidden');
      progressWrap.classList.toggle('installing', installing);
    }
    if (progressFill) progressFill.style.width = `${n}%`;
    const step = installing ? 'install' : (n >= 99 ? 'verify' : 'download');
    document.querySelectorAll('#update-steps .us').forEach((el) => {
      const order = ['download', 'verify', 'install'];
      const at = order.indexOf(step);
      const mine = order.indexOf(el.dataset.step);
      el.classList.toggle('on', el.dataset.step === step);
      el.classList.toggle('done', mine >= 0 && mine < at);
    });
    if (installing) {
      if (progressLabel) progressLabel.textContent = 'Installing update…';
      if (progressPct) progressPct.textContent = '';
      if (progressBytes) progressBytes.textContent = 'Launcher reopens';
      if (progressEta) progressEta.textContent = '';
      return;
    }
    if (progressLabel) progressLabel.textContent = n >= 99 ? 'Verifying download…' : 'Downloading SolarClient…';
    if (progressPct) progressPct.textContent = `${n}%`;
    const s = state || lastState || {};
    const total = Number(s.dlTotal) || Number(s.target?.size) || 0;
    const got = Number(s.dlBytes) || (total ? total * n / 100 : 0);
    if (progressBytes) {
      const speed = Number(s.dlSpeed) || 0;
      progressBytes.textContent = total
        ? `${fmtMB(got)} / ${fmtMB(total)}${speed ? ` · ${fmtMB(speed)}/s` : ''}`
        : (speed ? `${fmtMB(speed)}/s` : '');
    }
    if (progressEta) progressEta.textContent = n >= 99 ? '' : (fmtEta(Number(s.dlEta)) || 'Estimating…');
  }
  function notesToList(raw) {
    const text = String(raw || '').trim();
    if (!text) return [];
    let parts = text.split(/\r?\n+/);
    if (parts.length < 2) parts = text.split(/\s*;\s*|\s+\+\s+/);
    return parts
      .map((p) => p.replace(/^\s*(?:[-*•+]|\d+[.)])\s*/, '').trim())
      .filter(Boolean);
  }

  function showModal(mandatory) {
    modal.classList.toggle('mandatory', Boolean(mandatory));
    modal.classList.add('show');
  }
  function hideModal() {
    if (lastState?.mandatoryLock) return;
    modal.classList.remove('show');
  }
  function setError(msg) {
    if (!errEl) return;
    if (msg) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    else { errEl.textContent = ''; errEl.classList.add('hidden'); }
  }
  function fillOffer(state, entry) {
    const local = state.localVersion || '—';
    const target = entry?.version || '—';
    if (fromEl) fromEl.textContent = `v${local}`;
    if (toEl) toEl.textContent = `v${target}`;
    if (channelBadge) {
      channelBadge.textContent = entry?.channel || 'stable';
      channelBadge.classList.toggle('beta', entry?.channel === 'beta');
    }
    if (policyBadge) {
      const pol = entry?.policy || 'optional';
      policyBadge.textContent = pol;
      policyBadge.classList.remove('hidden');
      policyBadge.classList.toggle('mandatory', pol === 'mandatory');
    }
    if (notesEl) {
      const items = notesToList(entry?.notes);
      notesEl.innerHTML = '';
      for (const item of items) {
        const li = document.createElement('li');
        li.textContent = item;
        notesEl.appendChild(li);
      }
      notesWrap?.classList.toggle('hidden', !items.length);
    }
  }
  // Beta: a floating panel like Online / Live chat. Drag it by the header,
  // double-click the header to send it back under the button; it stays open until X.
  const UM_BOX = 'sc.updates.box';
  const umSaved = () => {
    try { const b = JSON.parse(localStorage.getItem(UM_BOX) || 'null'); return b && Number.isFinite(b.x) && Number.isFinite(b.y) ? b : null; } catch { return null; }
  };
  const umPlace = (x, y) => {
    const w = updatesMenu.offsetWidth || 340, h = updatesMenu.offsetHeight || 260;
    updatesMenu.style.left = `${Math.round(Math.max(8, Math.min(x, window.innerWidth - w - 8)))}px`;
    updatesMenu.style.top = `${Math.round(Math.max(40, Math.min(y, window.innerHeight - h - 8)))}px`;
  };
  const umSave = () => {
    const x = parseFloat(updatesMenu.style.left), y = parseFloat(updatesMenu.style.top);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const size = updatesMenu.classList.contains('um-sized') ? { w: updatesMenu.offsetWidth, h: updatesMenu.offsetHeight } : {};
    try { localStorage.setItem(UM_BOX, JSON.stringify({ x, y, ...size })); } catch { /* full */ }
  };
  // Never so narrow the buttons clip, never so short anything but the beta list gives way
  // (and that keeps at least a row of tiles).
  const UM_MIN_W = 310;
  const umMinH = () => {
    const list = updatesMenu.querySelector('#updates-beta-list');
    const shown = !!list && list.offsetParent !== null;
    const content = updatesMenu.scrollHeight + (updatesMenu.offsetHeight - updatesMenu.clientHeight);
    return content - (shown ? list.clientHeight - Math.min(list.scrollHeight, 100) : 0);
  };
  const umSize = (w, h) => {
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    updatesMenu.style.width = `${Math.round(Math.max(UM_MIN_W, Math.min(w, window.innerWidth - 16)))}px`;
    updatesMenu.classList.add('um-sized');
    updatesMenu.style.height = `${Math.round(Math.max(umMinH(), Math.min(h, window.innerHeight - 48)))}px`;
  };
  const umUnsize = () => {
    updatesMenu.classList.remove('um-sized');
    updatesMenu.style.width = '';
    updatesMenu.style.height = '';
  };
  const umFloat = updatesMenu ? scFloatAdd('updates', {
    panel: updatesMenu, host: updatesMenu, chip: updateChip, title: 'Updates',
    closeBtn: document.getElementById('updates-close'), btnClass: 'sc-hbtn',
    isOpen: () => !updatesMenu.classList.contains('hidden'),
    place: umPlace, save: umSave, restore: () => placeMenu(), close: () => closeMenu(),
  }) : null;

  function placeMenu() {
    if (!updatesMenu || !updateChip || updatesMenu.classList.contains('hidden')) return;
    const saved = betaLayoutOn() ? umSaved() : null;
    if (!betaLayoutOn()) umUnsize();
    if (saved) {
      if (Number.isFinite(saved.w)) umSize(saved.w, saved.h);
      umPlace(saved.x, saved.y);
      return;
    }
    const r = updateChip.getBoundingClientRect();
    const pad = 8;
    const width = Math.max(280, updatesMenu.offsetWidth || 280);
    let left = r.left;
    let top = r.bottom + pad;
    // Keep inside the viewport
    left = Math.min(left, window.innerWidth - width - 12);
    left = Math.max(12, left);
    const maxTop = window.innerHeight - (updatesMenu.offsetHeight || 200) - 12;
    top = Math.min(top, Math.max(12, maxTop));
    updatesMenu.style.left = `${Math.round(left)}px`;
    updatesMenu.style.top = `${Math.round(top)}px`;
  }

  function closeMenu() {
    if (!updatesMenu) return;
    if (umFloat?.win) { scDock('updates', { shut: true }); return; }
    umFloat?.glideAnim?.cancel();
    popClose(updatesMenu, () => updatesMenu.classList.add('hidden'));
    document.getElementById('updates-menu-wrap')?.classList.remove('open');
  }

  function openMenu() {
    if (!updatesMenu) return;
    // Portal out of .main.glass — backdrop-filter + overflow:hidden clip fixed kids.
    if (updatesMenu.parentElement !== document.body) {
      document.body.appendChild(updatesMenu);
    }
    updatesMenu.classList.remove('hidden');
    document.getElementById('updates-menu-wrap')?.classList.add('open');
    // Same frame it's shown: placed, painted and already popping, never a bare frame first.
    placeMenu();
    scFloatClear(updatesMenu);
    popDown(updatesMenu, updateChip);
    // Never show a stale "up to date" — re-check the feed every time it opens.
    if (!lastState?.downloading && !lastState?.installing && !lastState?.checking) {
      updatesCheck?.classList.add('spin');
      window.nebula.checkForUpdate?.().then((s) => { if (s) renderPanel(s); }).catch(() => {})
        .finally(() => updatesCheck?.classList.remove('spin'));
    }
    loadBetaList(false);
  }

  function toggleMenu() {
    if (updatesMenu?.classList.contains('hidden')) openMenu();
    else closeMenu();
  }

  // Looked up inside the panel so it still works while popped out into its own window.
  const um = (id) => updatesMenu?.querySelector(`#${id}`) || null;
  /** Only touch the DOM when it changed, so nothing restarts on every state tick. */
  const umSet = (el, html) => {
    if (!el || el._umHtml === html) return;
    el._umHtml = html;
    el.innerHTML = html;
  };
  /** '3.22.80-beta.37' → { base: '3.22.80', beta: 37 } */
  const umParse = (v) => {
    const m = /^(.*?)-beta\.(\d+)$/.exec(String(v || ''));
    return m ? { base: m[1], beta: Number(m[2]) } : { base: String(v || ''), beta: null };
  };
  const umDay = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(+d) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  };
  const umAgo = (iso) => {
    const t = iso ? Date.parse(iso) : NaN;
    if (Number.isNaN(t)) return '';
    const h = (Date.now() - t) / 3600000;
    if (h < 1) return 'Just now';
    if (h < 24) return `${Math.floor(h)}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? 'Yesterday' : d < 14 ? `${d}d ago` : umDay(iso);
  };
  const UM_TICK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  let umCheckedAt = 0;
  setInterval(() => { if (!updatesMenu?.classList.contains('hidden')) umWhen(); }, 30000);
  function umWhen() {
    const el = um('updates-when');
    if (!el) return;
    const s = umCheckedAt ? Math.round((Date.now() - umCheckedAt) / 1000) : -1;
    el.textContent = s < 0 ? '' : s < 45 ? 'Checked just now' : s < 3600 ? `Checked ${Math.round(s / 60)} min ago` : `Checked ${Math.round(s / 3600)} h ago`;
  }
  // Beta builds: your beta up top, then every beta, then stable with Switch.
  // Stable builds: your version up top, then every beta to try.
  let betaListData = null;
  let betaListLoading = false;
  function renderMenu(state) {
    const onBeta = state.localChannel === 'beta';
    const hasAny = Boolean(state.stableOffer || state.betaOffer || state.downloaded);
    updateChip?.classList.toggle('has-update', hasAny && !state.downloaded);
    if (!state.checking && state.localVersion) umCheckedAt = Date.now();
    umWhen();
    const here = umParse(state.localVersion);
    const cur = um('updates-current');
    if (cur) cur.textContent = state.localVersion ? `You're on ${onBeta ? 'beta' : 'stable'}` : 'Checking your version…';
    const chan = um('updates-chan');
    if (chan) chan.textContent = 'Installed';
    umSet(um('updates-ver'), state.localVersion
      ? `<b>${escapeHtml(here.base)}</b>${here.beta != null ? `<span class="um-tag beta"><small>Beta</small><i>${here.beta}</i></span>` : '<span class="um-tag"><small>Stable</small></span>'}`
      : '<b>—</b>');

    const stable = state.stableOffer;
    const beta = state.betaOffer;
    const offer = onBeta ? beta : stable;
    let kind = 'ok', line = onBeta ? "You're on the newest beta" : "You're up to date";
    if (!state.localVersion) { kind = 'idle'; line = 'Checking for updates…'; }
    else if (offer) {
      const o = umParse(offer.version);
      kind = 'new';
      line = onBeta
        ? `Beta ${o.beta ?? offer.version} is ready`
        : `${offer.version} is ${offer.policy === 'mandatory' ? 'required' : 'ready'}`;
    }
    const status = um('updates-status');
    if (status) {
      status.className = `um-status ${kind}`;
      umSet(status, `<i>${kind === 'ok' ? UM_TICK : ''}</i><span>${escapeHtml(line)}</span>`);
    }
    if (stableGo) {
      stableGo.classList.toggle('hidden', onBeta || !stable);
      stableGo.textContent = stable?.policy === 'mandatory' ? 'Update now' : 'Update';
    }
    betaGo?.classList.toggle('hidden', !onBeta || !beta);

    const stableRow = um('updates-stable-row');
    stableRow?.classList.toggle('hidden', !onBeta);
    const stableLatest = state.stableLatest;
    umSet(stableMeta, stableLatest
      ? `<b>${escapeHtml(stableLatest.version)}</b><small>Newest stable release</small>`
      : '<b>No stable version yet</b><small>Check back later</small>');
    switchStable?.classList.toggle('hidden', !onBeta || !stableLatest);

    const betaLabel = um('updates-beta-label');
    if (betaLabel) betaLabel.textContent = onBeta ? 'Beta builds' : 'Try a beta';
    renderBetaList();
  }
  function renderBetaList() {
    const host = um('updates-beta-list');
    if (!host || !betaMeta) return;
    const onBeta = lastState?.localChannel === 'beta';
    const items = betaListData?.betas || [];
    const count = um('updates-beta-count');
    if (count) count.textContent = items.length ? String(items.length) : '';
    let hint = '';
    if (!betaListData) hint = 'Loading betas…';
    else if (!items.length) hint = 'No beta versions right now';
    else if (!onBeta) hint = 'Early builds with new stuff in them. You can switch back to stable any time.';
    betaMeta.textContent = hint;
    betaMeta.classList.toggle('hidden', !hint);
    if (!items.length) { host.classList.add('hidden'); return; }
    const mine = onBeta ? lastState?.localVersion || '' : '';
    // One tile per beta: its name, when it came out, Install and About (what's in it).
    umSet(host, items.map((b, i) => {
      const v = umParse(b.version);
      const name = v.beta != null ? `Beta ${v.beta}` : b.version;
      const isMine = b.version === mine;
      return `<div class="um-t${isMine ? ' mine' : ''}">
        <div class="um-t-name"><b>${escapeHtml(name)}</b>${!isMine && i === 0 ? '<i class="um-pill">New</i>' : ''}</div>
        <small>${escapeHtml(umAgo(b.publishedAt) || v.base)}</small>
        <div class="um-t-btns">
          ${isMine ? '<span class="um-t-on" title="Installed — you\'re on this build">In use</span>' : `<button type="button" class="um-get um-beta-go" data-v="${escapeHtml(b.version)}">Install</button>`}
          <button type="button" class="um-about" data-v="${escapeHtml(b.version)}">About</button>
        </div>
      </div>`;
    }).join(''));
    host.classList.remove('hidden');
  }
  async function loadBetaList(force) {
    if (betaListLoading || !window.nebula.listBetas) return;
    betaListLoading = true;
    try {
      betaListData = await window.nebula.listBetas(Boolean(force));
    } catch {
      betaListData = { betas: [] };
    } finally {
      betaListLoading = false;
    }
    if (lastState) renderBetaList();
  }
  let noteTimer = null;
  function setNote(text) {
    const note = um('updates-note');
    if (!note) return;
    clearTimeout(noteTimer);
    note.textContent = text || '';
    note.classList.toggle('on', Boolean(text));
    if (text) noteTimer = setTimeout(() => note.classList.remove('on'), 2600);
  }

  function renderPanel(state) {
    lastState = state;
    setError(state.error);
    renderMenu(state);

    if (state.downloaded && state.target) {
      panelMode = 'ready';
      fillOffer(state, state.target);
      if (titleEl) titleEl.textContent = state.installing ? 'Installing update' : 'Update ready';
      paintProgress(99, state, { installing: true });
      primaryBtn.textContent = state.installing ? 'Installing…' : 'Install & restart';
      primaryBtn.disabled = true;
      secondaryBtn.classList.add('hidden');
      showModal(true);
      return;
    }

    if (state.downloading) {
      panelMode = 'downloading';
      fillOffer(state, state.target || state.stableOffer || state.betaOffer);
      if (titleEl) titleEl.textContent = 'Downloading update';
      paintProgress(state.progress || 0, state);
      primaryBtn.textContent = 'Downloading…';
      primaryBtn.disabled = true;
      secondaryBtn.classList.add('hidden');
      showModal(true);
      return;
    }

    if (progressWrap && !state.downloading && !state.installing) {
      progressWrap.classList.add('hidden');
    }

    if (state.installing) {
      panelMode = 'downloading';
      if (titleEl) titleEl.textContent = 'Installing update';
      paintProgress(0, state, { installing: true });
      primaryBtn.textContent = 'Installing…';
      primaryBtn.disabled = true;
      secondaryBtn.classList.add('hidden');
      showModal(true);
      return;
    }

    // Auto-popup ONLY for stable updates — never for beta-only.
    const stable = state.stableOffer;
    if (stable && state.popupStable) {
      const key = `stable:${stable.version}`;
      if (popupShownFor !== key || state.mandatoryLock) {
        popupShownFor = key;
        panelMode = 'offer';
        downloadWhich = 'stable';
        fillOffer(state, stable);
        const isMandatory = stable.policy === 'mandatory';
        if (titleEl) titleEl.textContent = isMandatory ? 'Update required' : 'Update available';
        primaryBtn.textContent = 'Update';
        primaryBtn.disabled = false;
        secondaryBtn.textContent = 'Not now';
        secondaryBtn.disabled = isMandatory;
        secondaryBtn.classList.toggle('hidden', isMandatory);
        // Always auto-popup for stable (optional + mandatory). Beta never reaches here.
        showModal(isMandatory);
      }
      return;
    }

    if (!state.mandatoryLock && !state.downloading && !state.downloaded) {
      // Don't force-hide if user opened it; only auto-hide when nothing to show.
      if (!stable) hideModal();
    }
  }

  window.nebula.onUpdateState((state) => renderPanel(state || {}));

  window.nebula.onUpdateProgress?.((pct) => {
    if (lastState?.installing || lastState?.downloaded) return;
    paintProgress(pct, lastState);
  });

  updateChip?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.getElementById('updates-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
  });
  const umHead = updatesMenu?.querySelector('.um-head');
  umHead?.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || !umFloat || umFloat.win) return;
    e.preventDefault();
    const r = updatesMenu.getBoundingClientRect();
    const gx = e.clientX - r.left, gy = e.clientY - r.top;
    updatesMenu.classList.add('dragging');
    const move = scPerFrame((ev) => {
      umPlace(ev.clientX - gx, ev.clientY - gy);
      scFloatDrag(umFloat, ev, { x: ev.clientX - gx, y: ev.clientY - gy, w: r.width, h: r.height });
    });
    const up = (ev) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      move.flush?.();
      updatesMenu.classList.remove('dragging');
      umSave();
      scFloatDrop(umFloat, ev, { x: gx, y: gy });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  umHead?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button') || umFloat?.win) return;
    try { localStorage.removeItem(UM_BOX); } catch { /* ignore */ }
    umUnsize();
    placeMenu();
    scFloatClear(updatesMenu);
  });
  updatesMenu?.querySelectorAll('.um-rz').forEach((grip) => grip.addEventListener('mousedown', (e) => {
    if (!betaLayoutOn() || umFloat?.win) return;
    scResize(e, grip, {
      f: umFloat, panel: updatesMenu, minW: UM_MIN_W, minH: umMinH, save: umSave,
      prep: (r) => {
        updatesMenu.style.width = `${r.width}px`;
        updatesMenu.style.height = `${r.height}px`;
        updatesMenu.classList.add('um-sized');
      },
    });
  }));
  window.addEventListener('resize', () => { if (!umFloat?.win) placeMenu(); });
  // Opening or growing on its own clears space; a corner drag makes room itself as it goes.
  if (updatesMenu) new ResizeObserver(() => { if (!umFloat?.win && !updatesMenu.classList.contains('hidden') && !updatesMenu.classList.contains('resizing')) scFloatClear(updatesMenu); }).observe(updatesMenu);
  // Launchpad scrolls inside .view — keep the fixed menu under the chip.
  document.querySelectorAll('.view').forEach((v) => {
    v.addEventListener('scroll', () => { if (!umFloat?.win) placeMenu(); }, { passive: true });
  });

  updatesCheck?.addEventListener('click', async () => {
    if (updatesCheck.classList.contains('spin')) return;
    updatesCheck.classList.add('spin');
    setNote('');
    const started = Date.now();
    try {
      const s = await window.nebula.checkForUpdate();
      await loadBetaList(true);
      // Let the spin read as a check even when the answer is instant.
      await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
      renderPanel(s || {});
      const hasStable = Boolean(s?.stableOffer);
      const hasBeta = Boolean(s?.betaOffer);
      if (!hasStable && !hasBeta) {
        setNote("Checked just now · you're all set");
      } else {
        setNote(hasStable ? 'A new version is ready' : 'A new beta is ready');
        if (hasStable) {
          downloadWhich = 'stable';
          fillOffer(s, s.stableOffer);
          showModal(s.stableOffer.policy === 'mandatory');
        }
      }
    } catch (e) {
      setNote(e?.message || 'Check failed, try again');
    } finally {
      updatesCheck.classList.remove('spin');
    }
  });

  stableGo?.addEventListener('click', async () => {
    closeMenu();
    downloadWhich = 'stable';
    const entry = lastState?.stableOffer;
    if (entry) {
      panelMode = 'downloading';
      fillOffer(lastState, entry);
      if (titleEl) titleEl.textContent = 'Downloading update';
      paintProgress(0, lastState);
      showModal(true);
    }
    window.nebula.downloadUpdate('stable');
  });

  betaGo?.addEventListener('click', async () => {
    closeMenu();
    downloadWhich = 'beta';
    const entry = lastState?.betaOffer;
    if (entry) fillOffer(lastState, entry);
    if (titleEl) titleEl.textContent = 'Downloading update';
    paintProgress(0, lastState);
    panelMode = 'downloading';
    showModal(true);
    window.nebula.downloadUpdate('beta');
  });

  const aboutSheet = document.getElementById('updates-about');
  function showAbout(version) {
    const b = betaListData?.betas?.find((x) => x.version === version);
    if (!b || !aboutSheet) return;
    const v = umParse(b.version);
    um('updates-about-name').textContent = v.beta != null ? `Beta ${v.beta}` : b.version;
    um('updates-about-when').textContent = [v.base, umDay(b.publishedAt)].filter(Boolean).join(' · ');
    um('updates-about-text').textContent = b.summary || 'No notes for this build.';
    const go = um('updates-about-go');
    go.dataset.v = b.version;
    go.classList.toggle('hidden', b.version === lastState?.localVersion);
    um('updates-about-text').scrollTop = 0;
    aboutSheet.classList.remove('hidden');
    updatesMenu.classList.add('um-about-on');
  }
  const hideAbout = () => {
    aboutSheet?.classList.add('hidden');
    updatesMenu?.classList.remove('um-about-on');
  };
  document.getElementById('updates-about-back')?.addEventListener('click', hideAbout);
  updateChip?.addEventListener('click', hideAbout);
  const onBetaPick = (e) => {
    const about = e.target.closest('.um-about');
    if (about) { showAbout(about.dataset.v); return; }
    const btn = e.target.closest('.um-beta-go');
    if (!btn?.dataset.v) return;
    const version = btn.dataset.v;
    hideAbout();
    closeMenu();
    downloadWhich = 'beta';
    fillOffer(lastState || {}, { version, channel: 'beta', policy: 'optional', notes: '' });
    if (titleEl) titleEl.textContent = 'Downloading update';
    paintProgress(0, lastState);
    panelMode = 'downloading';
    showModal(true);
    window.nebula.installBeta(version);
  };
  document.getElementById('updates-beta-list')?.addEventListener('click', onBetaPick);
  aboutSheet?.addEventListener('click', onBetaPick);

  switchStable?.addEventListener('click', async () => {
    closeMenu();
    await window.nebula.switchToStable();
  });

  primaryBtn.addEventListener('click', async () => {
    primaryBtn.disabled = true;
    try {
      if (panelMode === 'ready') {
        await window.nebula.restartToApplyUpdate();
        return;
      }
      // Show the bar immediately — don't wait for the first progress tick.
      paintProgress(0, lastState);
      if (titleEl) titleEl.textContent = 'Downloading update';
      panelMode = 'downloading';
      showModal(true);
      // Fire-and-forget — progress comes via onUpdateProgress / onUpdateState
      window.nebula.downloadUpdate(downloadWhich || 'stable');
    } catch (e) {
      setError(e?.message || String(e));
      primaryBtn.disabled = false;
    }
  });

  secondaryBtn.addEventListener('click', async () => {
    if (lastState?.mandatoryLock) return;
    await window.nebula.dismissUpdate?.();
    // Match the stable:VER key used by the auto-popup gate so we don't reopen.
    popupShownFor = lastState?.stableOffer ? `stable:${lastState.stableOffer.version}` : popupShownFor;
    hideModal();
  });

  window.nebula.getUpdateState?.().then((s) => { if (s) renderPanel(s); }).catch(() => {});
})();
// --- WHAT'S NEW MODAL LOGIC ---
async function checkWhatsNew() {
  const modal = document.getElementById('whatsnew-modal');
  const closeBtn = document.getElementById('whatsnew-close');
  if (!modal || !closeBtn) return;
  
  closeBtn.addEventListener('click', () => {
    modal.classList.remove('show');
  });

  try {
    const version = await window.nebula.getAppVersion();
    const hasSeen = localStorage.getItem('hasSeenWhatsNew');
    
    // Only show if we haven't seen the What's New modal ever
    if (!hasSeen) {
      document.getElementById('whatsnew-version').textContent = version;
      const contentEl = document.getElementById('whatsnew-content');
      
      try {
        const res = await fetch('https://api.github.com/repos/sharktoothgaming56-maker/solarclientsite/releases/tags/v' + version);
        if (res.ok) {
           const release = await res.json();
           // Basic markdown to HTML conversion for the body
           let body = release.body || 'No release notes available.';
           body = body.replace(/### (.*?)\n/g, '<h3>$1</h3>\n');
           body = body.replace(/## (.*?)\n/g, '<h2>$1</h2>\n');
           body = body.replace(/# (.*?)\n/g, '<h1>$1</h1>\n');
           body = body.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
           body = body.replace(/\*(.*?)\*/g, '<i>$1</i>');
           body = body.replace(/- (.*?)\n/g, '<li>$1</li>\n');
           body = body.replace(/\n/g, '<br>');
           contentEl.innerHTML = body;
        } else {
           contentEl.innerHTML = '<ul><li>Added a new "What\'s New" screen!</li><li>Fixed bugs and improved performance.</li></ul>';
        }
      } catch (err) {
        contentEl.innerHTML = '<ul><li>Added a new "What\'s New" screen!</li><li>Fixed bugs and improved performance.</li></ul>';
      }
      
      modal.classList.add('show');
      localStorage.setItem('hasSeenWhatsNew', 'true');
    }
  } catch (err) {
    console.error('WhatsNew error:', err);
  }
}
setTimeout(checkWhatsNew, 1500);

// =====================================================================
// LIQUID GLASS — cursor-reactive tilt
//
// CSS handles the drifting specular, the refracted edges and the hover
// sweep. The one thing CSS cannot do is respond to WHERE the cursor is,
// and that is what sells the surface as a physical object rather than a
// panel that happens to animate: the highlight and the tilt both track
// the pointer, so moving across the button feels like moving a light
// over glass.
//
// Everything is written to CSS custom properties and applied via
// transform, so it stays on the compositor and never triggers layout.
// One rAF frame is coalesced per element to avoid doing work per
// mousemove event.
// =====================================================================
(function liquidGlassTilt() {
  // Interactive launchpad controls ONLY — never tilt shells/panels/boxes
  // (tilting .main / settings groups was wrecking the shared liquid-glass look).
  const SELECTOR = '.launch-btn.liquid-glass, .chip.liquid-glass, .level-card.liquid-glass, .edition-switch.liquid-glass, .bedrock-launch.liquid-glass, .launch-another.liquid-glass, .monitor-chip.liquid-glass';
  const MAX_TILT = 5;          // degrees — subtle, physical glass tilt

  // -------------------------------------------------------------------
  // PERF: this used to call el.getBoundingClientRect() inside the raw
  // mousemove handler. getBoundingClientRect() is a forced synchronous
  // layout -- it makes Blink stop, flush every pending style change and
  // re-lay-out the document before it can answer. A gaming mouse at 1000Hz
  // therefore triggered up to a thousand full-document layouts per second,
  // on a document that at the time had ~40 backdrop-filter layers hanging
  // off it. Moving the pointer anywhere near a button stalled the UI.
  //
  // Three changes:
  //   1. The rect is measured ONCE when the pointer enters an element and
  //      cached. A button does not move while you are hovering it.
  //   2. The cache is dropped on scroll/resize/view-change, which are the
  //      only things that can invalidate it.
  //   3. The handler itself is rAF-gated, so N events between two frames
  //      collapse into one write. Nothing is read during the frame at all.
  // -------------------------------------------------------------------
  let hovered = null;          // currently hovered element
  let rect = null;             // its cached bounding box
  let lastX = 0, lastY = 0;
  let queued = false;

  function invalidate() { rect = null; }
  window.addEventListener('resize', invalidate, { passive: true });
  window.addEventListener('scroll', invalidate, { passive: true, capture: true });

  function apply() {
    queued = false;
    if (!hovered || !rect) return;

    const px = ((lastX - rect.left) / rect.width) * 100;
    const py = ((lastY - rect.top) / rect.height) * 100;

    // Centre-relative, so the tilt is away from the cursor on one axis
    // and toward it on the other -- the way a real panel pivots.
    const rx = ((50 - py) / 50) * MAX_TILT;
    const ry = ((px - 50) / 50) * MAX_TILT;

    hovered.style.transform =
      `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateY(-3px)`;
    hovered.style.setProperty('--mx', `${px.toFixed(1)}%`);
    hovered.style.setProperty('--my', `${py.toFixed(1)}%`);
  }

  function release(el) {
    if (!el) return;
    // Clearing the inline transform hands control back to the stylesheet,
    // so the element eases home on its own transition rather than snapping.
    el.style.transform = '';
    el.style.removeProperty('--mx');
    el.style.removeProperty('--my');
  }

  // pointermove coalesces natively in Chromium (one event per frame from a
  // high-polling-rate device) where mousemove does not, so this alone cuts
  // the event count by an order of magnitude before our own gate even runs.
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (document.body.classList.contains('no-anim')) return;

    const el = e.target.closest && e.target.closest(SELECTOR);

    if (el !== hovered) {
      release(hovered);
      hovered = el;
      // The ONE read, and only when the target actually changed.
      rect = el ? el.getBoundingClientRect() : null;
      if (rect && (!rect.width || !rect.height)) { hovered = null; rect = null; }
    }
    if (!hovered) return;

    lastX = e.clientX;
    lastY = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(apply); }
  }, { passive: true });

  document.addEventListener('pointerleave', () => {
    release(hovered); hovered = null; rect = null;
  }, { passive: true, capture: true });
})();

// =====================================================================
// ADAPTIVE QUALITY GOVERNOR
//
// A launcher runs on everything from a gaming rig to a school laptop with
// Intel UHD graphics, and "glass" effects are exactly the kind of thing
// that is free on one and ruinous on the other. Rather than picking one
// setting and hoping, measure what this machine can actually sustain and
// step the effects down until the window is smooth.
//
// The measurement is deliberately cheap: a rAF that only reads
// performance.now() and counts. It never touches the DOM, so it cannot
// itself be the cause of the jank it is looking for.
//
// Three tiers:
//   full  - everything on (default)
//   lite  - shell blur dropped, nebula hidden, transitions shortened
//   plain - static background, no ambient animation at all
// It only ever steps DOWN automatically; stepping back up is the user's
// call, so the UI never oscillates between tiers while you watch it.
// =====================================================================
(function qualityGovernor() {
  // Honour an explicit user choice -- if they have turned low graphics on
  // themselves, we are not going to second-guess them in either direction.
  if (theme.lowGraphics) return;
  // Liquid glass is a first-class launcher material. Do not auto-kill refraction
  // or force frost — that made the look change without the user asking.
  // Lightweight graphics stays available in Customize.
  return;

  const SAMPLE_MS   = 4000;
  const JANK_MS     = 32;
  const JANK_RATIO  = 0.28;
  const GRACE_MS    = 6000;

  let frames = 0, janky = 0, windowStart = 0, tier = 0, done = false;
  const TIERS = ['full', 'lite', 'plain'];

  function stepDown() {
    if (window.__governorOverridden) { done = true; return; }
    tier++;
    if (tier === 1) {
      document.body.classList.add('perf-lite');
      theme.lowGraphics = true;
      saveTheme();
      showToast(
        'Graphics tuned down',
        'This machine was dropping frames on the glass effects, so they are off. Turn them back on in Customize.',
        'info',
      );
    } else if (tier >= 2) {
      document.body.classList.add('no-anim');
      theme.animations = false;
      theme.particles = false;
      saveTheme();
      applyTheme();
      done = true;
    }
    frames = 0; janky = 0; windowStart = 0;
  }

  // A rAF loop keeps Chromium producing frames at the monitor's refresh rate
  // for as long as it runs, so it only runs while the launcher is the
  // focused window and no game is open; focus restarts it.
  let lastT = 0, rafId = 0;
  const idle = () => document.hidden || !document.hasFocus() || document.body.classList.contains('game-running');
  function tick(t) {
    rafId = 0;
    if (done) return;
    if (idle()) { frames = 0; janky = 0; windowStart = 0; return; }
    rafId = requestAnimationFrame(tick);

    if (t < GRACE_MS) { lastT = t; return; }
    if (!windowStart) { windowStart = t; lastT = t; return; }

    const dt = t - lastT;
    lastT = t;
    if (dt > 500) { frames = 0; janky = 0; windowStart = t; return; }

    frames++;
    if (dt > JANK_MS) janky++;

    if (t - windowStart >= SAMPLE_MS) {
      if (frames > 40 && janky / frames > JANK_RATIO && tier < TIERS.length - 1) {
        stepDown();
      } else {
        frames = 0; janky = 0; windowStart = t;
      }
    }
  }
  const wake = () => { if (!done && !rafId && !idle()) rafId = requestAnimationFrame(tick); };
  window.addEventListener('focus', wake);
  document.addEventListener('visibilitychange', wake);
  window.nebula.onGameMode(() => setTimeout(wake, 0));
  rafId = requestAnimationFrame(tick);
})();

// =====================================================================
// IDLE-TIME WARM-UP
//
// The perceived cost of opening a tab is almost never the rendering -- it
// is the first network round trip that tab needs. requestIdleCallback runs
// this only once the main thread has actually gone quiet after first paint,
// so nothing here can delay the window appearing or the user's first click.
// =====================================================================
(function warmCaches() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(() => fn({ timeRemaining: () => 8 }), 1200));
  idle(() => {
    // Pull the two lists every user hits within seconds of opening the app,
    // so switching to Versions or Content is already-have-it instant.
    try { window.nebula.listVersions?.().catch(() => {}); } catch { /* not exposed */ }
    try { window.nebula.listInstances?.().catch(() => {}); } catch { /* not exposed */ }
  });
})();


// =====================================================================
// VERSION DISPLAY
// The running build's version, sourced from app.getVersion() in the main
// process (which reads it from package.json) rather than hard-coded here --
// so it can never drift out of sync with what was actually packaged.
// =====================================================================
(async function showVersion() {
  try {
    const v = await window.nebula.getAppVersion();
    const tb = document.getElementById('titlebar-version');
    if (tb) {
      const m = /^(.*?)-beta\.(\d+)$/.exec(v);
      tb.innerHTML = m
        ? `<span class="tv-num">v${escapeHtml(m[1])}</span><span class="tv-beta">Beta ${escapeHtml(m[2])}</span>`
        : `<span class="tv-num">v${escapeHtml(v)}</span>`;
      tb.title = `SolarClient v${v}`;
    }
    const ab = document.getElementById('about-version');
    if (ab) ab.textContent = v;
    document.title = `SolarClient ${v}`;
  } catch { /* main process not answering; leave the placeholders */ }

  const el = document.getElementById('about-electron');
  // versions is exposed by preload where available; harmless if it is not.
  if (el) el.textContent = (window.nebula.runtimeVersions && window.nebula.runtimeVersions.electron)
    ? 'Electron ' + window.nebula.runtimeVersions.electron
    : '—';
})();

(() => {
  const chip = document.getElementById('lb-chip');
  const menu = document.getElementById('lb-menu');
  const list = document.getElementById('lb-list');
  const closeBtn = document.getElementById('lb-close');
  if (!chip || !menu || !list || document.body.classList.contains('beta-layout')) return;

  function place() {
    const r = chip.getBoundingClientRect();
    const width = menu.offsetWidth || 340;
    let left = Math.min(r.left, window.innerWidth - width - 12);
    left = Math.max(12, left);
    let top = r.bottom + 8;
    const maxTop = window.innerHeight - (menu.offsetHeight || 200) - 12;
    top = Math.min(top, Math.max(12, maxTop));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function paint(data) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    list.replaceChildren();
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'lb-empty';
      empty.textContent = 'No rankings yet.';
      list.appendChild(empty);
      return;
    }
    const you = String(data.you || '');
    for (const row of rows) {
      const el = document.createElement('div');
      el.className = 'lb-row' + (row.id && row.id === you ? ' you' : '');
      const rank = document.createElement('div');
      rank.className = 'lb-rank';
      rank.textContent = String(row.rank || '');
      const who = document.createElement('div');
      who.className = 'lb-who';
      const name = document.createElement('b');
      name.textContent = String(row.name || 'Player');
      const time = document.createElement('span');
      time.textContent = fmtMins(Number(row.minutes) || 0) + ' played';
      who.append(name, time);
      const lvl = document.createElement('div');
      lvl.className = 'lb-lvl';
      lvl.textContent = 'Level ' + (Number(row.level) || 1);
      const ore = document.createElement('span');
      const oreInfo = oreForLevel(Number(row.level) || 1);
      ore.textContent = oreInfo && oreInfo.name ? oreInfo.name : '';
      lvl.appendChild(ore);
      el.append(rank, who, lvl);
      list.appendChild(el);
    }
  }

  async function load() {
    list.replaceChildren();
    const waiting = document.createElement('div');
    waiting.className = 'lb-empty';
    waiting.textContent = 'Loading rankings…';
    list.appendChild(waiting);
    try {
      paint(await window.nebula.leaderboard());
    } catch {
      list.replaceChildren();
      const err = document.createElement('div');
      err.className = 'lb-empty';
      err.textContent = 'Leaderboards are unavailable right now.';
      list.appendChild(err);
    }
    place();
  }

  function open() {
    if (menu.parentElement !== document.body) document.body.appendChild(menu);
    menu.classList.remove('hidden');
    document.getElementById('lb-wrap')?.classList.add('open');
    place();
    load();
  }

  function close() {
    menu.classList.add('hidden');
    document.getElementById('lb-wrap')?.classList.remove('open');
  }

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });
  closeBtn?.addEventListener('click', (e) => { e.stopPropagation(); close(); });
  document.addEventListener('mousedown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target === chip || chip.contains(e.target) || menu.contains(e.target)) return;
    close();
  });
  window.addEventListener('resize', () => { if (!menu.classList.contains('hidden')) place(); });
})();
