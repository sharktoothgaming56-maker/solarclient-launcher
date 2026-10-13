// =====================================================================
// BRIDGE — a small localhost HTTP server the in-game mod talks to.
//
// This is what makes the friends list, chats and invites the SAME thing
// in the launcher and in the game: one state, two windows onto it. Send a
// message in game and it is in the launcher's chat history; accept an
// invite in the launcher and the game knows.
//
// SECURITY, because this listens on a port:
//   - binds to 127.0.0.1 only, so nothing off this machine can reach it
//   - requires a random per-session token, written to a file only this
//     user can read; the mod reads it from there
//   - the port is chosen by the OS and written to the same file
//
// Transport is long-polling rather than WebSocket: the mod already speaks
// it, it survives the game's own thread model without extra libraries, and
// a parked request costs nothing.
// =====================================================================

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const PARK_MS = 25000;         // how long a poll waits before replying empty
const MAX_BODY = 256 * 1024;

class Bridge extends EventEmitter {
  constructor({ userDataDir }) {
    super();
    this.userDataDir = userDataDir;
    this.token = crypto.randomBytes(24).toString('hex');
    this.revision = 0;
    this.state = {};                 // whatever the launcher last published
    this.waiters = [];               // parked polls
    this.server = null;
    this.port = null;
    this.modSeenAt = 0;              // last authenticated request from the mod
  }

  /** True while a SolarClient game is talking to us. The mod keeps a poll
   *  parked at all times, so a gap of more than a few seconds means it's gone. */
  modActive() {
    return this.waiters.length > 0 || Date.now() - this.modSeenAt < 8000;
  }

  handshakeFile() { return path.join(this.userDataDir, 'nebula-link.json'); }

  /**
   * Every place the mod might look for the handshake, so the mod finds us no
   * matter which build it is or which folder this launcher happens to use.
   *
   * The nebula->solar rebrand left two moving parts: the DATA FOLDER (this
   * launcher pins to "nebulaclient" for an upgraded user but a fresh install
   * lands in "SolarClient"), and the FILE NAME (older mods look for
   * "solar-bridge.json", newer ones for "nebula-link.json"). A mod that only
   * checked one combination would see "launcher isn't running" against a
   * launcher that was up — exactly the bug a friend on a fresh install hits.
   * Writing all of them makes the two versions independent.
   */
  handshakeFiles() {
    const appData = path.dirname(this.userDataDir);
    const set = new Set([
      path.join(this.userDataDir, 'nebula-link.json'),
      path.join(appData, 'SolarClient', 'solar-bridge.json'),
      path.join(appData, 'SolarClient', 'nebula-link.json'),
      path.join(appData, 'nebulaclient', 'nebula-link.json'),
      path.join(appData, 'nebulaclient', 'solar-bridge.json'),
    ]);
    return [...set];
  }

  start() {
    if (this.server) return Promise.resolve(this.port);
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      // Port 0 = let the OS pick a free one, so two launchers never clash.
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.writeHandshake();
        resolve(this.port);
      });
    });
  }

  writeHandshake() {
    const body = JSON.stringify({
      port: this.port, token: this.token, pid: process.pid, at: Date.now(),
    }, null, 2);
    for (const file of this.handshakeFiles()) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        // Owner-only where the OS supports it. Windows ignores the mode, but
        // the file sits in the user's own AppData there anyway.
        try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
      } catch (err) {
        console.warn('[bridge] could not write handshake to', file, '-', err.message);
      }
    }
  }

  stop() {
    for (const w of this.waiters) { clearTimeout(w.timer); try { w.res.end(); } catch { /* gone */ } }
    this.waiters = [];
    try { this.server?.close(); } catch { /* already closed */ }
    this.server = null;
    // Remove every handshake we wrote, so a stale file can't make the mod
    // think a closed launcher is still up.
    for (const file of this.handshakeFiles()) {
      try { fs.rmSync(file, { force: true }); } catch { /* fine */ }
    }
  }

  /** The launcher calls this whenever anything the mod cares about changes. */
  publish(state, notice = null) {
    this.state = state;
    this.revision += 1;
    const payload = { revision: this.revision, state: this.state, notice };
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) {
      clearTimeout(w.timer);
      this.reply(w.res, 200, payload);
    }
  }

  reply(res, code, body) {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(json),
      'cache-control': 'no-store',
    });
    res.end(json);
  }

  authed(req) {
    const h = req.headers.authorization || '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (given.length !== this.token.length) return false;
    // Constant-time compare so the token can't be guessed a byte at a time.
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token));
  }

  handle(req, res) {
    // Reject anything that didn't come from this machine, belt and braces
    // on top of binding to loopback.
    const remote = req.socket.remoteAddress || '';
    if (!remote.includes('127.0.0.1') && !remote.includes('::1')) {
      res.writeHead(403); return res.end();
    }
    if (!this.authed(req)) { res.writeHead(401); return res.end(); }
    this.modSeenAt = Date.now();

    const url = new URL(req.url, 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/events') {
      const since = Number(url.searchParams.get('since') || 0);
      if (since < this.revision) {
        return this.reply(res, 200, { revision: this.revision, state: this.state, notice: null });
      }
      // Nothing new: park the request rather than making the mod poll in a
      // tight loop. It replies empty on timeout and the mod asks again.
      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        this.reply(res, 200, { revision: this.revision, state: null, notice: null });
      }, PARK_MS);
      this.waiters.push(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter(w => w !== waiter);
      });
      return undefined;
    }

    if (req.method === 'POST' && url.pathname === '/action') {
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) { tooBig = true; req.destroy(); }
      });
      req.on('end', () => {
        if (tooBig) { res.writeHead(413); return res.end(); }
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { return this.reply(res, 400, { error: 'Malformed JSON.' }); }
        const { action, payload } = parsed;
        if (!action) return this.reply(res, 400, { error: 'No action given.' });
        // Handlers are registered by the launcher; unknown actions are a
        // no-op rather than an error, so an older launcher and a newer mod
        // still work together.
        this.emit('action', { action, payload: payload || {}, reply: (r) => this.reply(res, 200, r || { ok: true }) });
        if (!this.listenerCount('action')) this.reply(res, 200, { ok: true });
      });
      return undefined;
    }

    res.writeHead(404); return res.end();
  }
}

module.exports = { Bridge };
