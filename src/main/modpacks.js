// =====================================================================
// MODPACKS — Modrinth's .mrpack format, in both directions.
//
// An .mrpack is a zip holding modrinth.index.json (the Minecraft version,
// the loader, and a list of files to download with their hashes) plus an
// overrides/ folder of files copied in as-is. Importing one builds a new
// instance from it; exporting turns an instance's mods, resource packs,
// shader packs and config into one file a friend can import in a click —
// in SolarClient or any launcher that reads the format.
// =====================================================================
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MODRINTH_API = 'https://api.modrinth.com/v2';
const SUPPORTED_LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge' };
const LOADER_DEP_KEY = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge' };
// The format restricts downloads to these hosts; anything else in an index
// is either a broken pack or an attempt to fetch from somewhere it shouldn't.
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com',
]);
// Folders an export carries. Saves, logs, crash reports and the launcher's
// own runtime files stay behind.
const EXPORT_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks', 'config'];
const EXPORT_FILES = ['options.txt'];
// The SolarClient mod and pack are put in place by the launcher itself on
// every launch, so shipping a copy would only leave a stale duplicate.
const SKIP_EXPORT = [/^solarclient-.*\.jar(\.disabled)?$/i, /^SolarResourcePack\.zip$/i];

/** A path from inside a pack, resolved under `root` — or null if it escapes it. */
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/');
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean)) return null;
  const out = path.resolve(root, clean);
  const base = path.resolve(root) + path.sep;
  return out.startsWith(base) ? out : null;
}

function cleanInstanceName(name) {
  const n = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\.+$/, '').trim().slice(0, 48);
  return n || 'Modpack';
}

function hashBuffer(buf, algo) {
  return crypto.createHash(algo).update(buf).digest('hex');
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function createModpacks(deps) {
  const {
    instancePath, createInstance, listInstances, readModManifest, writeModManifest,
    getAdmZip, broadcast, fetchImpl = fetch,
  } = deps;

  const report = (installId, label, done, total) =>
    broadcast('modpacks:progress', { installId, label, done, total });

  async function download(url, dest, sha1) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha1 && hashBuffer(buf, 'sha1') !== String(sha1).toLowerCase()) {
      throw new Error('file is corrupt (hash mismatch)');
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
  }

  function uniqueName(base, versionNumber) {
    const taken = new Set(listInstances().map(i => i.name.toLowerCase()));
    let name = base, n = 2;
    while (taken.has(name.toLowerCase()) || fs.existsSync(instancePath(versionNumber, name))) name = `${base} (${n++})`;
    return name;
  }

  /** Build a new instance from an .mrpack on disk. */
  async function installMrpack(packPath, { installId, nameHint, iconUrl } = {}) {
    const AdmZip = getAdmZip();
    let zip;
    try { zip = new AdmZip(packPath); } catch { throw new Error('That file is not a modpack (it isn\u2019t a valid .mrpack archive).'); }
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) throw new Error('That file is not a Modrinth modpack (modrinth.index.json is missing).');
    let index;
    try { index = JSON.parse(zip.readAsText(indexEntry)); } catch { throw new Error('The modpack index is unreadable.'); }
    if (index.game !== 'minecraft') throw new Error('That modpack is not for Minecraft.');

    const dependencies = index.dependencies || {};
    const versionNumber = dependencies.minecraft;
    if (!versionNumber) throw new Error('The modpack does not say which Minecraft version it needs.');
    if (dependencies.neoforge) throw new Error('NeoForge modpacks are not supported yet — use a Fabric, Quilt or Forge pack.');
    const loaderKey = Object.keys(SUPPORTED_LOADERS).find(k => dependencies[k]);
    const loader = loaderKey ? SUPPORTED_LOADERS[loaderKey] : 'vanilla';

    const name = uniqueName(cleanInstanceName(nameHint || index.name), versionNumber);
    report(installId, `Creating ${name}…`, 0, 1);
    await createInstance({ name, versionNumber, loader, fromModpack: { name: index.name || name, version: index.versionId || '', iconUrl: iconUrl || '' } });
    const dir = instancePath(versionNumber, name);

    try {
      const files = (index.files || []).filter(f => (f.env?.client || 'required') !== 'unsupported');
      let done = 0;
      const total = files.length;
      const manifests = new Map();
      const failed = [];
      await mapLimit(files, 6, async (f) => {
        const dest = safeJoin(dir, f.path);
        const url = (f.downloads || []).find((u) => {
          try { const h = new URL(u); return h.protocol === 'https:' && ALLOWED_DOWNLOAD_HOSTS.has(h.hostname); } catch { return false; }
        });
        if (!dest || !url) { failed.push(f.path || '?'); done++; return; }
        try {
          await download(url, dest, f.hashes?.sha1);
          // Remember which Modrinth project each file came from, so the
          // Library shows real names/icons and "Installed" badges line up.
          const m = /cdn\.modrinth\.com\/data\/([A-Za-z0-9]+)\//.exec(url);
          if (m) {
            const folder = path.dirname(dest);
            if (!manifests.has(folder)) manifests.set(folder, readModManifest(folder));
            manifests.get(folder)[path.basename(dest)] = { projectId: m[1], title: path.basename(dest), iconUrl: '' };
          }
        } catch (err) {
          failed.push(`${f.path} (${err.message})`);
        }
        done++;
        report(installId, path.basename(f.path || ''), done, total);
      });
      for (const [folder, man] of manifests) writeModManifest(folder, man);

      // overrides first, then client-overrides on top, as the format says.
      for (const prefix of ['overrides/', 'client-overrides/']) {
        for (const entry of zip.getEntries()) {
          if (entry.isDirectory || !entry.entryName.startsWith(prefix)) continue;
          const dest = safeJoin(dir, entry.entryName.slice(prefix.length));
          if (!dest) continue;
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.writeFile(dest, entry.getData());
        }
      }

      report(installId, 'Done', total, total);
      return { name, versionNumber, loader, files: total, failed };
    } catch (err) {
      // A half-built instance is worse than none.
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** Install a modpack straight from Modrinth into a new instance. */
  async function installFromModrinth({ projectId, title, iconUrl, preferVersion, installId }) {
    const res = await fetchImpl(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`);
    if (!res.ok) throw new Error(`Modrinth versions failed: ${res.status}`);
    const versions = (await res.json()).filter(v =>
      v.loaders.some(l => ['fabric', 'quilt', 'forge'].includes(l)) &&
      v.files.some(f => f.filename.endsWith('.mrpack')));
    if (!versions.length) throw new Error(`${title || 'This modpack'} has no Fabric, Quilt or Forge release.`);
    const forVersion = preferVersion ? versions.filter(v => v.game_versions.includes(preferVersion)) : [];
    const pool = forVersion.length ? forVersion : versions;
    const pick = pool.find(v => v.version_type === 'release') || pool[0];
    const file = pick.files.find(f => f.primary && f.filename.endsWith('.mrpack')) || pick.files.find(f => f.filename.endsWith('.mrpack'));

    const tmp = path.join(os.tmpdir(), `solar-${crypto.randomUUID()}.mrpack`);
    report(installId, `Downloading ${title || 'modpack'}…`, 0, 1);
    try {
      await download(file.url, tmp, file.hashes?.sha1);
      return await installMrpack(tmp, { installId, nameHint: title, iconUrl });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  async function lookupByHash(sha1s) {
    if (!sha1s.length) return {};
    const res = await fetchImpl(`${MODRINTH_API}/version_files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hashes: sha1s, algorithm: 'sha1' }),
    });
    return res.ok ? res.json() : {};
  }

  function installedLoaderVersion(dir, loader, versionNumber) {
    const versionsDir = path.join(dir, 'versions');
    if (!fs.existsSync(versionsDir)) return null;
    for (const d of fs.readdirSync(versionsDir)) {
      if (loader === 'forge') {
        const m = /forge-([0-9][0-9.]*)/i.exec(d);
        if (m && d.includes(versionNumber)) return m[1];
      } else {
        const m = new RegExp(`^${loader}-loader-(.+)-${versionNumber.replace(/\./g, '\\.')}$`).exec(d);
        if (m) return m[1];
      }
    }
    return null;
  }

  async function latestLoaderVersion(loader, versionNumber) {
    if (loader === 'forge') {
      const res = await fetchImpl('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      if (!res.ok) return null;
      const promos = (await res.json()).promos || {};
      return promos[`${versionNumber}-recommended`] || promos[`${versionNumber}-latest`] || null;
    }
    const base = loader === 'quilt' ? 'https://meta.quiltmc.org/v3/versions/loader' : 'https://meta.fabricmc.net/v2/versions/loader';
    const res = await fetchImpl(`${base}/${versionNumber}`);
    if (!res.ok) return null;
    const list = await res.json();
    const stable = list.find(l => l.loader?.stable) || list[0];
    return stable?.loader?.version || null;
  }

  /** Write an instance out as an .mrpack at `outPath`. */
  async function exportInstance({ name, versionNumber, loader }, outPath) {
    const dir = instancePath(versionNumber, name);
    if (!fs.existsSync(dir)) throw new Error('That instance no longer exists.');

    const candidates = [];
    for (const folder of EXPORT_FOLDERS) {
      const root = path.join(dir, folder);
      if (!fs.existsSync(root)) continue;
      const walk = (rel) => {
        for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
          const r = path.join(rel, ent.name);
          if (ent.isDirectory()) { walk(r); continue; }
          if (ent.name === '.nebula-manifest.json' || ent.name.endsWith('.part')) continue;
          if (SKIP_EXPORT.some(re => re.test(ent.name))) continue;
          if (folder === 'mods' && ent.name.endsWith('.disabled')) continue;
          candidates.push({ rel: `${folder}/${r.replace(/\\/g, '/')}`, abs: path.join(root, r), folder });
        }
      };
      walk('');
    }
    for (const f of EXPORT_FILES) {
      const abs = path.join(dir, f);
      if (fs.existsSync(abs)) candidates.push({ rel: f, abs, folder: '' });
    }

    // Anything Modrinth hosts goes in as a download link (small file, and
    // the receiver gets the verified original); the rest is embedded.
    const linkable = candidates.filter(c => ['mods', 'resourcepacks', 'shaderpacks'].includes(c.folder) && !c.rel.slice(c.folder.length + 1).includes('/'));
    const sha1 = new Map();
    await mapLimit(linkable, 8, async (c) => { sha1.set(c, hashBuffer(await fsp.readFile(c.abs), 'sha1')); });
    const known = await lookupByHash([...sha1.values()]).catch(() => ({}));

    const AdmZip = getAdmZip();
    const zip = new AdmZip();
    const files = [];
    for (const c of candidates) {
      const h = sha1.get(c);
      const version = h && known[h];
      const remote = version && version.files.find(f => f.hashes?.sha1 === h);
      if (remote) {
        files.push({
          path: c.rel,
          hashes: { sha1: remote.hashes.sha1, sha512: remote.hashes.sha512 },
          env: { client: 'required', server: c.folder === 'mods' ? 'required' : 'unsupported' },
          downloads: [remote.url],
          fileSize: remote.size,
        });
      } else {
        zip.addFile(`overrides/${c.rel}`, await fsp.readFile(c.abs));
      }
    }

    const dependencies = { minecraft: versionNumber };
    if (LOADER_DEP_KEY[loader]) {
      const lv = installedLoaderVersion(dir, loader, versionNumber) || await latestLoaderVersion(loader, versionNumber).catch(() => null);
      if (!lv) throw new Error(`Couldn't work out which ${loader} version this instance uses. Launch it once, then export again.`);
      dependencies[LOADER_DEP_KEY[loader]] = lv;
    }
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: new Date().toISOString().slice(0, 10),
      name,
      summary: `Exported from SolarClient (${versionNumber}${LOADER_DEP_KEY[loader] ? ` ${loader}` : ''})`,
      files,
      dependencies,
    };
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));
    await fsp.writeFile(outPath, zip.toBuffer());
    return { linked: files.length, embedded: candidates.length - files.length, path: outPath };
  }

  return { installMrpack, installFromModrinth, exportInstance };
}

module.exports = { createModpacks, safeJoin, cleanInstanceName };
