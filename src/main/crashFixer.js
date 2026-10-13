// Works out why a game crashed and what can actually be done about it, then
// does it. analyze() only reads (launch log, newest crash report, the mods
// folder, Modrinth — candidate jars are staged in a temp cache); apply() is
// the only part that changes the instance. Fix records stay in the main
// process — the renderer only sees ids/labels.
const fs = require('fs');
const path = require('path');
const os = require('os');
const CRASH_PATTERNS = require('./crashPatterns');
const modSolver = require('./modSolver');

const HEADERS = { 'User-Agent': 'SolarClient-Launcher (crash-fixer)' };

// Never turned off by the crash-log heuristics: the game, the loader and its
// API, and our own mod (the launcher re-installs it on every launch anyway).
const PROTECTED = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'fabric-api', 'fabric',
  'forge', 'neoforge', 'solarclient', 'mixinextras', 'quilted_fabric_api',
]);
const MOD_ID = '[a-z0-9_\\-.]+';

function listEnabledJars(instanceDir) {
  try { return fs.readdirSync(path.join(instanceDir, 'mods')).filter(f => f.toLowerCase().endsWith('.jar')); } catch { return []; }
}

function disableFix(jar, why) {
  return { id: `disable:${jar.file}`, kind: 'disable', file: jar.file, label: `Turn off ${jar.top.name}`, detail: why };
}

function latestCrashReport(dir, since) {
  const d = path.join(dir, 'crash-reports');
  try {
    const files = fs.readdirSync(d)
      .filter(f => f.endsWith('.txt'))
      .map(f => ({ p: path.join(d, f), t: fs.statSync(path.join(d, f)).mtimeMs }))
      .filter(x => x.t >= since - 5000)
      .sort((a, b) => b.t - a.t);
    return files[0]?.p || null;
  } catch { return null; }
}

function allMatches(re, text) {
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m);
  return out;
}

async function analyze({ log, dir, versionNumber, loader, memoryMaxGB, startedAt, javaMajor, goodMods, onProgress }) {
  const modsDir = path.join(dir, 'mods');
  const modded = loader === 'fabric' || loader === 'quilt';
  const reportPath = latestCrashReport(dir, startedAt || 0);
  let report = '';
  if (reportPath) { try { report = fs.readFileSync(reportPath, 'utf-8').slice(0, 400 * 1024); } catch { /* ok */ } }
  const text = `${log || ''}\n${report}`;

  const fixes = new Map();
  const add = (f) => { if (f && !fixes.has(f.id)) fixes.set(f.id, f); };
  const notes = new Set();
  let wantLoader = false;
  let wantJava = false;

  if (modded) {
    // Every declared dependency / incompatibility, checked across the whole
    // mod set until it's consistent — covers what Fabric's error shows and
    // everything it would show after that.
    const solved = await modSolver.solve({
      modsDir, versionNumber, loader, javaMajor,
      loaderVersion: modSolver.installedLoaderVersion(dir, loader, versionNumber),
      onProgress,
    });
    for (const f of solved.fixes) add(f);
    for (const n of solved.notes) notes.add(n);
    const index = [...solved.index.values()];
    const touched = new Set(solved.fixes.flatMap(f => f.files || (f.file ? [f.file] : [])));
    const jarsFor = (id) => index.filter(j => !touched.has(j.file) && j.mods.some(m => m.id === id || m.provides.includes(id)));

    if (!solved.fixes.length) {
      // Mixin failures name the mod that owns the broken injection.
      const mixinErr = /Mixin (?:apply|transformation|prepare)[^\n]*fail|InvalidInjectionException|InjectionError|MixinApplyError|MixinTargetAlreadyLoadedException|Critical injection failure/gi;
      const culprits = new Set();
      for (const m of allMatches(mixinErr, text)) {
        const win = text.slice(Math.max(0, m.index - 300), m.index + 1500);
        for (const f of allMatches(new RegExp(`(?:from mod|for mod) (${MOD_ID})`, 'gi'), win)) culprits.add(f[1].toLowerCase());
        for (const f of allMatches(/([\w\-.]+\.mixins?\.json)/gi, win)) {
          const owner = index.find(j => j.top.mixins.includes(f[1]));
          if (owner) culprits.add(owner.top.id);
        }
      }
      for (const id of culprits) {
        if (PROTECTED.has(id)) continue;
        for (const j of jarsFor(id)) add(disableFix(j, 'Its code injection crashed the game'));
      }

      // Vanilla crash reports list suspects when a mod is in the stack trace.
      const suspects = /Suspected Mods?:([\s\S]*?)(?:\n\s*\n|Stacktrace:)/i.exec(report);
      if (suspects && !/^\s*None/i.test(suspects[1])) {
        for (const m of allMatches(new RegExp(`^\\s*([^\\n(]+?) \\((${MOD_ID})\\), Version:`, 'gim'), suspects[1])) {
          const id = m[2].toLowerCase();
          if (PROTECTED.has(id)) continue;
          for (const j of jarsFor(id)) add(disableFix(j, 'Named in the crash report'));
        }
      }

      if (/Unsupported class file major version/i.test(text)) wantLoader = true;

      // Nothing concrete — fall back to whatever was added since the last
      // launch that exited cleanly.
      if (fixes.size === 0 && !wantLoader && Array.isArray(goodMods)) {
        const good = new Set(goodMods);
        for (const j of index.filter(x => !good.has(x.file))) {
          if (PROTECTED.has(j.top.id)) continue;
          add(disableFix(j, 'Added since your last launch that worked'));
        }
      }
    }
  }

  // Broken or unreadable mod config — move it aside so the mod writes a fresh default.
  const cfgRoot = path.join(dir, 'config');
  const cfgRe = [
    /(?:Failed to (?:load|read|parse)|Error (?:loading|reading|parsing)|Could not (?:load|read|parse)|JsonSyntaxException|MalformedJsonException|ParsingException|Invalid config)[^\n]*?\bconfig[\\/]([\w\-. \\/]+?\.(?:json5?|toml|properties|cfg|ya?ml|txt))/gi,
    /\bconfig[\\/]([\w\-. \\/]+?\.(?:json5?|toml|properties|cfg|ya?ml|txt))[^\n]*?(?:corrupt|malformed|invalid|failed|error|exception)/gi,
  ];
  for (const re of cfgRe) {
    for (const m of allMatches(re, text)) {
      const abs = path.resolve(cfgRoot, m[1].trim());
      if (!abs.startsWith(cfgRoot + path.sep) || !fs.existsSync(abs)) continue;
      const rel = path.relative(cfgRoot, abs);
      add({ id: `config:${rel}`, kind: 'config', rel, label: `Reset config ${rel}`, detail: 'The file is broken — the mod will make a fresh one' });
    }
  }

  // A mod drawing with a vanilla vertex layout while an Iris shader pack is on
  // (Essential cosmetics, some emote/model mods). The SolarClient mod patches
  // this, but turning shaders off always works.
  if (modded && /Missing elements in vertex/i.test(text)) {
    const irisCfg = path.join(dir, 'config', 'iris.properties');
    const hasIris = listEnabledJars(dir).some(f => /^iris/i.test(f));
    let shadersOn = true;
    try { shadersOn = !/^\s*enableShaders\s*=\s*false\s*$/im.test(fs.readFileSync(irisCfg, 'utf-8')); } catch { /* no config yet */ }
    if (hasIris && shadersOn) {
      add({ id: 'shaders-off', kind: 'shaders-off', label: 'Turn off shaders', detail: 'A mod drew something your shader pack can\'t handle — you can turn them back on in Iris settings' });
    }
  }

  const totalGB = Math.floor(os.totalmem() / 1073741824);
  const cur = Number(memoryMaxGB) || 4;
  if (/OutOfMemoryError/i.test(text)) {
    const to = Math.min(cur + 2, Math.max(2, Math.floor(totalGB * 0.6)));
    if (to > cur) add({ id: 'memory', kind: 'memory', toGB: to, label: `Raise memory to ${to} GB`, detail: `The game ran out of its ${cur} GB` });
  } else if (/Could not reserve enough space for|Initial heap size set to a larger value|Invalid maximum heap size/i.test(text)) {
    const to = Math.max(2, Math.min(cur - 2, Math.floor(totalGB * 0.5)));
    if (to < cur) add({ id: 'memory', kind: 'memory', toGB: to, label: `Lower memory to ${to} GB`, detail: `Your PC couldn't give Java ${cur} GB` });
  }

  const pattern = CRASH_PATTERNS.find(p => p.test.test(text));
  if (pattern?.fixable === 'java') wantJava = true;
  if (wantJava && javaMajor) add({ id: 'java', kind: 'java', javaMajor, label: `Re-download Java ${javaMajor}`, detail: 'The Java runtime is missing, broken, or the wrong version' });
  if (wantLoader && modded && !fixes.has('loader')) {
    const name = loader === 'fabric' ? 'Fabric' : 'Quilt';
    add({ id: 'loader', kind: 'loader', label: `Update ${name} Loader`, detail: 'Your mods need a newer loader than the one installed' });
  }

  const list = [...fixes.values()];
  let summary;
  if (list.length) summary = `SolarClient found ${list.length === 1 ? 'a fix' : `${list.length} fixes`} for this crash.`;
  else if (pattern) summary = pattern.suggestion;
  else summary = "SolarClient couldn't pinpoint what crashed the game.";
  if (notes.size) summary += ` ${[...notes].join(' ')}`;
  return { summary, fixes: list, reportPath };
}

// ---------------------------------------------------------------- apply

async function placeJar(f, modsDir) {
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, path.basename(f.filename));
  if (f.staged && fs.existsSync(f.staged)) {
    fs.copyFileSync(f.staged, dest);
  } else {
    const res = await fetch(f.ver.url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
  }
  fs.rmSync(`${dest}.disabled`, { force: true }); // stale off-copy of the same file
}

async function apply(fixes, { dir, versionNumber, loader, reinstallJava, readModManifest, writeModManifest, onProgress }) {
  const modsDir = path.join(dir, 'mods');
  const results = [];
  let memoryMaxGB = null;
  const setManifest = (fileName, project) => {
    try {
      const manifest = readModManifest(modsDir);
      if (project) manifest[fileName] = { projectId: project.id, slug: project.slug || '', title: project.title || fileName, iconUrl: project.icon || '' };
      else delete manifest[fileName];
      writeModManifest(modsDir, manifest);
    } catch { /* cosmetic only */ }
  };

  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    onProgress?.(`${f.label}…`, Math.round((i / fixes.length) * 100));
    try {
      if (f.kind === 'install') {
        await placeJar(f, modsDir);
        setManifest(path.basename(f.filename), f.project);
      } else if (f.kind === 'update') {
        await placeJar(f, modsDir);
        for (const old of f.files) {
          if (old === f.filename) continue;
          fs.rmSync(path.join(modsDir, path.basename(old)), { force: true });
          setManifest(old, null);
        }
        setManifest(path.basename(f.filename), f.project);
      } else if (f.kind === 'disable') {
        const src = path.join(modsDir, path.basename(f.file));
        if (fs.existsSync(src)) {
          const dst = `${src}.disabled`;
          if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
          fs.renameSync(src, dst);
        }
      } else if (f.kind === 'config') {
        const root = path.join(dir, 'config');
        const abs = path.resolve(root, f.rel);
        if (!abs.startsWith(root + path.sep)) throw new Error('Bad config path');
        if (fs.existsSync(abs)) fs.renameSync(abs, `${abs}.broken-${Date.now()}`);
      } else if (f.kind === 'shaders-off') {
        const cfg = path.join(dir, 'config', 'iris.properties');
        let body = '';
        try { body = fs.readFileSync(cfg, 'utf-8'); } catch { /* fresh */ }
        body = /^\s*enableShaders\s*=.*$/im.test(body)
          ? body.replace(/^\s*enableShaders\s*=.*$/im, 'enableShaders=false')
          : `${body}${body && !body.endsWith('\n') ? '\n' : ''}enableShaders=false\n`;
        fs.mkdirSync(path.dirname(cfg), { recursive: true });
        fs.writeFileSync(cfg, body);
      } else if (f.kind === 'memory') {
        memoryMaxGB = f.toGB;
      } else if (f.kind === 'java') {
        await reinstallJava(f.javaMajor, onProgress);
      } else if (f.kind === 'loader') {
        // Dropping the cached profile makes the next launch fetch the newest stable loader.
        const versionsDir = path.join(dir, 'versions');
        for (const d of fs.existsSync(versionsDir) ? fs.readdirSync(versionsDir) : []) {
          if (d.startsWith(`${loader}-loader-`) && d.endsWith(`-${versionNumber}`)) {
            fs.rmSync(path.join(versionsDir, d), { recursive: true, force: true });
          }
        }
      }
      results.push({ id: f.id, label: f.label, ok: true });
    } catch (err) {
      results.push({ id: f.id, label: f.label, ok: false, error: err.message });
    }
  }
  onProgress?.('Done', 100);
  return { results, memoryMaxGB };
}

module.exports = { analyze, apply, listEnabledJars };
