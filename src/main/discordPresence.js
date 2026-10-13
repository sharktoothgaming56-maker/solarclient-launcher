// =====================================================================
// DISCORD RICH PRESENCE — dependency-free.
//
// Discord exposes a local IPC socket (named pipe on Windows,
// unix socket under XDG_RUNTIME_DIR/TMPDIR/TMP/TEMP//tmp elsewhere),
// numbered discord-ipc-0 .. discord-ipc-9. The wire format is a simple
// binary frame: two little-endian uint32s (opcode, payload length)
// followed by JSON. Op 0 = HANDSHAKE, op 1 = FRAME, op 2 = CLOSE,
// op 3 = PING, op 4 = PONG.
//
// So "Playing Minecraft" shows on your Discord profile with no npm
// dependency and no bot token — only an Application ID.
// =====================================================================
const net = require('net');
const path = require('path');
const { EventEmitter } = require('events');

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

function ipcPath(id) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${id}`;
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(base, `discord-ipc-${id}`);
}

function encode(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(data.length, 4);
  return Buffer.concat([header, data]);
}

class DiscordPresence extends EventEmitter {
  constructor(clientId) {
    super();
    this.clientId = clientId;
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.current = null;      // last activity we were asked to show
    this.reconnectTimer = null;
    this.destroyed = false;
    this.lastError = null;
    this.foundSocket = false;
  }

  // try discord-ipc-0..9 in order; the first that accepts wins
  async connect() {
    if (this.connected || this.destroyed) return;
    for (let i = 0; i < 10; i++) {
      try {
        await this._tryConnect(ipcPath(i));
        this.foundSocket = true;
        return;
      } catch { /* next endpoint */ }
    }
    this.foundSocket = false;
    this.lastError = 'Discord desktop app not detected (no IPC socket).';
    this.emit('error', this.lastError);
    this._scheduleReconnect(); // Discord probably isn't running yet
  }

  _tryConnect(p) {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(p);
      const fail = (err) => { sock.destroy(); reject(err); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        this.socket = sock;
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('close', () => this._onClose());
        sock.on('error', () => this._onClose());
        sock.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
        resolve();
      });
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const len = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + len) break;
      let payload = {};
      try { payload = JSON.parse(this.buffer.slice(8, 8 + len).toString('utf8')); } catch { /* ignore */ }
      this.buffer = this.buffer.slice(8 + len);

      if (op === OP_PING) { this.socket?.write(encode(OP_PONG, payload)); continue; }
      if (op === OP_CLOSE) {
        // Discord tells us WHY here — 4000 = invalid client id. Without
        // surfacing this the app just looks silently broken.
        this.lastError = payload.message || `closed (${payload.code || '?'})`;
        this.emit('error', this.lastError);
        this._onClose();
        return;
      }
      if (op === OP_FRAME && payload.evt === 'ERROR') {
        this.lastError = payload.data?.message || 'Discord rejected the request';
        this.emit('error', this.lastError);
        continue;
      }
      if (op === OP_FRAME && payload.evt === 'READY') {
        this.connected = true;
        this.lastError = null;
        this.emit('ready', payload.data?.user || null);
        if (this.current) this.setActivity(this.current); // replay whatever we owe
      }
    }
  }

  _onClose() {
    this.connected = false;
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    this.buffer = Buffer.alloc(0);
    this.emit('disconnected');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 15000);
  }

  /**
   * Drop and immediately re-open the connection so Discord treats our
   * status as the newest one. READY replays the current activity.
   */
  reassert() {
    if (this.destroyed || !this.connected) return;
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    this.connect();
  }

  // activity: { details, state, largeImageKey, largeImageText, smallImageKey,
  //             smallImageText, startTimestamp, buttons, pid }
  // pid: the process the status belongs to. Discord ranks a status tied to
  // a running game above other apps' statuses, so pass the game's pid.
  setActivity(activity) {
    this.current = activity;
    if (!this.connected || !this.socket) return false;
    const payload = {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: activity?.pid || process.pid,
        activity: activity ? {
          type: 0, // Playing
          details: activity.details,
          state: activity.state,
          timestamps: activity.startTimestamp ? { start: Math.floor(activity.startTimestamp / 1000) } : undefined,
          assets: {
            large_image: activity.largeImageKey,
            large_text: activity.largeImageText,
            small_image: activity.smallImageKey,
            small_text: activity.smallImageText,
          },
          buttons: activity.buttons,
          instance: false,
        } : undefined,
      },
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
    try { this.socket.write(encode(OP_FRAME, payload)); return true; }
    catch { this._onClose(); return false; }
  }

  clearActivity() {
    this.current = null;
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(encode(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: undefined },
        nonce: `${Date.now()}`,
      }));
    } catch { this._onClose(); }
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) { this.socket.removeAllListeners(); this.socket.destroy(); this.socket = null; }
    this.connected = false;
  }
}

module.exports = { DiscordPresence };
