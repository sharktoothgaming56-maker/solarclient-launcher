// =====================================================================
// SERVER PING — Minecraft's Server List Ping, so an invite can show the
// server's MOTD, player count and icon instead of a bare address.
//
// The protocol, for anyone reading this later:
//   1. connect TCP
//   2. send Handshake  (packet 0x00, next-state = 1 for "status")
//   3. send Status Request (packet 0x00, empty)
//   4. read Status Response — a JSON blob describing the server
//
// Every packet is: VarInt length, VarInt id, payload. Strings are a
// VarInt length followed by UTF-8. VarInts are 7 bits per byte with the
// high bit as a continuation flag, which is why they're hand-rolled here.
// =====================================================================

const net = require('net');

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(buf.length), buf]);
}

/** Reads a VarInt, returning the value and how many bytes it consumed. */
function readVarInt(buf, offset = 0) {
  let result = 0, shift = 0, pos = offset;
  while (true) {
    if (pos >= buf.length) return null;          // need more data
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('VarInt too large');
  }
  return { value: result >>> 0, size: pos - offset };
}

function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/** MOTDs can be a plain string, or a chat component tree. Flatten either. */
function flattenMotd(desc) {
  if (desc == null) return '';
  if (typeof desc === 'string') return desc;
  let out = desc.text || '';
  if (Array.isArray(desc.extra)) out += desc.extra.map(flattenMotd).join('');
  if (Array.isArray(desc)) out = desc.map(flattenMotd).join('');
  return out;
}

/** Strip legacy section-sign colour codes so the UI gets clean text. */
function stripColors(s) {
  return String(s).replace(/\u00a7[0-9a-fk-orA-FK-OR]/g, '');
}

/**
 * Ping a server. Resolves with a summary, or rejects with a readable
 * reason — never hangs, because a dead host would otherwise leave the
 * invite card spinning forever.
 */
function pingServer(host, port = 25565, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error('Server did not respond in time.')), timeoutMs);

    socket.on('error', (e) => done(new Error(
      e.code === 'ENOTFOUND' ? 'That address could not be found.'
        : e.code === 'ECONNREFUSED' ? 'Nothing is listening on that address.'
          : e.message)));

    socket.connect(port, host, () => {
      const handshake = packet(0x00, Buffer.concat([
        writeVarInt(770),           // protocol version; any recent value works for status
        writeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1),             // next state: status
      ]));
      socket.write(handshake);
      socket.write(packet(0x00, Buffer.alloc(0)));   // status request
    });

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len) return;                                  // length incomplete
        const total = len.size + len.value;
        if (buf.length < total) return;                    // body incomplete

        const id = readVarInt(buf, len.size);
        if (!id || id.value !== 0x00) return done(new Error('Unexpected reply from server.'));

        const strLen = readVarInt(buf, len.size + id.size);
        if (!strLen) return;
        const start = len.size + id.size + strLen.size;
        const json = buf.subarray(start, start + strLen.value).toString('utf8');
        const data = JSON.parse(json);

        done(null, {
          motd: stripColors(flattenMotd(data.description)).trim().split('\n').slice(0, 2).join(' · '),
          online: data.players?.online ?? null,
          max: data.players?.max ?? null,
          version: data.version?.name ? stripColors(data.version.name) : null,
          favicon: typeof data.favicon === 'string' && data.favicon.startsWith('data:image')
            ? data.favicon : null,
        });
      } catch (err) {
        done(new Error(`Could not read the server's reply: ${err.message}`));
      }
    });
  });
}

/** "host", "host:port", or a bare name — always yields host + port. */
function parseAddress(address) {
  const raw = String(address || '').trim().replace(/^\w+:\/\//, '');
  const [host, portStr] = raw.split(':');
  const port = portStr ? parseInt(portStr, 10) : 25565;
  return { host: host.trim(), port: Number.isFinite(port) ? port : 25565 };
}

module.exports = { pingServer, parseAddress, writeVarInt, readVarInt, flattenMotd, stripColors };
