// =====================================================================
// GAME MONITOR — one window per launch. Live console with filtering,
// CPU/RAM of the actual game process (sampled by the main process),
// uptime, launch progress, FPS when the game reports it in its log,
// and a Stop button that kills the process tree.
// =====================================================================
const params = new URLSearchParams(location.search);
const launchId = params.get('launchId');
const instanceName = params.get('instance') || 'Instance';
const accountName = params.get('account') || '';

document.getElementById('win-min').addEventListener('click', () => window.nebula.minimize());
document.getElementById('win-max').addEventListener('click', () => window.nebula.maximize());
document.getElementById('win-close').addEventListener('click', () => window.nebula.closeWindow());

document.getElementById('mon-title').textContent = instanceName;
document.getElementById('mon-sub').textContent = accountName ? `Playing as ${accountName}` : '';
document.title = `${instanceName} — SolarClient Monitor`;

// Apply launcher Customize → Monitor background (or sync with launcher bg).
function applyMonitorBackground() {
  try {
    const theme = JSON.parse(localStorage.getItem('nebula-theme') || '{}');
    const sync = theme.monBgSync !== false;
    const bgId = sync ? (theme.bg || 'nebula') : (theme.monBg || theme.bg || 'nebula');
    let scene = document.getElementById('bg-scene');
    if (!scene) {
      scene = document.createElement('div');
      scene.id = 'bg-scene';
      scene.className = 'bg-scene';
      document.querySelector('.bg-stack')?.appendChild(scene);
    }

    if (bgId === 'custom' && theme.customBgUrl) {
      document.body.dataset.bgKind = 'scene';
      scene.style.backgroundImage = `url("${theme.customBgUrl}")`;
      scene.style.backgroundSize = 'cover';
      scene.style.imageRendering = 'auto';
      scene.style.backgroundPosition = `${theme.customBgPosX ?? 50}% ${theme.customBgPosY ?? 50}%`;
      scene.classList.add('show');
      return;
    }

    const bg = window.NEBULA_BACKGROUNDS?.[bgId];
    const kind = bg?.kind || (bgId === 'void' ? 'void' : (bgId === 'nebula' ? 'nebula' : 'scene'));
    document.body.dataset.bgKind = kind;

    if (kind === 'scene' && typeof bg?.make === 'function') {
      scene.style.backgroundImage = bg.make();
      scene.style.backgroundSize = '';
      scene.style.imageRendering = 'pixelated';
      scene.style.backgroundPosition = '';
      scene.classList.add('show');
      return;
    }

    // nebula / void — CSS body[data-bg-kind] paints; hide scene layer
    scene.classList.remove('show');
    scene.style.backgroundImage = '';
  } catch { /* keep default nebula */ }
}
window.applyMonitorBackground = applyMonitorBackground;
applyMonitorBackground();

window.addEventListener('storage', (e) => {
  if (e.key === 'nebula-theme') applyMonitorBackground();
});
window.nebula?.onThemeChanged?.(() => applyMonitorBackground());
// Re-apply once backgrounds.js finishes loading (scene presets need .make()).
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(applyMonitorBackground, 50);
  setTimeout(applyMonitorBackground, 400);
});

// ---------- tiny ambient starfield ----------
(function () {
  const canvas = document.getElementById('starfield');
  const ctx = canvas.getContext('2d');
  let stars = [], w = 0, h = 0;
  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
    stars = Array.from({ length: Math.floor((w * h) / 14000) }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.2 + 0.3,
      p: Math.random() * Math.PI * 2, s: 0.4 + Math.random(),
    }));
  }
  window.addEventListener('resize', resize);
  resize();
  // PERF: this looped forever, full-screen-clearing and repainting behind a
  // console that is usually streaming hundreds of lines a second. It now
  // stops whenever the monitor window is not actually being looked at, which
  // is most of the time -- you open it, glance, and alt-tab into the game.
  let last = 0, raf = 0, alive = false;
  function frame(t) {
    if (!alive) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
    if (t - last < 100) return;   // ambience; 10fps is plenty
    last = t;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    for (const s of stars) {
      ctx.globalAlpha = 0.2 + 0.5 * Math.abs(Math.sin(t / 1200 * s.s + s.p));
      ctx.fillRect(s.x, s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }
  function start() { if (alive || document.hidden) return; alive = true; if (!raf) raf = requestAnimationFrame(frame); }
  function stop() { alive = false; if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  window.addEventListener('blur', stop);
  window.addEventListener('focus', start);
  start();
})();

// ---------- console ----------
const consoleEl = document.getElementById('mon-console');
const filterEl = document.getElementById('mon-filter');
let autoscroll = true;
let closed = false;
const MAX_LINES = 900;

function matchesFilter(text) {
  const q = filterEl.value.trim().toLowerCase();
  return !q || text.toLowerCase().includes(q);
}

// =====================================================================
// PERF: addLine used to append one node and then read scrollHeight and
// write scrollTop -- per line. Reading scrollHeight is a forced synchronous
// layout, so every line Minecraft printed made Blink re-lay-out the whole
// console. Minecraft prints several hundred lines in the first few seconds
// of a modded launch, so the monitor window locked solid exactly when you
// most wanted to read it.
//
// Lines are now buffered and flushed once per animation frame: one
// DocumentFragment insert, one trim, one scroll write, no matter whether
// 1 or 600 lines arrived in that frame.
// =====================================================================
let lineQueue = [];
let flushQueued = false;

function flushLines() {
  flushQueued = false;
  if (!lineQueue.length) return;

  const batch = lineQueue;
  lineQueue = [];

  // Building into a fragment means the live tree is touched exactly once,
  // so layout runs once instead of once per line.
  const frag = document.createDocumentFragment();
  const q = filterEl.value.trim().toLowerCase();
  for (const { line, level } of batch) {
    const div = document.createElement('div');
    div.className = `lvl-${level}`;
    div.textContent = line;
    if (q && !line.toLowerCase().includes(q)) div.classList.add('line-hidden');
    frag.appendChild(div);
  }
  consoleEl.appendChild(frag);

  // removeChild in a loop is O(n) relayouts; when a burst blows well past
  // the cap, drop the excess in one pass instead.
  const over = consoleEl.childElementCount - MAX_LINES;
  if (over > 0) {
    if (over > 50) {
      const keep = Array.prototype.slice.call(consoleEl.children, over);
      consoleEl.replaceChildren(...keep);
    } else {
      for (let i = 0; i < over; i++) consoleEl.removeChild(consoleEl.firstChild);
    }
  }

  // The one scroll write per frame. scrollTop to a deliberately huge value
  // is clamped by the engine to the maximum, which avoids having to READ
  // scrollHeight at all -- so this no longer forces a layout flush.
  if (autoscroll) consoleEl.scrollTop = 0x7fffffff;
}

function addLine(line, level) {
  lineQueue.push({ line, level });
  // A pathological log storm must not grow the queue without bound; keep
  // only what could possibly still be on screen.
  if (lineQueue.length > MAX_LINES * 2) lineQueue.splice(0, lineQueue.length - MAX_LINES);
  if (!flushQueued) { flushQueued = true; requestAnimationFrame(flushLines); }
}

filterEl.addEventListener('input', () => {
  const q = filterEl.value.trim().toLowerCase();
  for (const node of consoleEl.children) {
    node.classList.toggle('line-hidden', q && !node.textContent.toLowerCase().includes(q));
  }
});

const autoBtn = document.getElementById('mon-autoscroll');
autoBtn.addEventListener('click', () => {
  autoscroll = !autoscroll;
  autoBtn.textContent = `Autoscroll: ${autoscroll ? 'ON' : 'OFF'}`;
  if (autoscroll) consoleEl.scrollTop = consoleEl.scrollHeight;
});
// PERF: this read scrollTop/clientHeight/scrollHeight on every wheel tick,
// each of which forces a layout flush, while the log was still streaming in.
// The `scroll` event already fires at most once per frame and carries the
// same information, and it also catches keyboard and scrollbar scrolling
// that the wheel handler missed.
let scrollCheckQueued = false;
consoleEl.addEventListener('scroll', () => {
  if (scrollCheckQueued) return;
  scrollCheckQueued = true;
  requestAnimationFrame(() => {
    scrollCheckQueued = false;
    const atBottom = consoleEl.scrollTop + consoleEl.clientHeight >= consoleEl.scrollHeight - 30;
    if (!atBottom && autoscroll) { autoscroll = false; autoBtn.textContent = 'Autoscroll: OFF'; }
    else if (atBottom && !autoscroll) { autoscroll = true; autoBtn.textContent = 'Autoscroll: ON'; }
  });
}, { passive: true });
document.getElementById('mon-clear').addEventListener('click', () => { consoleEl.innerHTML = ''; });

// (FPS-from-log parsing removed — Minecraft doesn't reliably print its
// FPS to the log, so that card was showing "—" for almost everyone.
// The in-game F3 overlay is the accurate source for live FPS.)

// ---------- sparklines ----------
// =====================================================================
// PERF: every redraw of this 60-point sparkline used to
//   - read canvas.clientWidth/clientHeight  (forced layout)
//   - REASSIGN canvas.width/height          (reallocates the GPU backing
//     store and wipes the context state -- the single most expensive thing
//     you can do to a canvas, done here twice a second, per graph)
//   - call getComputedStyle(documentElement) (forced style recalc over the
//     whole document, just to read one custom property that never changes)
//   - allocate a new 2d context object
//
// All four are hoisted out. Geometry and colour are resolved once and
// re-resolved only when something can actually have changed them (resize,
// DPI change, accent change). The draw itself is then pure canvas work.
// =====================================================================
function sparkline(canvasId, color) {
  const canvas = document.getElementById(canvasId);
  const samples = [];
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 0, accent = '';
  let queued = false;

  function measure() {
    const nd = window.devicePixelRatio || 1;
    const nw = canvas.clientWidth, nh = canvas.clientHeight;
    if (nw === w && nh === h && nd === dpr) return;
    w = nw; h = nh; dpr = nd;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);   // survives the resize above
  }

  function readAccent() {
    accent = getComputedStyle(document.documentElement).getPropertyValue(color).trim() || '#9d6bff';
  }

  function draw() {
    queued = false;
    measure();
    if (!accent) readAccent();
    ctx.clearRect(0, 0, w, h);
    if (samples.length < 2) return;

    let max = 1;
    for (let i = 0; i < samples.length; i++) if (samples[i] > max) max = samples[i];

    ctx.beginPath();
    const step = w / (samples.length - 1);
    for (let i = 0; i < samples.length; i++) {
      const x = i * step;
      const y = h - (samples[i] / max) * (h - 3) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.globalAlpha = 0.15; ctx.fillStyle = accent; ctx.fill(); ctx.globalAlpha = 1;
  }

  window.addEventListener('resize', () => { w = 0; readAccent(); }, { passive: true });

  return {
    push(v) {
      samples.push(v);
      if (samples.length > 60) samples.shift();
      // Samples can arrive faster than the screen refreshes; drawing more
      // than once per frame draws pixels nobody will ever see.
      if (document.hidden) return;
      if (!queued) { queued = true; requestAnimationFrame(draw); }
    },
  };
}
const cpuSpark = sparkline('spark-cpu', '--accent');
const memSpark = sparkline('spark-mem', '--accent2');

function fmtUptime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

// ---------- live event wiring (filtered to this launch) ----------
window.nebula.onLog(({ launchId: id, line, level }) => {
  if (id !== launchId) return;
  addLine(line, level);
  if (document.getElementById('mon-status').textContent === 'Starting' && /Setting user|LWJGL|Sound engine started/i.test(line)) {
    document.getElementById('mon-status').textContent = 'Running';
    document.getElementById('mon-progress').classList.add('hidden');
  }
});

window.nebula.onProgress(({ launchId: id, label, percent, bytesPerSec }) => {
  if (id !== launchId || closed) return;
  const box = document.getElementById('mon-progress');
  box.classList.remove('hidden');
  document.getElementById('mon-progress-label').textContent = label;
  if (bytesPerSec) {
    const mb = bytesPerSec / 1048576;
    document.getElementById('mon-progress-speed').textContent = mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  }
  if (percent != null) {
    document.getElementById('mon-progress-fill').style.width = `${percent}%`;
    document.getElementById('mon-progress-pct').textContent = `${Math.round(percent)}%`;
  }
  if (percent >= 100) setTimeout(() => box.classList.add('hidden'), 1500);
});

window.nebula.onStats(({ launchId: id, cpuPercent, memMB, uptimeSec }) => {
  if (id !== launchId || closed) return;
  document.getElementById('mon-cpu').innerHTML = `${cpuPercent.toFixed(0)}<small>%</small>`;
  document.getElementById('mon-mem').innerHTML = memMB >= 1024
    ? `${(memMB / 1024).toFixed(1)}<small>GB</small>`
    : `${memMB.toFixed(0)}<small>MB</small>`;
  document.getElementById('mon-uptime').textContent = `Uptime ${fmtUptime(uptimeSec)}`;
  cpuSpark.push(cpuPercent);
  memSpark.push(memMB);
});

window.nebula.onClosed(({ launchId: id, code }) => {
  if (id !== launchId) return;
  closed = true;
  document.getElementById('mon-dot').classList.add('dead');
  document.getElementById('mon-status').textContent = code === 0 ? 'Exited' : `Crashed (${code})`;
  document.getElementById('mon-stop').disabled = true;
  document.getElementById('mon-progress').classList.add('hidden');
  addLine(`--- process exited with code ${code} ---`, 'debug');
  startAutoClose(code === 0 ? 3 : 10);
});

// The game closed — close this window too, after a short grace period
// so a clean exit doesn't yank the console away instantly, and a crash
// gets more time since there's a log worth reading first. Either way
// it's cancellable with one click.
function startAutoClose(seconds) {
  const box = document.getElementById('mon-autoclose');
  const text = document.getElementById('mon-autoclose-text');
  box.classList.remove('hidden');
  let remaining = seconds;
  text.textContent = `Closing in ${remaining}s…`;
  const timer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(timer);
      window.nebula.closeWindow();
      return;
    }
    text.textContent = `Closing in ${remaining}s…`;
  }, 1000);
  document.getElementById('mon-keep-open').addEventListener('click', () => {
    clearInterval(timer);
    box.classList.add('hidden');
  }, { once: true });
}

window.nebula.onCrashSuggestion(({ launchId: id, message }) => {
  if (id && id !== launchId) return;
  addLine(`◆ Possible fix: ${message}`, 'debug');
});

document.getElementById('mon-stop').addEventListener('click', () => {
  document.getElementById('mon-stop').disabled = true;
  window.nebula.stopGame(launchId);
});

// backfill anything logged before this window opened
window.nebula.getLogBuffer(launchId).then(lines => {
  for (const { line, level } of lines) addLine(line, level);
});
