// =====================================================================
// SERVER HOSTING — run a Minecraft server on this PC.
//
// The server runs as a child process of the launcher, using this machine's
// CPU and the RAM you allocate. It exists only while you choose to run it:
// close the launcher or press Stop and it is gone. That is a deliberate
// property, not a limitation — nothing keeps running behind your back.
//
// ADDRESSING, HONESTLY
// A server started here is reachable on your LAN immediately. Reaching it
// from the internet at <name>.nebulahosting.co needs two things that do
// not exist yet: a wildcard DNS record pointing at infrastructure you
// control, and a way through your router (either a port forward or a relay
// that tunnels traffic). The name is reserved and displayed now so the
// rest can be switched on later without changing anything here.
// =====================================================================

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
const GAMEMODES = ['survival', 'creative', 'adventure'];
const LEVEL_TYPES = [
  { id: 'minecraft:normal', label: 'Default' },
  { id: 'minecraft:flat', label: 'Superflat' },
  { id: 'minecraft:large_biomes', label: 'Large Biomes' },
  { id: 'minecraft:amplified', label: 'Amplified' },
];

/** Server names become a subdomain, so restrict them to what DNS allows. */
function normaliseName(name) {
  const clean = String(name || '').toLowerCase().trim()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (clean.length < 3) throw new Error('Server name must be at least 3 characters (letters, numbers and dashes).');
  if (clean.length > 24) throw new Error('Server name must be 24 characters or fewer.');
  return clean;
}

class ServerHost extends EventEmitter {
  constructor(store, opts = {}) {
    super();
    this.store = store;
    this.rootDir = opts.rootDir;              // where server folders live
    this.ensureJava = opts.ensureJava;        // reuse the launcher's JRE manager
    this.requiredJavaFor = opts.requiredJavaFor;
    this.running = new Map();                 // id -> { child, logs, startedAt }
  }

  // ---- persistence --------------------------------------------------
  list() { return this.store.get('hostedServers', []); }
  save(list) { this.store.set('hostedServers', list); }

  dirFor(id) { return path.join(this.rootDir, 'servers', id); }

  /** Everything the UI needs, including live state. */
  snapshot() {
    const total = Math.max(1, Math.round(os.totalmem() / (1024 ** 3)));
    return {
      servers: this.list().map(s => {
        const live = this.running.get(s.id);
        return {
          ...s,
          running: !!live,
          startedAt: live?.startedAt || null,
          players: live?.players || [],
          ready: live?.ready || false,
        };
      }),
      system: {
        totalRamGB: total,
        // Leave headroom for the OS and, more importantly, for Minecraft
        // itself if they intend to play on their own server.
        maxAllocGB: Math.max(1, total - 4),
        suggestedGB: Math.max(1, Math.min(6, Math.floor(total / 3))),
      },
      options: { difficulties: DIFFICULTIES, gamemodes: GAMEMODES, levelTypes: LEVEL_TYPES },
    };
  }

  // ---- lifecycle ----------------------------------------------------
  create({ name, versionNumber, ramGB, difficulty, gamemode, hardcore, levelType, seed, maxPlayers, motd, pvp, onlineMode }) {
    const slug = normaliseName(name);
    const list = this.list();
    if (list.some(s => s.slug === slug)) throw new Error(`You already have a server called "${slug}".`);

    const server = {
      id: `srv_${Date.now().toString(36)}`,
      slug,
      displayName: String(name).trim(),
      address: `${slug}.nebulahosting.co`,     // reserved; DNS comes later
      versionNumber,
      ramGB: Math.max(1, Math.min(this.snapshot().system.maxAllocGB, ramGB || 2)),
      difficulty: DIFFICULTIES.includes(difficulty) ? difficulty : 'normal',
      gamemode: GAMEMODES.includes(gamemode) ? gamemode : 'survival',
      hardcore: !!hardcore,
      levelType: LEVEL_TYPES.some(l => l.id === levelType) ? levelType : 'minecraft:normal',
      seed: String(seed || '').trim(),
      maxPlayers: Math.max(1, Math.min(200, maxPlayers || 10)),
      motd: String(motd || `${name} — hosted with SolarClient`).slice(0, 59),
      pvp: pvp !== false,
      onlineMode: onlineMode !== false,
      port: 25565,
      eulaAccepted: false,
      createdAt: Date.now(),
    };
    this.save([...list, server]);
    this.emit('changed', this.snapshot());
    return server;
  }

  update(id, patch) {
    const list = this.list();
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('That server no longer exists.');
    if (this.running.has(id)) throw new Error('Stop the server before changing its settings.');
    if (patch.name) {
      const slug = normaliseName(patch.name);
      if (list.some(s => s.slug === slug && s.id !== id)) throw new Error(`You already have a server called "${slug}".`);
      patch.slug = slug;
      patch.displayName = String(patch.name).trim();
      patch.address = `${slug}.nebulahosting.co`;
      delete patch.name;
    }
    list[idx] = { ...list[idx], ...patch };
    this.save(list);
    this.emit('changed', this.snapshot());
    return list[idx];
  }

  remove(id) {
    if (this.running.has(id)) throw new Error('Stop the server first.');
    this.save(this.list().filter(s => s.id !== id));
    this.emit('changed', this.snapshot());
  }

  /** Deleting the world folder too is destructive, so it's separate. */
  deleteFiles(id) {
    if (this.running.has(id)) throw new Error('Stop the server first.');
    try { fs.rmSync(this.dirFor(id), { recursive: true, force: true }); } catch { /* already gone */ }
  }

  acceptEula(id) {
    return this.update(id, { eulaAccepted: true });
  }

  // ---- files --------------------------------------------------------
  writeProperties(server, dir) {
    const props = {
      'motd': server.motd,
      'server-port': server.port,
      'max-players': server.maxPlayers,
      'difficulty': server.difficulty,
      'gamemode': server.gamemode,
      'hardcore': server.hardcore,
      'level-type': server.levelType,
      'level-seed': server.seed,
      'pvp': server.pvp,
      'online-mode': server.onlineMode,
      'enable-command-block': true,
      'spawn-protection': 0,
      'view-distance': 10,
availability: undefined,
    };
    delete props.availability;
    const body = Object.entries(props)
      .map(([k, v]) => `${k}=${v === true ? 'true' : v === false ? 'false' : v}`)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'server.properties'), `# Written by SolarClient\n${body}\n`);
  }

  async ensureJar(server, dir, onProgress) {
    const jar = path.join(dir, 'server.jar');
    const stamp = path.join(dir, '.jar-version');
    const want = server.versionNumber;
    if (fs.existsSync(jar)) {
      try { if (fs.readFileSync(stamp, 'utf8').trim() === want) return jar; } catch { /* re-download */ }
    }

    onProgress?.(`Finding the ${want} server download…`);
    const manRes = await fetch(VERSION_MANIFEST);
    if (!manRes.ok) throw new Error(`Couldn't reach Mojang's version list (${manRes.status}).`);
    const manifest = await manRes.json();
    const entry = manifest.versions.find(v => v.id === want);
    if (!entry) throw new Error(`Minecraft ${want} isn't in Mojang's version list.`);

    const verRes = await fetch(entry.url);
    if (!verRes.ok) throw new Error(`Couldn't read the ${want} manifest (${verRes.status}).`);
    const meta = await verRes.json();
    const url = meta.downloads?.server?.url;
    if (!url) throw new Error(`Mojang publishes no server jar for ${want}.`);

    onProgress?.(`Downloading the ${want} server…`);
    const dl = await fetch(url);
    if (!dl.ok) throw new Error(`Server download failed (${dl.status}).`);
    fs.writeFileSync(jar, Buffer.from(await dl.arrayBuffer()));
    fs.writeFileSync(stamp, want);
    return jar;
  }

  async start(id, onProgress) {
    if (this.running.has(id)) throw new Error('That server is already running.');
    const server = this.list().find(s => s.id === id);
    if (!server) throw new Error('That server no longer exists.');

    // Mojang's EULA has to be accepted by a person, not by us on their
    // behalf. The server refuses to boot without it anyway.
    if (!server.eulaAccepted) {
      const err = new Error('You need to accept the Minecraft EULA before this server can start.');
      err.code = 'EULA';
      throw err;
    }

    const dir = this.dirFor(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eula.txt'),
      '# Accepted through SolarClient (https://www.minecraft.net/eula)\neula=true\n');
    this.writeProperties(server, dir);

    const jar = await this.ensureJar(server, dir, onProgress);
    onProgress?.('Preparing Java…');
    const javaPath = await this.ensureJava(this.requiredJavaFor(server.versionNumber), onProgress);

    onProgress?.('Starting the server…');
    const child = spawn(javaPath, [
      `-Xmx${server.ramGB}G`,
      `-Xms${Math.max(1, Math.floor(server.ramGB / 2))}G`,
      '-jar', jar, 'nogui',
    ], { cwd: dir, windowsHide: true });

    const state = { child, logs: [], startedAt: Date.now(), players: [], ready: false };
    this.running.set(id, state);

    const pushLog = (line, level = 'info') => {
      const entry = { line, level, at: Date.now() };
      state.logs.push(entry);
      if (state.logs.length > 800) state.logs.shift();
      this.emit('log', { id, ...entry });
    };

    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trimEnd();
        if (!t) continue;
        pushLog(t);
        // "Done (12.345s)! For help, type help"
        if (/\bDone \([\d.]+s\)!/.test(t)) {
          state.ready = true;
          this.emit('changed', this.snapshot());
          this.emit('ready', { id });
        }
        let m = t.match(/:\s+(\w{3,16}) joined the game/);
        if (m) { if (!state.players.includes(m[1])) state.players.push(m[1]); this.emit('changed', this.snapshot()); }
        m = t.match(/:\s+(\w{3,16}) left the game/);
        if (m) { state.players = state.players.filter(p => p !== m[1]); this.emit('changed', this.snapshot()); }
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const t = line.trimEnd();
        if (t) pushLog(t, 'error');
      }
    });
    child.on('error', (err) => {
      pushLog(`Failed to start: ${err.message}`, 'error');
      this.running.delete(id);
      this.emit('changed', this.snapshot());
    });
    child.on('close', (code) => {
      pushLog(code === 0 ? 'Server stopped.' : `Server exited with code ${code}.`, code === 0 ? 'info' : 'error');
      this.running.delete(id);
      this.emit('stopped', { id, code });
      this.emit('changed', this.snapshot());
    });

    this.emit('changed', this.snapshot());
    return { id, running: true };
  }

  /**
   * Graceful stop. Writing "stop" to stdin lets the server save chunks and
   * flush the world; killing the process risks corrupting it, so the kill
   * is only a fallback after it has had time to finish.
   */
  stop(id) {
    const live = this.running.get(id);
    if (!live) return { id, running: false };
    try { live.child.stdin.write('stop\n'); } catch { /* pipe already closed */ }
    clearTimeout(live.killTimer);
    live.killTimer = setTimeout(() => {
      if (this.running.has(id)) {
        try { live.child.kill(); } catch { /* already gone */ }
      }
    }, 20000);
    return { id, stopping: true };
  }

  /** Anything typed into the console, plus what the UI sends. */
  command(id, cmd) {
    const live = this.running.get(id);
    if (!live) throw new Error('That server is not running.');
    const clean = String(cmd || '').trim();
    if (!clean) return;
    try { live.child.stdin.write(`${clean}\n`); } catch { throw new Error('The server is not accepting input.'); }
  }

  logs(id) { return this.running.get(id)?.logs || []; }

  stopAll() {
    for (const id of [...this.running.keys()]) this.stop(id);
  }
}

module.exports = { ServerHost, DIFFICULTIES, GAMEMODES, LEVEL_TYPES, normaliseName };
