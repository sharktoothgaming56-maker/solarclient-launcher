// =====================================================================
// BACKGROUNDS — procedurally drawn pixel-art landscape scenes, generated
// as SVG data URIs at runtime. Original block art (nothing ripped from
// the game), but instantly readable as Minecraft-style biomes. Costs a
// few KB of code instead of megabytes of bundled images.
// =====================================================================

(function () {
  const W = 96, H = 54, PX = 20; // 96x54 pixel grid rendered at 1920x1080

  // deterministic rng so every user sees the same scene
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // smooth-ish terrain heightmap
  function heightmap(rand, base, amp, roughness) {
    const h = [];
    let y = base;
    for (let x = 0; x < W; x++) {
      y += (rand() - 0.5) * roughness;
      y = Math.max(base - amp, Math.min(base + amp, y));
      h.push(Math.round(y));
    }
    // simple smoothing pass
    for (let x = 1; x < W - 1; x++) h[x] = Math.round((h[x - 1] + h[x] + h[x + 1]) / 3);
    return h;
  }

  function esc(c) { return c.replace('#', '%23'); }

  class Scene {
    constructor() { this.parts = []; }
    rect(x, y, w, h, color, opacity) {
      this.parts.push(`<rect x='${x * PX}' y='${y * PX}' width='${w * PX}' height='${h * PX}' fill='${color}'${opacity != null ? ` opacity='${opacity}'` : ''}/>`);
      return this;
    }
    sky(stops) {
      const id = 'g' + Math.random().toString(36).slice(2, 7);
      const stopEls = stops.map(([off, c]) => `<stop offset='${off}' stop-color='${c}'/>`).join('');
      this.parts.unshift(
        `<defs><linearGradient id='${id}' x1='0' y1='0' x2='0' y2='1'>${stopEls}</linearGradient></defs>` +
        `<rect width='${W * PX}' height='${H * PX}' fill='url(%23${id})'/>`
      );
      return this;
    }
    // terrain from heightmap: top layer, dirt band, deep fill
    terrain(hm, top, mid, deep, topThick = 1, midThick = 3) {
      for (let x = 0; x < W; x++) {
        const y = hm[x];
        this.rect(x, y, 1, topThick, top);
        this.rect(x, y + topThick, 1, midThick, mid);
        this.rect(x, y + topThick + midThick, 1, H - y, deep);
      }
      return this;
    }
    // distant silhouette range
    range(hm, color, opacity) {
      for (let x = 0; x < W; x++) this.rect(x, hm[x], 1, H - hm[x], color, opacity);
      return this;
    }
    tree(x, groundY, trunk, leaves, size = 2) {
      const th = 2 + size;                       // trunk height
      this.rect(x, groundY - th, 1, th, trunk);  // trunk
      const ly = groundY - th - 2 - size;        // leaf blob
      this.rect(x - size, ly + 1, size * 2 + 1, size + 1, leaves);
      this.rect(x - size + 1, ly, size * 2 - 1, 1, leaves);
      return this;
    }
    cloud(x, y, len, color = '#ffffff', op = 0.85) {
      this.rect(x, y, len, 1, color, op);
      this.rect(x + 1, y - 1, len - 2, 1, color, op);
      return this;
    }
    stars(rand, count, maxY, color = '#ffffff') {
      for (let i = 0; i < count; i++) {
        const x = Math.floor(rand() * W), y = Math.floor(rand() * maxY);
        this.parts.push(`<rect x='${x * PX + 6}' y='${y * PX + 6}' width='7' height='7' fill='${color}' opacity='${(0.35 + rand() * 0.6).toFixed(2)}'/>`);
      }
      return this;
    }
    url() {
      const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W * PX}' height='${H * PX}' shape-rendering='crispEdges'>${this.parts.join('')}</svg>`;
      return `url("data:image/svg+xml,${esc(svg).replace(/'/g, '%27').replace(/#/g, '%23')}")`;
    }
  }

  function plains() {
    const r = rng(1401);
    const s = new Scene().sky([[0, '#6db3f2'], [0.6, '#a5d8ff'], [1, '#d7ecff']]);
    s.rect(78, 5, 5, 5, '#fff3a3');                             // sun
    s.cloud(8, 7, 9); s.cloud(34, 4, 7); s.cloud(58, 9, 11); s.cloud(20, 13, 6, '#ffffff', 0.6);
    s.range(heightmap(r, 30, 4, 2.2), '#7fae6b', 0.55);          // far hills
    const hm = heightmap(r, 38, 4, 2.6);
    s.terrain(hm, '#5cbf4a', '#7a5230', '#5b5f66');
    [10, 26, 47, 63, 82].forEach((x, i) => s.tree(x, hm[x], '#6b4527', '#3f8c33', i % 2 ? 2 : 3));
    for (let i = 0; i < 26; i++) { const x = Math.floor(r() * W); s.rect(x, hm[x] - 1, 1, 1, '#79d65e'); } // grass tufts
    return s.url();
  }

  function sunset() {
    const r = rng(77);
    const s = new Scene().sky([[0, '#2b1a4d'], [0.35, '#7a2e63'], [0.62, '#e0653f'], [0.8, '#f7b267'], [1, '#ffd9a0']]);
    s.stars(r, 26, 14);
    s.rect(70, 18, 6, 6, '#ffd28f'); s.rect(69, 19, 8, 4, '#ffd28f'); // low sun
    s.range(heightmap(r, 30, 5, 3), '#4a2450', 0.85);
    const hm = heightmap(r, 37, 4, 2.4);
    s.terrain(hm, '#3a2b45', '#2c2136', '#1d1628');              // silhouette land
    [16, 40, 74].forEach(x => s.tree(x, hm[x], '#241a2e', '#312242', 3));
    return s.url();
  }

  function cherry() {
    const r = rng(2024);
    const s = new Scene().sky([[0, '#8fb8e8'], [0.55, '#cfd8f5'], [1, '#f6dcef']]);
    s.cloud(14, 6, 8); s.cloud(52, 10, 10); s.cloud(78, 5, 6);
    s.range(heightmap(r, 28, 5, 2.4), '#9db4d6', 0.6);           // misty mountains
    const hm = heightmap(r, 38, 3, 2.2);
    s.terrain(hm, '#69c256', '#7a5230', '#5b5f66');
    [9, 22, 37, 55, 70, 86].forEach((x, i) => s.tree(x, hm[x], '#5c3a2e', i % 2 ? '#f2a6d8' : '#ec8fce', 3));
    for (let i = 0; i < 34; i++) { const x = Math.floor(r() * W), y = Math.floor(r() * 30); s.rect(x, y, 1, 1, '#f7bce3', 0.8); } // petals
    return s.url();
  }

  function ocean() {
    const r = rng(303);
    const s = new Scene().sky([[0, '#0d3f6e'], [0.45, '#125a8f'], [1, '#083152']]);
    for (let i = 0; i < 20; i++) { const x = Math.floor(r() * W); s.rect(x, Math.floor(r() * 8), 1, 1, '#bfe6ff', 0.35); } // light shafts hint
    const hm = heightmap(r, 42, 4, 2.6);
    s.terrain(hm, '#d8c98f', '#b3a06b', '#243b4d');              // sandy floor
    [12, 30, 51, 72, 88].forEach(x => { const gh = hm[x]; const kh = 5 + Math.floor(r() * 5); for (let k = 0; k < kh; k++) s.rect(x, gh - 1 - k, 1, 1, k % 2 ? '#2e8b57' : '#39a86a'); }); // kelp
    [20, 60].forEach(x => { s.rect(x, hm[x] - 2, 3, 2, '#e07b54'); s.rect(x + 1, hm[x] - 3, 1, 1, '#e07b54'); }); // coral
    for (let i = 0; i < 24; i++) s.rect(Math.floor(r() * W), Math.floor(r() * 40), 1, 1, '#cfe9ff', 0.5); // bubbles
    return s.url();
  }

  function nether() {
    const r = rng(666);
    const s = new Scene().sky([[0, '#2a0d0d'], [0.6, '#4a1414'], [1, '#611616']]);
    for (let x = 0; x < W; x++) s.rect(x, 0, 1, 3 + Math.floor(r() * 3), '#3a0f10'); // netherrack ceiling
    const hm = heightmap(r, 40, 4, 3);
    for (let x = 0; x < W; x++) s.rect(x, 46, 1, H - 46, '#ff7b1c');                 // lava sea
    for (let x = 0; x < W; x += 2) if (r() > 0.6) s.rect(x, 46, 1, 1, '#ffc14d');    // lava glow
    for (let x = 0; x < W; x++) if (hm[x] < 46) { s.rect(x, hm[x], 1, 46 - hm[x], '#5a1a1c'); s.rect(x, hm[x], 1, 1, '#742426'); } // shores
    [18, 46, 76].forEach(x => { const h2 = 8 + Math.floor(r() * 6); s.rect(x, 46 - h2, 2, h2, '#3f1113'); }); // basalt-ish pillars
    for (let i = 0; i < 18; i++) s.rect(Math.floor(r() * W), 10 + Math.floor(r() * 30), 1, 1, '#ff9d45', 0.7); // embers
    return s.url();
  }

  function endVoid() {
    const r = rng(9999);
    const s = new Scene().sky([[0, '#0b0714'], [0.6, '#171029'], [1, '#0b0714']]);
    s.stars(r, 70, 50, '#cdb8ff');
    const islands = [[6, 30, 20], [38, 22, 26], [74, 34, 16]];   // [x, y, width]
    for (const [ix, iy, iw] of islands) {
      for (let x = 0; x < iw; x++) {
        const depth = Math.max(1, Math.round((1 - Math.abs(x - iw / 2) / (iw / 2)) * 7));
        s.rect(ix + x, iy, 1, 1, '#e8e2b8');                     // end stone top
        s.rect(ix + x, iy + 1, 1, depth, '#cfc79b');
      }
    }
    s.rect(46, 8, 3, 14, '#1a1024'); s.rect(46, 8, 3, 1, '#7a4fd1'); // obsidian pillar + crystal glow
    s.rect(12, 26, 2, 4, '#1a1024');
    for (let i = 0; i < 10; i++) s.rect(Math.floor(r() * W), Math.floor(r() * H), 1, 1, '#a78bfa', 0.5); // drifting motes
    return s.url();
  }

  function frozen() {
    const r = rng(555);
    const s = new Scene().sky([[0, '#0e1b3a'], [0.5, '#20345f'], [1, '#3d5a8a']]);
    s.stars(r, 40, 20);
    s.rect(14, 4, 4, 4, '#eef3ff'); // moon
    // aurora bands
    for (let x = 0; x < W; x++) {
      const y = 8 + Math.round(Math.sin(x / 7) * 3);
      s.rect(x, y, 1, 2, '#6ff2c6', 0.28); s.rect(x, y + 3, 1, 1, '#8f7bff', 0.22);
    }
    s.range(heightmap(r, 26, 7, 3.4), '#5f7bab', 0.7);
    const hm = heightmap(r, 36, 5, 3);
    s.terrain(hm, '#eef4fb', '#c9d8ea', '#8fa6c4');
    [24, 58, 80].forEach(x => { s.rect(x, hm[x] - 5, 1, 5, '#3e6b4f'); s.rect(x - 1, hm[x] - 4, 3, 3, '#4f8a63'); s.rect(x - 1, hm[x] - 1, 3, 1, '#eef4fb'); }); // snowy spruce
    for (let i = 0; i < 30; i++) s.rect(Math.floor(r() * W), Math.floor(r() * H), 1, 1, '#ffffff', 0.6); // snowfall
    return s.url();
  }

  window.NEBULA_BACKGROUNDS = {
    nebula:  { name: 'Solar',        kind: 'nebula' },
    plains:  { name: 'Sunny Plains',  kind: 'scene', make: plains },
    sunset:  { name: 'Savanna Sunset',kind: 'scene', make: sunset },
    cherry:  { name: 'Cherry Grove',  kind: 'scene', make: cherry },
    frozen:  { name: 'Frozen Peaks',  kind: 'scene', make: frozen },
    ocean:   { name: 'Deep Ocean',    kind: 'scene', make: ocean },
    nether:  { name: 'The Nether',    kind: 'scene', make: nether },
    end:     { name: 'The End',       kind: 'scene', make: endVoid },
    void:    { name: 'Pure Void',     kind: 'void' },
  };
})();
