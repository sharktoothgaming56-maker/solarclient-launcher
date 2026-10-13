// =====================================================================
// SKIN 3D — drag-to-rotate player model, rendered with WebGL.
//
// Backed by skinview3d (three.js), loaded from vendor/skinview3d.bundle.js
// as window.SolarSkinGL. The previous renderer drew every face with
// canvas-2D affine transforms and a painter's sort, which can't produce a
// correct depth order or seamless edges — hence the holes and flicker. A
// real depth buffer fixes both outright.
//
// The public API is unchanged (setSkin, setSkinFromCanvas, setSlim,
// setOverlay, setHiddenParts, pick, yaw/pitch/zoom, requestRender...), so
// the launchpad, Skins tab and skin editor use it exactly as before.
// Frames are only drawn when something changes — no idle render loop.
// =====================================================================

(function (global) {
  'use strict';

  const ALPHA_TEST = 128;
  const PART_NAMES = { head: 'head', body: 'body', armR: 'rightArm', armL: 'leftArm', legR: 'rightLeg', legL: 'leftLeg' };
  // Inner (base) layer areas of a 64x64 skin. Minecraft ignores alpha there.
  const BASE_AREAS = [[0, 0, 32, 16], [0, 16, 56, 16], [16, 48, 32, 16]];

  function readSkin(img) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    const h = img.naturalHeight || img.height;
    g.drawImage(img, 0, 0, 64, h === 32 ? 32 : 64, 0, 0, 64, h === 32 ? 32 : 64);

    // Legacy skins, and legacy skins padded to 64x64 by a skin host, have
    // no second arm or leg. Mirror them the way the game does.
    const px = g.getImageData(0, 0, 64, 64);
    const empty = (x, y, w, hh) => {
      for (let j = y; j < y + hh; j++) for (let i = x; i < x + w; i++) if (px.data[(j * 64 + i) * 4 + 3] > 0) return false;
      return true;
    };
    const flip = (sx, sy, w, hh, dx, dy) => {
      const t = document.createElement('canvas');
      t.width = w; t.height = hh;
      const tg = t.getContext('2d');
      tg.imageSmoothingEnabled = false;
      tg.translate(w, 0); tg.scale(-1, 1);
      tg.drawImage(c, sx, sy, w, hh, 0, 0, w, hh);
      g.drawImage(t, dx, dy);
    };
    const mirrorLimb = (sx, sy, dx, dy) => {
      flip(sx + 4, sy, 4, 4, dx + 4, dy);            // top
      flip(sx + 8, sy, 4, 4, dx + 8, dy);            // bottom
      flip(sx, sy + 4, 4, 12, dx + 8, dy + 4);       // right -> left
      flip(sx + 4, sy + 4, 4, 12, dx + 4, dy + 4);   // front
      flip(sx + 8, sy + 4, 4, 12, dx, dy + 4);       // left -> right
      flip(sx + 12, sy + 4, 4, 12, dx + 12, dy + 4); // back
    };
    let patched = false;
    if (empty(32, 48, 16, 16) && !empty(40, 16, 16, 16)) { mirrorLimb(40, 16, 32, 48); patched = true; }
    if (empty(16, 48, 16, 16) && !empty(0, 16, 16, 16)) { mirrorLimb(0, 16, 16, 48); patched = true; }
    // Old 64x32 skins often fill the hat area solid; the game treats a hat
    // with no transparent pixel as absent.
    if (h === 32) {
      let solid = true;
      for (let j = 0; j < 16 && solid; j++) for (let i = 32; i < 64; i++) if (px.data[(j * 64 + i) * 4 + 3] < 128) { solid = false; break; }
      if (solid) { g.clearRect(32, 0, 32, 16); patched = true; }
    }
    return patched ? g.getImageData(0, 0, 64, 64) : px;
  }

  // Transparent pixels in the base layer would render as black patches on
  // the opaque inner model. Give them the skin's average colour instead,
  // and hard-threshold the overlay so half-transparent pixels are either
  // there or not, like in game.
  function prepareTexture(pixels) {
    const out = new ImageData(new Uint8ClampedArray(pixels.data), 64, 64);
    const d = out.data;
    let ar = 0, ag = 0, ab = 0, an = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] >= ALPHA_TEST) { ar += d[i]; ag += d[i + 1]; ab += d[i + 2]; an++; }
    }
    const fr = an ? ar / an : 128, fg = an ? ag / an : 128, fb = an ? ab / an : 128;
    const isBase = new Uint8Array(64 * 64);
    for (const [x0, y0, w, h] of BASE_AREAS) {
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) isBase[y * 64 + x] = 1;
    }
    for (let p = 0, i = 0; p < 64 * 64; p++, i += 4) {
      const solid = d[i + 3] >= ALPHA_TEST;
      if (isBase[p]) {
        if (!solid) { d[i] = fr; d[i + 1] = fg; d[i + 2] = fb; }
        d[i + 3] = 255;
      } else {
        d[i + 3] = solid ? 255 : 0;
      }
    }
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    c.getContext('2d').putImageData(out, 0, 0);
    return c;
  }

  // A slim arm is 3px wide, so the last two columns of the right arm's
  // strip (x 54-55) and of its top/bottom row (x 50-51) are unused.
  function detectSlim(pixels) {
    const a = (x, y) => pixels.data[(y * 64 + x) * 4 + 3];
    for (let y = 20; y < 32; y++) if (a(54, y) > 0 || a(55, y) > 0) return false;
    for (let y = 16; y < 20; y++) if (a(50, y) > 0 || a(51, y) > 0) return false;
    return true;
  }

  function faceName(n) {
    const ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
    if (az >= ax && az >= ay) return n.z > 0 ? 'front' : 'back';
    if (ay >= ax) return n.y > 0 ? 'top' : 'bottom';
    return n.x > 0 ? 'left' : 'right';
  }

  function Skin3D(canvas, opts) {
    opts = opts || {};
    const GL = global.SolarSkinGL;
    if (!GL) throw new Error('3D skin renderer is not loaded');
    this.canvas = canvas;
    this.yaw = opts.yaw != null ? opts.yaw : 0.5;
    this.pitch = 0;
    this.zoom = opts.zoom || 1;
    this.showOverlay = true;
    this.hiddenParts = new Set();   // used by the editor's part isolation
    this.slim = false;
    this.pixels = null;
    this.tex = null;
    this.dragging = false;
    this._w = canvas.clientWidth || 220;
    this._h = canvas.clientHeight || 340;
    this.viewer = new GL.SkinViewer({
      canvas,
      width: this._w,
      height: this._h,
      renderPaused: true,
      enableControls: false,
      zoom: 0.9 * this.zoom,
    });
    this._clearInlineSize();
    // skinview3d's camera light uses physical falloff and is too weak to
    // register at this distance, leaving flat ambient-only shading. Balance
    // the two so faces turned away from you read darker, like in game.
    this.viewer.globalLight.intensity = 1.6;
    this.viewer.cameraLight.intensity = 1.6;
    this.viewer.cameraLight.decay = 0;
    const skin = this.viewer.playerObject.skin;
    // The legs overlap by a sliver down the middle and share one depth bias,
    // so their front and back faces z-fight there and flicker as the model
    // turns. Set the left leg a hair deeper so one side always wins. Applied
    // to the leg's inner group, which resetJoints() leaves alone.
    const leftLegGroup = skin.leftLeg && skin.leftLeg.innerLayer && skin.leftLeg.innerLayer.parent;
    if (leftLegGroup) leftLegGroup.position.z -= 0.03;
    skin.visible = false;
    this._bind();
    if (typeof ResizeObserver === 'function') {
      this._ro = new ResizeObserver(() => this.requestRender());
      this._ro.observe(canvas);
    }
  }

  // The canvas is sized by CSS; three's setSize pins inline px sizes.
  Skin3D.prototype._clearInlineSize = function () {
    this.canvas.style.width = '';
    this.canvas.style.height = '';
  };

  Skin3D.prototype._bind = function () {
    const c = this.canvas;
    let lx = 0, ly = 0;
    const down = (x, y) => {
      if (this.paintMode) return;   // the editor handles the pointer itself
      this.dragging = true; this.beginInteraction();
      lx = x; ly = y; c.classList.add('grabbing');
    };
    const move = (x, y) => {
      if (!this.dragging) return;
      this.yaw += (x - lx) * 0.014;
      this.pitch = Math.max(-0.6, Math.min(0.6, this.pitch + (y - ly) * 0.008));
      lx = x; ly = y;
      this.requestRender();
    };
    const up = () => {
      if (!this.dragging) return;
      this.dragging = false; this.endInteraction(); c.classList.remove('grabbing');
    };
    c.addEventListener('mousedown', (e) => { if (e.button !== 0) return; e.preventDefault(); down(e.clientX, e.clientY); });
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mouseup', up);
    c.addEventListener('touchstart', (e) => down(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    c.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    c.addEventListener('touchend', up);
    c.addEventListener('dblclick', () => { this.yaw = 0.5; this.pitch = 0; this.zoom = this._baseZoom(); this.render(); });
    // Scroll to zoom in on the model.
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015);
      this.zoom = Math.max(0.6, Math.min(2.6, this.zoom * f));
      this.requestRender();
    }, { passive: false });
    this._initialZoom = this.zoom;
  };

  Skin3D.prototype._baseZoom = function () { return this._initialZoom || 1; };

  const nextFrame = (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame
    : (fn) => setTimeout(fn, 16);

  Skin3D.prototype.beginInteraction = function () {};
  Skin3D.prototype.endInteraction = function () { this.requestRender(); };

  Skin3D.prototype.requestRender = function () {
    if (this._raf) return;
    this._raf = nextFrame(() => { this._raf = 0; this.render(); });
  };

  Skin3D.prototype._apply = function (pixels) {
    this.pixels = pixels;
    this.tex = true;
    this.viewer.loadSkin(prepareTexture(pixels), { model: this.slim ? 'slim' : 'default' });
    this._applyVisibility();
  };

  // Painting calls this on every stroke; reads the pixels directly.
  Skin3D.prototype.setSkinFromCanvas = function (src) {
    const g = src.getContext('2d', { willReadFrequently: true });
    this._apply(g.getImageData(0, 0, 64, 64));
    this.requestRender();
  };

  Skin3D.prototype.setSkin = function (src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const pixels = readSkin(img);
          this.slim = detectSlim(pixels);
          this._apply(pixels);
          this.render();
          resolve(this);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('Could not load that skin image'));
      img.src = src;
    });
  };

  Skin3D.prototype.setSlim = function (v) {
    this.slim = !!v;
    this.viewer.playerObject.skin.modelType = this.slim ? 'slim' : 'default';
    this._applyVisibility();
    this.render();
  };
  Skin3D.prototype.setOverlay = function (v) { this.showOverlay = !!v; this._applyVisibility(); this.render(); };
  Skin3D.prototype.setHiddenParts = function (list) { this.hiddenParts = new Set(list || []); this._applyVisibility(); this.render(); };

  Skin3D.prototype._applyVisibility = function () {
    const skin = this.viewer.playerObject.skin;
    if (this.tex) skin.visible = true;
    skin.setOuterLayerVisible(this.showOverlay);
    for (const [name, prop] of Object.entries(PART_NAMES)) {
      if (skin[prop]) skin[prop].visible = !this.hiddenParts.has(name);
    }
  };

  Skin3D.prototype.render = function () {
    const v = this.viewer;
    if (!v) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w && h && (w !== this._w || h !== this._h)) {
      v.setSize(w, h);
      this._clearInlineSize();
      this._w = w; this._h = h;
    }
    const z = 0.9 * this.zoom;
    if (Math.abs(v.zoom - z) > 1e-6) v.zoom = z;
    v.playerWrapper.rotation.set(this.pitch, this.yaw, 0);
    v.render();
  };

  // ---- picking: screen point -> texture pixel -------------------------
  // Raycast against the visible model and read the texel from the hit's UV.
  // layerPref: 'inner' / 'outer' only consider that layer; otherwise the
  // nearest surface you can actually see wins (empty overlay pixels are
  // skipped, so you paint the body underneath them).
  Skin3D.prototype.pick = function (clientX, clientY, layerPref) {
    const GL = global.SolarSkinGL;
    if (!this.tex || !GL) return null;
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const ndc = new GL.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const rc = this._rc || (this._rc = new GL.Raycaster());
    const v = this.viewer;
    v.playerWrapper.rotation.set(this.pitch, this.yaw, 0);
    v.scene.updateMatrixWorld(true);
    rc.setFromCamera(ndc, v.camera);
    const skin = v.playerObject.skin;
    const hits = rc.intersectObject(skin, true);
    for (const h of hits) {
      if (!h.uv || !h.face) continue;
      const info = this._partOf(h.object, skin);
      if (!info) continue;
      if ((layerPref === 'inner' || layerPref === 'outer') && info.layer !== layerPref) continue;
      // Nudge toward the triangle's centre so a hit exactly on a face edge
      // can't round into the neighbouring face's texels.
      let u = h.uv.x, w = h.uv.y;
      const uvAttr = h.object.geometry && h.object.geometry.attributes.uv;
      if (uvAttr) {
        const cu = (uvAttr.getX(h.face.a) + uvAttr.getX(h.face.b) + uvAttr.getX(h.face.c)) / 3;
        const cv = (uvAttr.getY(h.face.a) + uvAttr.getY(h.face.b) + uvAttr.getY(h.face.c)) / 3;
        u += (cu - u) * 0.002; w += (cv - w) * 0.002;
      }
      const x = Math.max(0, Math.min(63, Math.floor(u * 64)));
      const y = Math.max(0, Math.min(63, Math.floor((1 - w) * 64)));
      if (info.layer === 'outer' && layerPref !== 'outer' && this.pixels
          && this.pixels.data[(y * 64 + x) * 4 + 3] < ALPHA_TEST) continue;
      return { x, y, part: info.part, layer: info.layer, face: faceName(h.face.normal) };
    }
    return null;
  };

  Skin3D.prototype._partOf = function (obj, skin) {
    for (let o = obj; o && o !== skin; o = o.parent) if (!o.visible) return null;
    for (const [name, prop] of Object.entries(PART_NAMES)) {
      const part = skin[prop];
      if (!part) continue;
      for (let o = obj; o && o !== skin; o = o.parent) {
        if (o === part.innerLayer) return { part: name, layer: 'inner' };
        if (o === part.outerLayer) return { part: name, layer: 'outer' };
      }
    }
    return null;
  };

  global.Skin3D = Skin3D;
})(window);
