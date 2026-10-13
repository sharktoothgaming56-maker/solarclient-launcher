// =====================================================================
// SKIN PREVIEW — flat, front/back, built entirely from integer-aligned
// blits of the skin texture.
//
// This replaces a from-scratch 3D renderer that could be rotated freely.
// That renderer was the right idea and the wrong trade: projecting the
// model produces polygons with fractional, antialiased edges, and every
// one of those edges is a place where coverage lands below 1 and the
// background shows through. I chased that through five rounds of fixes.
//
// This draws the character the way the vanilla launcher does: orthographic,
// facing front or back, every part copied with drawImage onto whole-pixel
// rectangles at an integer scale. There are no polygons, no clipping, no
// transforms and no blending, so a pixel is either fully the skin or fully
// the background. See-through is not a bug that can occur here — it is
// ruled out by construction.
//
// Trade-off, stated plainly: you can flip between front and back, but you
// cannot drag to any arbitrary angle any more.
// =====================================================================

(function (global) {
  'use strict';

  // Texture rectangles for every part, per view. [x, y, w, h] in the 64x64
  // skin. `aw` is substituted with the arm width (4 classic, 3 slim).
  function uvMap(view, aw) {
    const back = view === 'back';
    return {
      head:    back ? [24, 8, 8, 8]    : [8, 8, 8, 8],
      hat:     back ? [56, 8, 8, 8]    : [40, 8, 8, 8],
      body:    back ? [32, 20, 8, 12]  : [20, 20, 8, 12],
      jacket:  back ? [32, 36, 8, 12]  : [20, 36, 8, 12],
      armR:    back ? [52, 20, aw, 12] : [44, 20, aw, 12],
      sleeveR: back ? [52, 36, aw, 12] : [44, 36, aw, 12],
      armL:    back ? [44, 52, aw, 12] : [36, 52, aw, 12],
      sleeveL: back ? [60, 52, aw, 12] : [52, 52, aw, 12],
      legR:    back ? [12, 20, 4, 12]  : [4, 20, 4, 12],
      pantR:   back ? [12, 36, 4, 12]  : [4, 36, 4, 12],
      legL:    back ? [28, 52, 4, 12]  : [20, 52, 4, 12],
      pantL:   back ? [12, 52, 4, 12]  : [4, 52, 4, 12],
    };
  }

  const ALPHA_TEST = 128;

  // Two prepared copies of the texture:
  //   base    — alpha forced to 255. Minecraft ignores alpha on the inner
  //             layer, and plenty of real skins have antialiased pixels
  //             there from being edited in an image editor.
  //   overlay — alpha snapped to 0 or 255. The outer layer is alpha-tested
  //             in game, never blended.
  function prepare(img) {
    const src = document.createElement('canvas');
    src.width = 64; src.height = 64;
    const sg = src.getContext('2d', { willReadFrequently: true });
    sg.imageSmoothingEnabled = false;

    const h = img.naturalHeight || img.height;
    sg.drawImage(img, 0, 0, 64, h === 32 ? 32 : 64, 0, 0, 64, h === 32 ? 32 : 64);

    // Legacy skins (and legacy skins padded up to 64x64 by a skin host)
    // have no second arm or leg. Mirror them across, or those limbs simply
    // aren't there.
    const px = sg.getImageData(0, 0, 64, 64);
    const empty = (x, y, w, hh) => {
      for (let j = y; j < y + hh; j++) {
        for (let i = x; i < x + w; i++) if (px.data[(j * 64 + i) * 4 + 3] > 0) return false;
      }
      return true;
    };
    const mirror = (sx, sy, w, hh, dx, dy) => {
      const t = document.createElement('canvas');
      t.width = w; t.height = hh;
      const tg = t.getContext('2d');
      tg.imageSmoothingEnabled = false;
      tg.translate(w, 0); tg.scale(-1, 1);
      tg.drawImage(src, sx, sy, w, hh, 0, 0, w, hh);
      sg.drawImage(t, dx, dy);
    };
    if (empty(32, 48, 16, 16) && !empty(40, 16, 16, 16)) mirror(40, 16, 16, 16, 32, 48);
    if (empty(16, 48, 16, 16) && !empty(0, 16, 16, 16)) mirror(0, 16, 16, 16, 16, 48);

    const data = sg.getImageData(0, 0, 64, 64);
    const make = (mode) => {
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      const out = g.createImageData(64, 64);
      for (let i = 0; i < data.data.length; i += 4) {
        out.data[i] = data.data[i];
        out.data[i + 1] = data.data[i + 1];
        out.data[i + 2] = data.data[i + 2];
        const a = data.data[i + 3];
        out.data[i + 3] = mode === 'base' ? 255 : (a >= ALPHA_TEST ? 255 : 0);
      }
      g.putImageData(out, 0, 0);
      return c;
    };
    return { base: make('base'), overlay: make('overlay'), pixels: data };
  }

  // Slim detection, same heuristic Mojang uses: on a slim skin the fourth
  // column of the arm texture is fully transparent.
  function detectSlim(pixels) {
    const a = (x, y) => pixels.data[(y * 64 + x) * 4 + 3];
    for (let y = 20; y < 32; y++) if (a(46, y) > 0) return false;
    return true;
  }

  function Skin2D(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tex = null;
    this.slim = false;
    this.showOverlay = true;
    this.view = 'front';
  }

  Skin2D.prototype.setSkin = function (src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          this.tex = prepare(img);
          this.slim = detectSlim(this.tex.pixels);
          this.render();
          resolve(this);
        } catch (err) { reject(err); }
      };
      img.onerror = () => reject(new Error('Could not load that skin image'));
      img.src = src;
    });
  };

  Skin2D.prototype.setSlim = function (slim) { this.slim = !!slim; this.render(); };
  Skin2D.prototype.setOverlay = function (on) { this.showOverlay = !!on; this.render(); };
  Skin2D.prototype.setView = function (v) { this.view = v === 'back' ? 'back' : 'front'; this.render(); };
  Skin2D.prototype.toggleView = function () { this.setView(this.view === 'front' ? 'back' : 'front'); };

  Skin2D.prototype.render = function () {
    const ctx = this.ctx;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const cssW = this.canvas.clientWidth || 200;
    const cssH = this.canvas.clientHeight || 320;
    const w = cssW * dpr, h = cssH * dpr;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.tex) return;
    ctx.imageSmoothingEnabled = false;

    const aw = this.slim ? 3 : 4;
    const uv = uvMap(this.view, aw);

    // Whole-pixel scale keeps every edge on a pixel boundary. Model is
    // 32 units tall and (8 + 2*aw) wide.
    const modelW = 8 + aw * 2, modelH = 32;
    const scale = Math.max(1, Math.floor(Math.min(w / (modelW + 2), h / (modelH + 2))));
    const originX = Math.round((w - modelW * scale) / 2);
    const originY = Math.round((h - modelH * scale) / 2);

    // Blit one part: `layer` picks the prepared texture, mx/my are in model
    // units from the top-left of the model box.
    const blit = (layer, rect, mx, my) => {
      const [sx, sy, sw, sh] = rect;
      ctx.drawImage(
        layer, sx, sy, sw, sh,
        originX + mx * scale, originY + my * scale, sw * scale, sh * scale,
      );
    };

    const B = this.tex.base, O = this.tex.overlay;
    // In the back view the limbs swap sides so the figure reads correctly.
    const mirrored = this.view === 'back';
    const armLeftX = mirrored ? 8 + aw : 0;          // model-space x of "left arm"
    const armRightX = mirrored ? 0 : 8 + aw;
    const legLeftX = mirrored ? 4 : 8;
    const legRightX = mirrored ? 8 : 4;

    // torso row starts at y = 8, legs at y = 20
    blit(B, uv.armR, armRightX, 8);
    blit(B, uv.armL, armLeftX, 8);
    blit(B, uv.body, aw, 8);
    blit(B, uv.legR, legRightX, 20);
    blit(B, uv.legL, legLeftX, 20);
    blit(B, uv.head, aw, 0);

    if (this.showOverlay) {
      blit(O, uv.sleeveR, armRightX, 8);
      blit(O, uv.sleeveL, armLeftX, 8);
      blit(O, uv.jacket, aw, 8);
      blit(O, uv.pantR, legRightX, 20);
      blit(O, uv.pantL, legLeftX, 20);
      blit(O, uv.hat, aw, 0);
    }
  };

  global.Skin2D = Skin2D;
})(window);
