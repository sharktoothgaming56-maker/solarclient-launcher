// Local Fabric dependency solver for the crash fixer. Reads every mod's
// fabric.mod.json (jar-in-jar mods included), finds everything Fabric would
// reject, and works out a set of changes — other Modrinth builds, missing
// mods, mods turned off — re-checking the WHOLE mod set after every change.
// Fabric only reports the first layer of a conflict; fixing just that layer
// is how a "fix" turns into the same crash again on the next launch.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const HEADERS = { 'User-Agent': 'SolarClient-Launcher (crash-fixer)' };
const CACHE_DIR = path.join(os.tmpdir(), 'solarclient-fix-cache');
// Provided by Fabric Loader itself.
const ALWAYS_PRESENT = new Set(['mixinextras', 'fabric-loader']);
const NEVER_DISABLE = new Set(['fabric-api', 'fabric', 'fabricloader', 'solarclient', 'quilted_fabric_api', 'qsl']);
const SLUG_ALIASES = {
  fabric: 'fabric-api',
  cloth_config: 'cloth-config',
  'cloth-config2': 'cloth-config',
  architectury: 'architectury-api',
  owo: 'owo-lib',
  yet_another_config_lib_v3: 'yacl',
  yet_another_config_lib: 'yacl',
};

// ---------------------------------------------------------------- versions
// Fabric semantics: numeric parts compared in order, "-..." is a pre-release
// (older than the release), "+..." build metadata is ignored, a bare trailing
// "-" is the lowest possible pre-release, and x/X/* are wildcards.

function parseVer(s) {
  const m = /^v?((?:\d+|[xX*])(?:\.(?:\d+|[xX*]))*)(-[0-9A-Za-z.\-]*)?(?:\+.*)?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  return { nums: m[1].split('.').map(n => (/^\d+$/.test(n) ? Number(n) : null)), pre: m[2] == null ? null : m[2].slice(1) };
}

function cmpVer(a, b) {
  const len = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < len; i++) {
    const d = (a.nums[i] || 0) - (b.nums[i] || 0);
    if (d) return d;
  }
  if (a.pre == null || b.pre == null) return (a.pre == null ? 1 : 0) - (b.pre == null ? 1 : 0);
  const pa = a.pre ? a.pre.split('.') : [];
  const pb = b.pre ? b.pre.split('.') : [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] == null) return -1;
    if (pb[i] == null) return 1;
    const na = /^\d+$/.test(pa[i]), nb = /^\d+$/.test(pb[i]);
    if (na && nb) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function cmpLoose(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (pa && pb) return cmpVer(pa, pb);
  return String(a).localeCompare(String(b));
}

function satisfiesTerm(version, term) {
  const m = /^(>=|<=|>|<|=|~|\^)?(.*)$/.exec(term);
  const op = m[1] || '';
  const rhs = m[2];
  if (rhs === '*' || rhs === '') return true;
  const v = parseVer(version), r = parseVer(rhs);
  // Non-semantic versions can only be compared for equality.
  if (!v || !r) return op === '' || op === '=' ? String(version) === rhs : true;
  const wild = r.nums.indexOf(null);
  if (wild >= 0) return r.nums.slice(0, wild).every((n, i) => (v.nums[i] || 0) === n);
  const c = cmpVer(v, r);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '~': return c >= 0 && (v.nums[0] || 0) === (r.nums[0] || 0) && (v.nums[1] || 0) === (r.nums[1] || 0);
    case '^': return c >= 0 && (v.nums[0] || 0) === (r.nums[0] || 0);
    default: return c === 0;
  }
}

function satisfies(version, pred) {
  if (pred == null) return true;
  if (Array.isArray(pred)) return !pred.length || pred.some(p => satisfies(version, p));
  const s = String(pred).trim();
  if (!s || s === '*') return true;
  return s.split(/\s+/).every(t => satisfiesTerm(version, t));
}

const shortVer = (v) => String(v || '').split('+')[0];

// ---------------------------------------------------------------- jar metadata

function readMeta(zip) {
  const e = zip.getEntry('fabric.mod.json');
  if (!e) return null;
  const raw = zip.readAsText(e).replace(/^\uFEFF/, '');
  let j = null;
  try { j = JSON.parse(raw); } catch {
    try { j = JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' ')); } catch { return null; }
  }
  if (!j || !j.id) return null;
  return {
    id: String(j.id),
    version: String(j.version ?? '0'),
    name: j.name || j.id,
    depends: j.depends && typeof j.depends === 'object' ? j.depends : {},
    breaks: j.breaks && typeof j.breaks === 'object' ? j.breaks : {},
    provides: Array.isArray(j.provides) ? j.provides.map(String) : [],
    mixins: (j.mixins || []).map(m => (typeof m === 'string' ? m : m?.config)).filter(Boolean),
  };
}

function collectNested(zip, out, depth) {
  if (depth > 3) return;
  for (const e of zip.getEntries()) {
    if (!/^META-INF\/jars\/.+\.jar$/i.test(e.entryName)) continue;
    try {
      const AdmZip = require('adm-zip');
      const nz = new AdmZip(e.getData());
      const m = readMeta(nz);
      if (m) out.push({ ...m, nested: true });
      collectNested(nz, out, depth + 1);
    } catch { /* unreadable nested jar */ }
  }
}

function indexJar(abs) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(abs);
  const top = readMeta(zip);
  const mods = top ? [top] : [];
  collectNested(zip, mods, 0);
  return { top, mods };
}

function indexModsDir(modsDir) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(modsDir); } catch { return out; }
  for (const file of names) {
    if (!file.toLowerCase().endsWith('.jar')) continue;
    const abs = path.join(modsDir, file);
    try {
      const { top, mods } = indexJar(abs);
      if (!top) continue; // not a Fabric mod — Fabric ignores it too
      out.set(file, { file, abs, top, mods, mtime: fs.statSync(abs).mtimeMs, original: true });
    } catch { /* corrupt jar */ }
  }
  return out;
}

// ---------------------------------------------------------------- network

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function pruneCache() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const p = path.join(CACHE_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch { /* no cache yet */ }
}

async function fetchToCache(url, filename) {
  const tag = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12);
  const p = path.join(CACHE_DIR, `${tag}-${path.basename(filename)}`);
  if (fs.existsSync(p)) return p;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const part = `${p}.part`;
  fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(part, p);
  return p;
}

function slugFor(modId) {
  const id = String(modId).toLowerCase();
  if (SLUG_ALIASES[id]) return SLUG_ALIASES[id];
  if (/^fabric-.+-v\d+$/.test(id) || id.startsWith('fabric-api')) return 'fabric-api';
  return id;
}

// ---------------------------------------------------------------- solver

async function solve({ modsDir, versionNumber, loader, javaMajor, loaderVersion, onProgress }) {
  const ctx = { versionNumber, javaMajor, loaderVersion: loaderVersion || null };
  const loaders = loader === 'quilt' ? ['quilt', 'fabric'] : ['fabric'];
  onProgress?.('Reading your mods…');
  pruneCache();
  const orig = indexModsDir(modsDir);
  const state = new Map(orig);
  const removed = new Map();   // original file -> reason it's turned off
  const added = new Map();     // new file -> { jar, reason, replaces: original file | null }
  const swapped = new Set();   // mod ids already swapped once (no ping-pong)
  const triedInstall = new Set();
  const ignore = new Set();
  const notes = new Set();
  let loaderFix = null;
  const projectCache = new Map();
  const versionsCache = new Map();

  const versionsOf = (id, exclude) => {
    if (id === 'minecraft') return [{ version: ctx.versionNumber }];
    if (id === 'java') return ctx.javaMajor ? [{ version: String(ctx.javaMajor) }] : null;
    if (id === 'fabricloader') return ctx.loaderVersion ? [{ version: ctx.loaderVersion }] : null;
    const out = [];
    for (const jar of state.values()) {
      if (jar === exclude) continue;
      for (const m of jar.mods) if (m.id === id || m.provides.includes(id)) out.push({ version: m.version, jar, mod: m });
    }
    return out;
  };

  // Of several copies of one nested library Fabric loads only the newest,
  // so only that copy's own requirements matter.
  const activeNested = () => {
    const best = new Map();
    for (const jar of state.values()) {
      for (const m of jar.mods) {
        const cur = best.get(m.id);
        if (!cur || (!m.nested && cur.nested) || (m.nested === cur.nested && cmpLoose(m.version, cur.version) > 0)) best.set(m.id, m);
      }
    }
    return new Set(best.values());
  };

  const key = (p) => `${p.type}:${p.jar?.file || p.id}:${p.mod?.id || ''}:${p.dep || ''}`;

  const findProblems = () => {
    const problems = [];
    const byId = new Map();
    for (const jar of state.values()) {
      if (!byId.has(jar.top.id)) byId.set(jar.top.id, []);
      byId.get(jar.top.id).push(jar);
    }
    for (const [id, jars] of byId) if (jars.length > 1) problems.push({ type: 'duplicate', id, jars });
    const active = activeNested();
    for (const jar of state.values()) {
      for (const mod of jar.mods) {
        if (!active.has(mod)) continue;
        for (const [dep, pred] of Object.entries(mod.depends)) {
          if (ALWAYS_PRESENT.has(dep)) continue;
          const have = versionsOf(dep, null);
          if (have === null) continue;
          if (!have.length) problems.push({ type: 'missing', jar, mod, dep, pred });
          else if (!have.some(h => satisfies(h.version, pred))) problems.push({ type: 'wrong', jar, mod, dep, pred, have });
        }
        for (const [dep, pred] of Object.entries(mod.breaks)) {
          const have = versionsOf(dep, jar);
          if (have && have.length && have.every(h => satisfies(h.version, pred))) problems.push({ type: 'breaks', jar, mod, dep, pred, have });
        }
      }
    }
    const order = { duplicate: 0, breaks: 1, wrong: 2, missing: 3 };
    return problems.filter(p => !ignore.has(key(p))).sort((a, b) => order[a.type] - order[b.type]);
  };

  const projectFor = async (jar) => {
    if (jar.project) return jar.project;
    const k = jar.file;
    if (projectCache.has(k)) return projectCache.get(k);
    let project = null;
    try {
      const sha1 = crypto.createHash('sha1').update(fs.readFileSync(jar.abs)).digest('hex');
      const v = await getJson(`${MODRINTH_API}/version_file/${sha1}?algorithm=sha1`);
      if (v?.project_id) {
        const p = await getJson(`${MODRINTH_API}/project/${v.project_id}`);
        if (p) project = { id: p.id, slug: p.slug, title: p.title, icon: p.icon_url || '' };
      }
    } catch { /* not on Modrinth */ }
    if (!project) project = await projectForId(jar.top.id);
    projectCache.set(k, project);
    return project;
  };

  const projectForId = async (modId) => {
    const k = `id:${modId}`;
    if (projectCache.has(k)) return projectCache.get(k);
    let project = null;
    const direct = await getJson(`${MODRINTH_API}/project/${encodeURIComponent(slugFor(modId))}`);
    if (direct && direct.project_type === 'mod') project = { id: direct.id, slug: direct.slug, title: direct.title, icon: direct.icon_url || '' };
    else {
      const n = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const facets = [['project_type:mod'], [`versions:${versionNumber}`]];
      const s = await getJson(`${MODRINTH_API}/search?limit=10&query=${encodeURIComponent(modId.replace(/[_-]/g, ' '))}&facets=${encodeURIComponent(JSON.stringify(facets))}`);
      const hit = (s?.hits || []).find(h => n(h.slug) === n(modId) || n(h.title) === n(modId));
      if (hit) project = { id: hit.project_id, slug: hit.slug, title: hit.title, icon: hit.icon_url || '' };
    }
    projectCache.set(k, project);
    return project;
  };

  // Modrinth builds of a project for this game version, stable first, each
  // downloaded to a cache and indexed so its real metadata can be checked.
  async function* candidates(project) {
    if (!project) return;
    if (!versionsCache.has(project.id)) {
      const params = new URLSearchParams({ game_versions: JSON.stringify([versionNumber]), loaders: JSON.stringify(loaders) });
      versionsCache.set(project.id, (await getJson(`${MODRINTH_API}/project/${project.id}/version?${params}`)) || []);
    }
    const list = versionsCache.get(project.id);
    const ordered = [...list.filter(v => v.version_type === 'release'), ...list.filter(v => v.version_type !== 'release')].slice(0, 12);
    for (const v of ordered) {
      const f = (v.files || []).find(x => x.primary) || (v.files || [])[0];
      if (!f?.url || !f?.filename) continue;
      try {
        onProgress?.(`Checking ${project.title} ${v.version_number}…`);
        const abs = await fetchToCache(f.url, f.filename);
        const { top, mods } = indexJar(abs);
        if (!top) continue;
        yield { file: path.basename(f.filename), abs, top, mods, project, ver: { id: v.id, number: v.version_number, url: f.url, filename: path.basename(f.filename) } };
      } catch { /* try the next build */ }
    }
  }

  const removeJar = (jar, reason) => {
    state.delete(jar.file);
    if (jar.original) removed.set(jar.file, reason);
    else added.delete(jar.file);
  };
  const swapJar = (oldJar, newJar, reason) => {
    const replaces = oldJar.original ? oldJar.file : (added.get(oldJar.file)?.replaces || null);
    state.delete(oldJar.file);
    if (!oldJar.original) added.delete(oldJar.file);
    state.set(newJar.file, newJar);
    added.set(newJar.file, { jar: newJar, reason, replaces });
    swapped.add(newJar.top.id);
  };
  const disable = (jar, reason) => {
    if (NEVER_DISABLE.has(jar.top.id)) return false;
    removeJar(jar, reason);
    return true;
  };
  const modIn = (jar, id) => jar.mods.find(m => m.id === id || m.provides.includes(id));

  // Swap `jar` for the first candidate build that `accept` likes.
  const trySwap = async (jar, accept, reason) => {
    if (swapped.has(jar.top.id)) return false;
    const project = await projectFor(jar);
    for await (const c of candidates(project)) {
      if (c.top.id !== jar.top.id || c.top.version === jar.top.version) continue;
      if (accept(c)) { swapJar(jar, c, reason); return true; }
    }
    swapped.add(jar.top.id); // nothing usable; don't look again
    return false;
  };

  const newestLoader = async () => {
    const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(versionNumber)}`);
    const pick = Array.isArray(list) ? (list.find(l => l.loader?.stable) || list[0]) : null;
    return pick?.loader?.version || null;
  };

  const resolve = async (p) => {
    if (p.type === 'duplicate') {
      const sorted = p.jars.slice().sort((a, b) => cmpLoose(b.top.version, a.top.version) || (b.mtime || 0) - (a.mtime || 0));
      for (const j of sorted.slice(1)) removeJar(j, `Duplicate of ${sorted[0].top.name} ${shortVer(sorted[0].top.version)}`);
      return true;
    }

    if (p.type === 'missing') {
      if (p.dep === 'minecraft' || p.dep === 'java' || p.dep === 'fabricloader') return false;
      const project = await projectForId(p.dep);
      if (project && !triedInstall.has(`${project.id}:${p.dep}`)) {
        triedInstall.add(`${project.id}:${p.dep}`);
        for await (const c of candidates(project)) {
          const m = modIn(c, p.dep);
          if (m && satisfies(m.version, p.pred) && !state.has(c.file)) {
            state.set(c.file, c);
            added.set(c.file, { jar: c, reason: `Needed by ${p.mod.name}`, replaces: null });
            return true;
          }
        }
      }
      if (disable(p.jar, `Needs ${p.dep}, which isn't available for ${versionNumber}`)) return true;
      notes.add(`${p.mod.name} needs ${p.dep}, which SolarClient couldn't find for ${versionNumber}.`);
      return false;
    }

    if (p.type === 'wrong') {
      if (p.dep === 'fabricloader' && loader === 'fabric') {
        const lv = await newestLoader();
        if (lv && lv !== ctx.loaderVersion && satisfies(lv, p.pred)) { ctx.loaderVersion = lv; loaderFix = lv; return true; }
      }
      const accepts = (c) => {
        const m = c.mods.find(x => x.id === p.mod.id) || c.top;
        const pred = m.depends[p.dep];
        if (pred == null) return true;
        const have = versionsOf(p.dep, null);
        return have === null || have.some(h => satisfies(h.version, pred));
      };
      if (!['minecraft', 'java', 'fabricloader'].includes(p.dep)) {
        // Move the dependency into the range this mod needs...
        for (const h of p.have) {
          if (!h.jar || h.jar === p.jar) continue;
          if (await trySwap(h.jar, c => { const m = modIn(c, p.dep); return !!m && satisfies(m.version, p.pred); }, `${p.mod.name} needs a different version`)) return true;
        }
      }
      // ...or use a build of this mod that accepts what's installed.
      const why = p.dep === 'minecraft' ? `Made for a different Minecraft version` : `Needs a different ${p.dep}`;
      if (await trySwap(p.jar, accepts, why)) return true;
      if (disable(p.jar, `${why} — no working version for ${versionNumber}`)) return true;
      return false;
    }

    if (p.type === 'breaks') {
      // Move the other mod out of the broken range...
      for (const h of p.have) {
        if (!h.jar) continue;
        if (await trySwap(h.jar, c => { const m = modIn(c, p.dep); return !!m && !satisfies(m.version, p.pred); }, `${p.mod.name} doesn't work with the old version`)) return true;
      }
      // ...or use a build of this mod that doesn't break it...
      const brokenOk = (c) => {
        const m = c.mods.find(x => x.id === p.mod.id) || c.top;
        const pred = m.breaks[p.dep];
        return pred == null || !p.have.every(h => satisfies(h.version, pred));
      };
      if (await trySwap(p.jar, brokenOk, `Didn't work with ${p.have[0]?.mod?.name || p.dep}`)) return true;
      // ...otherwise turn one of them off.
      const target = p.have.find(h => h.jar && !NEVER_DISABLE.has(h.jar.top.id))?.jar;
      if (target && disable(target, `Doesn't work with ${p.mod.name}`)) return true;
      if (disable(p.jar, `Doesn't work with ${p.have[0]?.mod?.name || p.dep}`)) return true;
      return false;
    }
    return false;
  };

  for (let step = 0; step < 40; step++) {
    const problems = findProblems();
    if (!problems.length) break;
    const p = problems[0];
    if (!(await resolve(p))) ignore.add(key(p));
  }
  const remaining = findProblems();

  // Turn the end state into concrete fix records.
  const fixes = [];
  for (const [file, jar] of orig) {
    if (state.has(file)) continue;
    const repl = [...added.values()].find(a => a.replaces === file);
    if (repl) {
      const older = cmpLoose(repl.jar.top.version, jar.top.version) < 0;
      fixes.push({
        id: `update:${file}`, kind: 'update', files: [file], staged: repl.jar.abs, filename: repl.jar.file, project: repl.jar.project, ver: repl.jar.ver,
        label: `${older ? 'Switch' : 'Update'} ${jar.top.name} to ${shortVer(repl.jar.top.version)}`, detail: repl.reason,
      });
    } else {
      fixes.push({ id: `disable:${file}`, kind: 'disable', file, label: `Turn off ${jar.top.name}`, detail: removed.get(file) || 'Conflicts with your other mods' });
    }
  }
  for (const a of added.values()) {
    if (a.replaces) continue;
    fixes.push({
      id: `install:${a.jar.file}`, kind: 'install', staged: a.jar.abs, filename: a.jar.file, project: a.jar.project, ver: a.jar.ver,
      label: `Install ${a.jar.top.name} ${shortVer(a.jar.top.version)}`, detail: a.reason,
    });
  }
  if (loaderFix) fixes.push({ id: 'loader', kind: 'loader', label: `Update Fabric Loader to ${loaderFix}`, detail: 'Your mods need a newer loader' });

  return { fixes, remaining: remaining.length, notes: [...notes], index: orig };
}

function installedLoaderVersion(instanceDir, loader, versionNumber) {
  if (loader !== 'fabric') return null;
  try {
    const found = fs.readdirSync(path.join(instanceDir, 'versions'))
      .map(d => new RegExp(`^fabric-loader-(.+)-${versionNumber.replace(/\./g, '\\.')}$`).exec(d)?.[1])
      .filter(Boolean)
      .sort((a, b) => cmpLoose(b, a));
    return found[0] || null;
  } catch { return null; }
}

module.exports = { solve, installedLoaderVersion, indexModsDir, satisfies, cmpLoose };
