/**
 * SolarClient liquid-glass engine
 *
 * Optics cloned from @liqui-design/glass (MIT — liqui.design):
 * canvas SDF displacement map + document SVG filter registry + split
 * backdrop layers (blur A, refraction B) + tint + specular rim + shine.
 *
 * Own Electron/vanilla reimplementation — no third-party runtime, no network.
 */
(function (global) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const LUT_SIZE = 128;
  const FILTER_CACHE_MAX = 96;
  const IMAGE_CACHE_MAX = 48;
  const ISOLATE = {
    R: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
    G: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
    B: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0',
  };

  // Defaults match Shark's tuned liqui dials (launcher Settings screenshot).
  const DEFAULTS = {
    material: 'auto',
    profile: 'squircle',
    frost: 0.13,
    blur: 1,
    refraction: 250,
    bezel: 19,
    dispersion: 0,
    specular: 0.25,
    saturation: 1.7,
  };
  const OPTICS_DEFAULTS_VERSION = 3;

  const THETA_KEY = Math.atan2(-0.9, -0.45);
  const THETA_COUNTER = Math.atan2(0.9, 0.5);

  let host = null;
  const filterIds = new Map();
  let nextId = 0;
  const lutCache = new Map();
  const imageCache = new Map();
  const surfaces = new Set();
  let optics = { ...DEFAULTS };
  let paintQueued = false;
  const paintDirty = new Set();

  const supportsRefraction = (() => {
    if (typeof window === 'undefined' || !window.CSS || !CSS.supports) return false;
    if (!CSS.supports('backdrop-filter', 'blur(1px)')) return false;
    const ua = navigator.userAgent;
    if (/firefox\//i.test(ua)) return false;
    if (/^((?!chrome|chromium|edg|android).)*safari/i.test(ua)) return false;
    return true;
  })();

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElementNS(SVG_NS, 'svg');
    host.setAttribute('width', '0');
    host.setAttribute('height', '0');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:absolute;overflow:hidden;pointer-events:none;width:0;height:0';
    document.body.appendChild(host);
    return host;
  }

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  function displacement(scale, result) {
    const node = el('feDisplacementMap', {
      in: 'SourceGraphic',
      in2: 'map',
      scale,
      xChannelSelector: 'R',
      yChannelSelector: 'B',
    });
    if (result) node.setAttribute('result', result);
    return node;
  }

  function ensureFilter({ w, h, mapHref, refraction, dispersion }) {
    const key = `${w}x${h}|r${refraction}|d${dispersion}|${mapHref.length}:${mapHref.slice(-24)}`;
    const existing = filterIds.get(key);
    if (existing) {
      filterIds.delete(key);
      filterIds.set(key, existing);
      return { id: existing, cold: false };
    }
    const id = `sc-lq-${nextId++}`;
    const filter = el('filter', {
      id,
      x: 0,
      y: 0,
      width: w,
      height: h,
      filterUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    });
    const image = el('feImage', { x: 0, y: 0, width: w, height: h, result: 'map' });
    image.setAttribute('href', mapHref);
    filter.appendChild(image);
    if (dispersion > 0) {
      filter.appendChild(displacement(refraction * (1 - dispersion), 'dispR'));
      filter.appendChild(el('feColorMatrix', { in: 'dispR', values: ISOLATE.R, result: 'chR' }));
      filter.appendChild(displacement(refraction, 'dispG'));
      filter.appendChild(el('feColorMatrix', { in: 'dispG', values: ISOLATE.G, result: 'chG' }));
      filter.appendChild(displacement(refraction * (1 + dispersion), 'dispB'));
      filter.appendChild(el('feColorMatrix', { in: 'dispB', values: ISOLATE.B, result: 'chB' }));
      filter.appendChild(el('feComposite', {
        in: 'chR', in2: 'chG', operator: 'arithmetic', k2: 1, k3: 1, result: 'chRG',
      }));
      filter.appendChild(el('feComposite', {
        in: 'chRG', in2: 'chB', operator: 'arithmetic', k2: 1, k3: 1,
      }));
    } else {
      filter.appendChild(displacement(refraction));
    }
    ensureHost().appendChild(filter);
    filterIds.set(key, id);
    if (filterIds.size > FILTER_CACHE_MAX) {
      const [oldestKey, oldestId] = filterIds.entries().next().value;
      filterIds.delete(oldestKey);
      host?.querySelector(`#${oldestId}`)?.remove();
    }
    return { id, cold: true };
  }

  function surfaceLUTs(profile) {
    const cached = lutCache.get(profile);
    if (cached) return cached;
    const mag = new Float32Array(LUT_SIZE);
    const n = 1.5;
    const T = 0.6;
    const hFn = profile === 'squircle'
      ? (t) => Math.pow(1 - Math.pow(1 - t, 4), 0.25)
      : profile === 'convex'
        ? (t) => Math.sqrt(1 - (1 - t) * (1 - t))
        : (t) => 1 - (1 - t) * (1 - t);
    const eps = 1 / 1024;
    let max = 0;
    for (let i = 0; i < LUT_SIZE; i++) {
      const t = Math.max(i / (LUT_SIZE - 1), eps);
      const hi = Math.min(t + eps, 1);
      const lo = Math.max(t - eps, 0);
      const slope = ((hFn(hi) - hFn(lo)) / (hi - lo)) * T;
      if (profile === 'rim') {
        mag[i] = (1 - t) * (1 - t);
      } else {
        const thetaI = Math.atan(Math.abs(slope));
        const delta = thetaI - Math.asin(Math.sin(thetaI) / n);
        mag[i] = hFn(t) * T * Math.tan(delta);
        max = Math.max(max, mag[i]);
      }
    }
    if (max > 0) for (let i = 0; i < LUT_SIZE; i++) mag[i] /= max;
    const luts = { mag };
    lutCache.set(profile, luts);
    return luts;
  }

  function cacheGet(key) {
    const hit = imageCache.get(key);
    if (!hit) return undefined;
    imageCache.delete(key);
    imageCache.set(key, hit);
    return hit;
  }
  function cacheSet(key, value) {
    imageCache.set(key, value);
    if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  }

  function glassImages(fullW, fullH, fullRadius, fullBezel, profile) {
    const key = `${fullW}x${fullH}r${fullRadius}b${fullBezel}${profile}`;
    const cached = cacheGet(key);
    if (cached) return cached;
    const scale = fullW * fullH > 32000 ? 0.5 : 1;
    const w = Math.max(1, Math.ceil(fullW * scale));
    const h = Math.max(1, Math.ceil(fullH * scale));
    const radius = fullRadius * scale;
    const bezel = Math.max(1, fullBezel * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.createImageData(w, h);
    const data = image.data;
    const specCanvas = document.createElement('canvas');
    specCanvas.width = w;
    specCanvas.height = h;
    const specCtx = specCanvas.getContext('2d', { willReadFrequently: true });
    const specImage = specCtx.createImageData(w, h);
    const spec = specImage.data;
    const { mag: lut } = surfaceLUTs(profile);
    const r = Math.min(radius, w / 2, h / 2);
    const bx = w / 2 - r;
    const by = h / 2 - r;
    // Everything deeper than the bezel is neutral (no shift, no specular), so fill it
    // once and only walk the rim. On rows clear of the corners (qy <= min(0, r - bezel)),
    // any pixel with qx <= r - bezel - 1 is that deep, so those spans are skipped.
    new Uint32Array(data.buffer).fill(0xff808080);
    const deep = r - bezel;
    const rowClear = Math.min(0, deep);
    const skipHalf = bx + deep - 1;
    for (let y = 0; y < h; y++) {
      const qyRow = Math.abs(y + 0.5 - h / 2) - by;
      let skipFrom = w;
      let skipTo = w;
      if (qyRow <= rowClear && skipHalf > 0) {
        skipFrom = Math.max(0, Math.ceil(w / 2 - skipHalf - 0.5));
        skipTo = Math.min(w, Math.floor(w / 2 + skipHalf - 0.5) + 1);
        if (skipTo <= skipFrom) skipFrom = skipTo = w;
      }
      for (let x = 0; x < w; x++) {
        if (x === skipFrom) { x = skipTo - 1; continue; }
        const px = x + 0.5 - w / 2;
        const py = y + 0.5 - h / 2;
        const qx = Math.abs(px) - bx;
        const qy = Math.abs(py) - by;
        const ox = Math.max(qx, 0);
        const oy = Math.max(qy, 0);
        const depth = -(Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r);
        let nx = 0;
        let ny = 0;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          nx = Math.sign(px) * qx / len;
          ny = Math.sign(py) * qy / len;
        } else if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
        const d = depth / bezel;
        const inRim = d < 1 && d >= 0;
        const idx = inRim ? Math.min(Math.round(d * (LUT_SIZE - 1)), LUT_SIZE - 1) : 0;
        const mag = inRim ? lut[idx] : 0;
        const i = (y * w + x) * 4;
        data[i] = Math.round(128 - nx * mag * 127);
        data[i + 1] = 128;
        data[i + 2] = Math.round(128 - ny * mag * 127);
        data[i + 3] = 255;
        if (inRim) {
          const theta = Math.atan2(py, px);
          const band = Math.exp(-(((d - 0.2) / 0.4) ** 2));
          const c1 = Math.max(Math.cos(theta - THETA_KEY), 0);
          const c2 = Math.max(Math.cos(theta - THETA_COUNTER), 0);
          const intensity = Math.min(band * (1.15 * c1 ** 3 + 0.75 * c2 ** 3.5), 1);
          spec[i] = 255;
          spec[i + 1] = 255;
          spec[i + 2] = 255;
          spec[i + 3] = Math.round(intensity * 255);
        }
      }
    }
    ctx.putImageData(image, 0, 0);
    specCtx.putImageData(specImage, 0, 0);
    const result = { map: canvas.toDataURL(), specular: specCanvas.toDataURL() };
    cacheSet(key, result);
    return result;
  }

  function parseRadius(node) {
    const br = getComputedStyle(node).borderRadius || '16px';
    const n = parseFloat(br);
    return Number.isFinite(n) ? n : 16;
  }

  /** Inline !important beats the launcher's backdrop-filter kill strip. */
  function setBf(node, value) {
    if (!node) return;
    node.style.setProperty('backdrop-filter', value, 'important');
    node.style.setProperty('-webkit-backdrop-filter', value, 'important');
  }

  function ensureLayers(node) {
    let layers = node.__lqLayers;
    if (layers && layers.backdrop.isConnected) return layers;
    node.querySelectorAll(':scope > .lg-backboard').forEach((n) => n.remove());

    const backdrop = document.createElement('span');
    backdrop.className = 'lq-backdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    const refract = document.createElement('span');
    refract.className = 'lq-refract';
    refract.setAttribute('aria-hidden', 'true');
    const tint = document.createElement('span');
    tint.className = 'lq-tint';
    tint.setAttribute('aria-hidden', 'true');
    const specular = document.createElement('span');
    specular.className = 'lq-specular';
    specular.setAttribute('aria-hidden', 'true');
    const shine = document.createElement('span');
    shine.className = 'lq-shine';
    shine.setAttribute('aria-hidden', 'true');

    node.insertBefore(shine, node.firstChild);
    node.insertBefore(specular, node.firstChild);
    node.insertBefore(tint, node.firstChild);
    node.insertBefore(refract, node.firstChild);
    node.insertBefore(backdrop, node.firstChild);

    layers = { backdrop, refract, tint, specular, shine };
    node.__lqLayers = layers;
    node.classList.add('lq-surface');
    return layers;
  }

  function tierFor() {
    // Low-graphics mode: keep a frosted pane, never kill the material entirely.
    if (document.body.classList.contains('perf-lite')) return 'frost';
    if (optics.material === 'clear') return 'clear';
    if (optics.material === 'frost') return 'frost';
    return supportsRefraction ? 'refract' : 'frost';
  }

  function normalizeDispersion(raw) {
    let d = Number(raw) || 0;
    if (d > 1) d = d / 100;
    return Math.max(0, Math.min(0.5, d));
  }

  // A new lens map is a data: URL the SVG filter loads on its own. Until it has,
  // the filter displaces by garbage, so the old lens (or none) stays up meanwhile.
  const readyFilters = new Set();
  const loadingFilters = new Map();
  function whenFilterReady(id, href, cb) {
    if (readyFilters.has(id)) { cb(); return; }
    let p = loadingFilters.get(id);
    if (!p) {
      const img = new Image();
      img.src = href;
      p = img.decode().catch(() => {}).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
        .then(() => { readyFilters.add(id); loadingFilters.delete(id); });
      loadingFilters.set(id, p);
    }
    p.then(cb);
  }

  /** Per-surface dials (data-lq-bezel / -refraction / -dispersion / -specular) over the global ones. */
  function dial(node, key, fallback) {
    const v = node.dataset[key];
    return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
  }

  function paint(node) {
    if (!node || !node.isConnected) return;

    const layers = ensureLayers(node);
    const w = Math.round(node.offsetWidth);
    const h = Math.round(node.offsetHeight);
    if (w < 2 || h < 2) return;

    const tier = tierFor();
    node.dataset.lqTier = tier;
    if (tier !== 'refract') { layers.refract.__lqFilter = null; layers.refract.classList.remove('lq-wait'); }
    const radius = parseRadius(node);
    const bezel = Math.max(4, Math.min(dial(node, 'lqBezel', optics.bezel), Math.min(w, h) * 0.45));
    const frost = Math.max(0, Math.min(1, optics.frost));
    const blur = Math.max(0, optics.blur);
    // data-lq-blur adds per-surface blur (e.g. a panel floating over busy content).
    const effectiveBlur = blur + frost * 14 + (Number(node.dataset.lqBlur) || 0);
    const saturation = optics.saturation || 1.7;
    const tintOpacity = tier === 'clear' ? 1 : 0.25 + 0.75 * frost;

    layers.tint.style.opacity = String(tintOpacity);

    if (tier === 'clear') {
      setBf(layers.backdrop, 'none');
      setBf(layers.refract, 'none');
      layers.specular.style.backgroundImage = 'none';
      layers.specular.style.opacity = '0';
      return;
    }

    if (tier === 'frost') {
      const bf = `blur(${Math.max(effectiveBlur * 2, 10)}px) saturate(${saturation})`;
      setBf(layers.backdrop, bf);
      setBf(layers.refract, 'none');
      layers.specular.style.backgroundImage = 'none';
      layers.specular.style.opacity = '0';
      return;
    }

    // liqui anatomy: blur+saturate on A, displacement-only on B
    const bf = `blur(${effectiveBlur}px) saturate(${saturation})`;
    setBf(layers.backdrop, bf);

    const disp = normalizeDispersion(dial(node, 'lqDispersion', optics.dispersion));
    const images = glassImages(w, h, radius, bezel, optics.profile || 'squircle');
    const { id } = ensureFilter({
      w,
      h,
      mapHref: images.map,
      refraction: Math.round(dial(node, 'lqRefraction', optics.refraction)),
      dispersion: disp,
    });
    const refract = layers.refract;
    const want = `url(#${id})`;
    refract.__lqWant = want;
    if (refract.__lqFilter !== want) {
      if (!refract.__lqFilter && !readyFilters.has(id)) refract.classList.add('lq-wait');
      whenFilterReady(id, images.map, () => {
        if (refract.__lqWant !== want) return;
        setBf(refract, want);
        refract.__lqFilter = want;
        requestAnimationFrame(() => refract.classList.remove('lq-wait'));
      });
    }

    const specular = dial(node, 'lqSpecular', optics.specular);
    if (specular > 0) {
      layers.specular.style.backgroundImage = `url(${images.specular})`;
      layers.specular.style.backgroundSize = '100% 100%';
      layers.specular.style.opacity = String(specular);
    } else {
      layers.specular.style.backgroundImage = 'none';
      layers.specular.style.opacity = '0';
    }
  }

  function flushPaints() {
    paintQueued = false;
    const batch = [...paintDirty];
    paintDirty.clear();
    // Paint large shells first so the UI reads as glass immediately.
    batch.sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight));
    const start = performance.now();
    let i = 0;
    while (i < batch.length) {
      paint(batch[i++]);
      // Yield so first-open doesn't freeze the window (looked like a crash).
      if (i < batch.length && performance.now() - start > 12) {
        for (; i < batch.length; i++) paintDirty.add(batch[i]);
        schedulePaint();
        return;
      }
    }
  }

  // While the window is being resized every surface changes size every frame, and
  // rebuilding each displacement map that often is what made resizing crawl. Hold the
  // repaints (CSS hides the refraction pass meanwhile) and do them once it settles.
  let settling = false;
  let settleTimer = 0;
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      if (!settling) {
        settling = true;
        document.documentElement.classList.add('lq-settling');
      }
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settling = false;
        document.documentElement.classList.remove('lq-settling');
        if (paintDirty.size) schedulePaint();
      }, 160);
    });
  }

  function schedulePaint() {
    if (paintQueued || settling) return;
    paintQueued = true;
    requestAnimationFrame(flushPaints);
  }

  function requestPaint(node) {
    if (!node) return;
    paintDirty.add(node);
    schedulePaint();
  }

  function attach(node) {
    if (!node || surfaces.has(node)) return;
    surfaces.add(node);
    ensureLayers(node);
    const ro = new ResizeObserver(() => requestPaint(node));
    ro.observe(node);
    node.__lqRO = ro;
    requestPaint(node);
  }

  function detach(node) {
    if (!node) return;
    surfaces.delete(node);
    paintDirty.delete(node);
    node.__lqRO?.disconnect();
    delete node.__lqRO;
  }

  /** Paint now, not next frame: for a panel that was hidden and is about to be seen. */
  function paintNow(node) {
    if (!node) return;
    if (!surfaces.has(node)) attach(node);
    paintDirty.delete(node);
    paint(node);
  }

  function refreshAll() {
    for (const node of surfaces) paintDirty.add(node);
    schedulePaint();
  }

  function setOptics(partial) {
    optics = { ...optics, ...partial };
    try {
      localStorage.setItem('nebula-liquid-optics', JSON.stringify(optics));
    } catch { /* ignore */ }
    // Settings dials need instant feedback — paint synchronously, don't queue.
    for (const node of [...surfaces]) paint(node);
    return { ...optics };
  }

  function getOptics() {
    return { ...optics };
  }

  function loadOptics() {
    try {
      const ver = Number(localStorage.getItem('nebula-liquid-optics-v') || '0');
      if (ver < OPTICS_DEFAULTS_VERSION) {
        optics = { ...DEFAULTS };
        localStorage.setItem('nebula-liquid-optics', JSON.stringify(optics));
        localStorage.setItem('nebula-liquid-optics-v', String(OPTICS_DEFAULTS_VERSION));
        return { ...optics };
      }
      const raw = localStorage.getItem('nebula-liquid-optics');
      if (raw) optics = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return { ...optics };
  }

  function resetOptics() {
    optics = { ...DEFAULTS };
    try {
      localStorage.removeItem('nebula-liquid-optics');
      localStorage.setItem('nebula-liquid-optics-v', String(OPTICS_DEFAULTS_VERSION));
    } catch { /* ignore */ }
    for (const node of [...surfaces]) paint(node);
    return { ...optics };
  }

  function scan(root) {
    const scope = root || document;
    scope.querySelectorAll('.liquid-glass').forEach(attach);
  }

  // Launchpad shells only — Settings / Friends / Skins / Servers paint after
  // first frame so ready-to-show isn't waiting on ~30 off-screen SDF maps.
  const FIRST_PAINT_SEL = [
    '.sidebar.liquid-glass',
    '.main.liquid-glass',
    '#edition-switch.liquid-glass',
    '#launch-btn.liquid-glass',
    '#launch-another-btn.liquid-glass',
    '#version-chip.liquid-glass',
    '#perf-chip.liquid-glass',
    '#monitor-chip.liquid-glass',
    '#level-card.liquid-glass',
    '#bedrock-launch-btn.liquid-glass',
    '#bedrock-edition-switch.liquid-glass',
    '#update-card.liquid-glass',
  ].join(',');

  let booted = false;
  function init() {
    if (booted) {
      scan(document);
      return;
    }
    booted = true;
    loadOptics();
    document.querySelectorAll(FIRST_PAINT_SEL).forEach(attach);
    const deferRest = () => scan(document);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(deferRest, { timeout: 350 });
    } else {
      setTimeout(deferRest, 0);
    }
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          // Ignore our own layer spans
          if (n.classList?.contains('lq-backdrop') || n.classList?.contains('lq-refract')
            || n.classList?.contains('lq-tint') || n.classList?.contains('lq-specular')
            || n.classList?.contains('lq-shine')) return;
          if (n.classList?.contains('liquid-glass')) attach(n);
          n.querySelectorAll?.('.liquid-glass').forEach(attach);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  global.SolarLiquidGlass = {
    DEFAULTS,
    supportsRefraction,
    init,
    scan,
    attach,
    detach,
    paintNow,
    setOptics,
    getOptics,
    loadOptics,
    resetOptics,
    refreshAll,
  };
})(window);
