// =====================================================================
// FRIENDS — follows, blocks, DMs, group chats, and world/server invites.
//
// ARCHITECTURE, AND WHY IT LOOKS LIKE THIS
//
// Everything here is written against a Transport interface rather than
// against a specific server. Two transports ship:
//
//   LocalTransport  — no network. Your own data is real and persists;
//                     nobody else ever appears. This is what runs today.
//   SocketTransport — talks to a backend over WebSocket. Fully written,
//                     switched on the moment you set a server URL.
//
// The point is that no UI code and none of the logic below knows which
// one is active. When you stand up the VPS you set one config value and
// the whole feature comes alive — nothing has to be rewritten.
//
// PRESENCE HONESTY
// Someone is only ever shown "online" if their launcher told the backend
// so within the last PRESENCE_TTL. There is no inference from anything
// else, because a wrong "online" is worse than no status at all.
// =====================================================================

const EventEmitter = require('events');
const crypto = require('crypto');
const { FRIENDS_WS_URL, BACKEND_DISCOVERY_URL } = require('./backendConfig');

const PRESENCE_TTL_MS = 90 * 1000;      // stale heartbeats stop counting
const HEARTBEAT_MS = 30 * 1000;
const MESSAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // DMs, groups, community channels
const GLOBAL_TTL_MS = 60 * 60 * 1000;              // live chat

const STATUS = { OFFLINE: 'offline', ONLINE: 'online', IN_GAME: 'in_game' };

/** Who's in live chat, as sent by the server — only well-formed entries pass. */
function cleanPeople(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && /^[0-9a-f]{32}$/i.test(String(p.uuid || '')))
    .slice(0, 12)
    .map(p => ({ uuid: String(p.uuid), name: String(p.name || '').slice(0, 16) }));
}

// ---------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------

/** Offline stand-in. Keeps the app fully usable with no backend. */
class LocalTransport extends EventEmitter {
  constructor() { super(); this.connected = false; }
  get kind() { return 'local'; }
  async connect() { this.connected = false; return false; }
  async send() { /* nothing to send to */ }
  close() {}
}

/**
 * Real transport. Frames are plain JSON: { t: type, ...payload }.
 * Reconnects with backoff, because a launcher sits open for hours and a
 * dropped socket must not mean "friends stop working until restart".
 */
class SocketTransport extends EventEmitter {
  constructor(url, tokenProvider) {
    super();
    this.url = url;
    this.tokenProvider = tokenProvider;
    this.ws = null;
    this.connected = false;
    this.retry = 0;
    this.closedByUs = false;
  }
  get kind() { return 'socket'; }

  async connect() {
    this.closedByUs = false;
    this.connecting = true;
    let WebSocketImpl;
    try {
      WebSocketImpl = global.WebSocket || require('ws');
    } catch {
      this.connecting = false;
      this.emit('error', new Error('WebSocket support is unavailable.'));
      return false;
    }
    try {
      this.ws = new WebSocketImpl(this.url);
    } catch (err) {
      this.connecting = false;
      this.emit('error', err);
      this.scheduleReconnect();
      return false;
    }
    // A half-open attempt otherwise sits there until the OS gives up.
    const ws = this.ws;
    clearTimeout(this._openTimer);
    this._openTimer = setTimeout(() => {
      if (this.ws === ws && !this.connected) { try { ws.close(); } catch { /* gone */ } }
    }, 12000);

    this.ws.onopen = () => {
      // Not "connected" yet: the server issues a challenge and we must
      // prove we own the Minecraft account before anything else happens.
      this.retry = 0;
      this.emit('socket-open');
    };
    this.ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); }
      catch { return; }

      // ---- authentication handshake ----
      if (msg.t === 'challenge') {
        try {
          const proof = await this.tokenProvider(msg.serverId);
          this.sendRaw({ t: 'auth', ...proof });
        } catch (err) {
          this.emit('error', new Error(`Could not verify your Minecraft account: ${err.message}`));
          this.close();
        }
        return;
      }
      if (msg.t === 'auth_ok') {
        this.connected = true;
        this.connecting = false;
        // Carry our badge tier through with the open event so the launcher
        // knows what we are (and whether we may run admin commands).
        this.emit('open', { role: msg.role || 'member', isOwner: !!msg.isOwner, isMod: !!msg.isMod });
        return;
      }
      if (msg.t === 'banned') {
        this.connecting = false;
        this.closedByUs = true;   // a ban isn't fixed by reconnecting
        this.emit('banned', msg);
        return;
      }
      if (msg.t === 'auth_failed') {
        this.connecting = false;
        if (!this.closedByUs) this.emit('error', new Error(msg.reason || 'The server rejected your account.'));
        this.closedByUs = true;   // no point retrying a rejected identity
        try { this.ws.close(); } catch { /* gone */ }
        return;
      }
      this.emit('message', msg);
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.connecting = false;
      this.emit('close');
      if (!this.closedByUs) this.scheduleReconnect();
    };
    this.ws.onerror = (err) => this.emit('error', err);
    return true;
  }

  scheduleReconnect() {
    // Exponential backoff, capped, so a server outage doesn't turn every
    // client into a retry storm the moment it comes back.
    const delay = Math.min(30000, 1000 * Math.pow(2, this.retry++));
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Bypasses the connected check — used for the auth handshake itself. */
  sendRaw(msg) {
    try { this.ws.send(JSON.stringify(msg)); return true; }
    catch { return false; }
  }

  async send(msg) {
    if (!this.connected || !this.ws) return false;
    return this.sendRaw(msg);
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this._retryTimer);
    clearTimeout(this._openTimer);
    try { this.ws?.close(); } catch { /* already gone */ }
    this.connected = false;
  }
}

// ---------------------------------------------------------------------
// Friends
// ---------------------------------------------------------------------

class Friends extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.self = null;              // { id, name }
    this.transport = new LocalTransport();
    this.peers = new Map();        // uuid -> { status, activity, lastSeen }
    this.activity = null;          // what WE are doing, for our heartbeat
    this.myRole = 'member';        // our own badge tier, from the backend
    this.isOwner = false;          // may we run /solarclient admin commands
    this.roleCache = new Map();    // uuid -> role, for drawing others' badges
    this._adminWaiters = new Set();// pending /solarclient command promises
    this._roleWaiters = new Set(); // pending queryRoles promises
    this._communityWaiters = new Map(); // community id -> resolve, for create/join
    this.communitiesLoaded = false;
    this.globalChat = [];          // live chat room, this session only
    this.globalCanModerate = false;
    // null until the server answers a history request; false if it never
    // does (a backend that predates live chat silently drops chat frames).
    this.globalAvailable = null;
    this.globalViewers = null;     // people with live chat open (server-counted)
    this.globalPeople = [];        // a few of them, { uuid, name }, for the header faces
    this._chatOpen = false;
    this.isMod = false;            // server says we're one of the two moderators
    this._modWaiters = new Map();  // reqId -> settle, for moderation requests
    this.pruneOld();
    this._pruneTimer = setInterval(() => this.pruneOld(), 10 * 60 * 1000);
    this._pruneTimer.unref?.();
  }

  /**
   * Chat isn't kept forever: saved messages go after 3 days, live chat
   * after 1 hour. Same limits as the server, so a copy on this PC doesn't
   * outlive the original.
   */
  pruneOld() {
    const s = this.read();
    const cut = Date.now() - MESSAGE_TTL_MS;
    const fresh = (list) => (Array.isArray(list) ? list.filter(m => (m?.at || 0) >= cut) : []);
    let changed = false;
    for (const [k, thread] of Object.entries(s.dms || {})) {
      const keep = fresh(thread);
      if (keep.length !== (thread || []).length) { s.dms[k] = keep; changed = true; }
    }
    for (const g of Object.values(s.groups || {})) {
      const keep = fresh(g.messages);
      if (keep.length !== (g.messages || []).length) { g.messages = keep; changed = true; }
    }
    for (const c of Object.values(s.communities || {})) {
      for (const [ch, list] of Object.entries(c.messages || {})) {
        const keep = fresh(list);
        if (keep.length !== (list || []).length) { c.messages[ch] = keep; changed = true; }
      }
    }
    if (changed) {
      this.write({ dms: s.dms, groups: s.groups, communities: s.communities });
      this.push?.();
    }
    const liveCut = Date.now() - GLOBAL_TTL_MS;
    const before = this.globalChat.length;
    this.globalChat = this.globalChat.filter(m => (m.at || 0) >= liveCut);
    if (this.globalChat.length !== before) this.pushGlobal();
  }

  /** http(s)://host:port of the backend, for plain HTTP calls. */
  async backendHttpBase() {
    const ws = await this.resolveBackendUrl();
    if (!ws) return null;
    try {
      const u = new URL(ws);
      return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    } catch { return null; }
  }

  /** A moderation request. The server refuses anyone who isn't a mod. */
  modRequest(op, data = {}) {
    if (!this.isMod) return Promise.reject(new Error('Not allowed.'));
    return this._request({ t: 'mod', op, ...data });
  }

  /** Someone's profile card: counts, follower lists (unless private), look. */
  getProfile(uuid) {
    return this._request({ t: 'profile_get', uuid: String(uuid || '').replace(/-/g, '') });
  }

  /** Your own profile: private lists, plus the background and colour others see. */
  profileMeta() {
    return { private: false, bg: 'nebula', color: null, ...this.store.get('profileMeta', {}) };
  }

  setProfileMeta(patch = {}) {
    const next = { ...this.profileMeta() };
    if (typeof patch.private === 'boolean') next.private = patch.private;
    if (typeof patch.bg === 'string' && /^[a-z0-9_-]{1,24}$/.test(patch.bg)) next.bg = patch.bg;
    if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) next.color = patch.color;
    this.store.set('profileMeta', next);
    if (this.transport.kind === 'socket' && this.transport.connected) this.transport.send({ t: 'profile_set', profile: next });
    return next;
  }

  /** Send something that gets a { reqId, ok, data | reason } answer back. */
  _request(payload, timeoutMs = 20000) {
    if (this.transport.kind !== 'socket' || !this.transport.connected) {
      return Promise.reject(new Error("You're not connected to SolarClient online."));
    }
    return new Promise((resolve, reject) => {
      const reqId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this._modWaiters.delete(reqId);
        reject(new Error('The server took too long to answer.'));
      }, timeoutMs);
      this._modWaiters.set(reqId, (m) => {
        clearTimeout(timer);
        this._modWaiters.delete(reqId);
        if (m.ok) resolve(m.data); else reject(new Error(m.reason || 'That did not work.'));
      });
      this.transport.send({ ...payload, reqId });
    });
  }

  /**
   * Report a player. Evidence goes up over HTTP with a one-time key from
   * the signed-in connection, then the report itself goes over the socket.
   */
  async report({ target, targetName, reason, details, context, files = [] }) {
    const list = files.slice(0, 4);
    const { key } = await this._request({ t: 'report_start', files: list.length });
    const base = await this.backendHttpBase();
    if (list.length && !base) throw new Error("Couldn't reach the SolarClient server.");
    const ids = [];
    for (const f of list) {
      const res = await fetch(`${base}/report/upload?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: f.data,
        signal: AbortSignal.timeout(120000),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${f.name}: ${out.error || 'upload failed'}`);
      ids.push(out.id);
    }
    return this._request({ t: 'report_submit', key, target, targetName, reason, details, context, files: ids });
  }

  /** One evidence file from a report, for the mod panel. */
  async modReportFile(id, file) {
    const link = await this.modRequest('report_file', { id, file });
    const base = await this.backendHttpBase();
    const res = await fetch(`${base}${link.path}`, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('That file is gone.');
    return { type: link.type, data: Buffer.from(await res.arrayBuffer()) };
  }

  /** The live chat panel was opened or closed, for the viewer counter. */
  setChatOpen(open) {
    this._chatOpen = !!open;
    if (this.transport.kind === 'socket' && this.transport.connected) {
      this.transport.send({ t: this._chatOpen ? 'global_open' : 'global_close' });
    }
    return this.globalState();
  }

  probeGlobal() {
    clearTimeout(this._globalProbe);
    this.transport.send({ t: 'global_history' });
    if (this.globalAvailable) return;
    this._globalProbe = setTimeout(() => {
      if (this.globalAvailable === null) { this.globalAvailable = false; this.pushGlobal(); }
    }, 5000);
  }

  // ---- live chat (everyone signed in) -------------------------------
  globalState() {
    const blocked = new Set(this.read().blocked);
    return {
      connected: this.transport.kind === 'socket' && this.transport.connected,
      signedIn: !!this.self,
      selfId: this.self?.id || null,
      canModerate: this.globalCanModerate,
      available: this.globalAvailable !== false,
      viewers: this.globalViewers,
      people: this.globalPeople,
      messages: this.globalChat.filter(m => !blocked.has(m.from) && Date.now() - (m.at || 0) < GLOBAL_TTL_MS),
    };
  }

  pushGlobal(extra) { this.emit('global', { ...this.globalState(), ...(extra || {}) }); }

  sendGlobal(text) {
    const trimmed = String(text || '').trim().slice(0, 300);
    if (!trimmed) return this.globalState();
    if (this.transport.kind !== 'socket' || !this.transport.connected) {
      throw new Error("You're not connected to SolarClient online yet.");
    }
    if (this.globalAvailable === false) throw new Error("Live chat isn't running on the SolarClient server yet.");
    this.transport.send({ t: 'global_send', text: trimmed });
    return this.globalState();
  }

  deleteGlobal(id) {
    this.transport.send({ t: 'global_delete', id });
    return this.globalState();
  }

  /** Everyone on the launcher right now. Rejects when offline or on timeout. */
  onlineList() {
    if (this.transport.kind !== 'socket' || !this.transport.connected) {
      return Promise.reject(new Error("You're not connected to SolarClient online yet."));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.off('online_list', done); reject(new Error('The server took too long to answer.')); }, 6000);
      const done = (list) => { clearTimeout(timer); resolve(list); };
      this.once('online_list', done);
      this.transport.send({ t: 'online_list' });
    });
  }

  /**
   * Run an owner-only role command against the backend and resolve with its
   * result. Used by the in-game /solarclient command via the bridge. Always
   * resolves (never rejects) so the caller can just show the message.
   */
  /**
   * Ask the backend for the badge roles of a set of UUIDs (for drawing
   * badges in game). Resolves with a { uuid: role } map, or an empty map if
   * we're offline. Never rejects.
   */
  queryRoles(uuids) {
    return new Promise((resolve) => {
      const list = (Array.isArray(uuids) ? uuids : []).map(u => String(u).replace(/-/g, '')).filter(Boolean);
      if (!list.length || this.transport.kind !== 'socket' || !this.transport.connected) {
        // Fall back to whatever we've already cached (friends' presence rows
        // carry a role too), so being briefly offline still shows badges.
        const cached = {};
        for (const u of list) if (this.roleCache.has(u)) cached[u] = this.roleCache.get(u);
        return resolve(cached);
      }
      const done = (map) => { clearTimeout(timer); this._roleWaiters.delete(done); resolve(map); };
      const timer = setTimeout(() => {
        const cached = {};
        for (const u of list) if (this.roleCache.has(u)) cached[u] = this.roleCache.get(u);
        done(cached);
      }, 6000);
      this._roleWaiters.add(done);
      this.transport.send({ t: 'roles_query', uuids: list });
    });
  }

  sendAdminCommand({ role, op, target }) {
    return new Promise((resolve) => {
      if (this.transport.kind !== 'socket' || !this.transport.connected) {
        return resolve({ ok: false, reason: 'Not connected to SolarClient online.' });
      }
      const done = (result) => { clearTimeout(timer); this._adminWaiters.delete(done); resolve(result); };
      const timer = setTimeout(() => done({ ok: false, reason: 'The server did not respond.' }), 8000);
      this._adminWaiters.add(done);
      this.transport.send({ t: 'admin_cmd', role, op, target });
    });
  }

  // ---- persistence ------------------------------------------------
  read() {
    const d = this.store.get('friends', null);
    if (d && d.version === 1) return d;
    return {
      version: 1,
      following: [],     // uuids I follow
      followers: [],     // uuids following me
      blocked: [],       // uuids I blocked — never rendered, never notified
      people: {},        // uuid -> { name, lastSeenAt }
      dms: {},           // uuid -> [ message ]
      groups: {},        // groupId -> { id, name, ownerId, members[], messages[] }
      deadInvites: [],   // invite ids that were revoked (host left, etc.)
      settings: {
        notifyOnFollow: true,      // on by default, as asked
        notifyOnFollowBack: true,
        notifyOnMessage: true,
        showOnlineStatus: true,
        // Empty means "use the URL that shipped with the launcher". This is
        // an override for testing, not something a normal user ever sets.
        serverUrlOverride: '',
      },
      unread: {},        // conversationId -> count
    };
  }
  write(patch) {
    const next = { ...this.read(), ...patch };
    this.store.set('friends', next);
    return next;
  }

  // ---- identity & connection --------------------------------------
  /**
   * Prove ownership of a Minecraft account to our backend, using exactly
   * the mechanism Minecraft servers themselves use.
   *
   *   1. our backend hands out a random serverId (the challenge)
   *   2. we POST it to Mojang's /join with our live access token
   *   3. our backend asks Mojang /hasJoined whether that really happened
   *
   * Mojang answers with the verified profile, so the backend learns your
   * real UUID from Mojang rather than taking our word for it. Without this
   * anyone could connect claiming to be anyone — the previous version sent
   * the UUID as if it were a password, which proves nothing.
   *
   * `authorize` is supplied by the launcher and returns a fresh Minecraft
   * access token for the active account.
   */
  setAuthProvider(fn) { this.authProvider = fn; }

  setSelf(account) {
    if (!account) { this.self = null; return; }
    this.self = { id: account.id, name: account.name };
  }

  /**
   * Find out where the backend currently is.
   *
   * Order: explicit override (testing) > the discovery file > whatever we
   * successfully used last time > the address baked in at build time.
   *
   * Caching the last-known-good URL matters: if discovery is unreachable
   * because the user is offline, falling back to a stale build-time
   * address would be worse than using the one that worked an hour ago.
   */
  async resolveBackendUrl() {
    const s = this.read();
    if (s.settings.serverUrlOverride) return s.settings.serverUrlOverride;

    // Connect to the address that worked last time straight away and check
    // discovery in the background — waiting on it first added seconds to
    // every connect. If the backend moved, reconnect to the new address.
    if (s.lastKnownUrl) {
      this.discover().then((url) => {
        if (url && url !== s.lastKnownUrl) this.connect();
      });
      return s.lastKnownUrl;
    }
    return (await this.discover()) || FRIENDS_WS_URL;
  }

  async discover() {
    try {
      const res = await fetch(BACKEND_DISCOVERY_URL, {
        cache: 'no-store',
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (typeof data.friendsUrl !== 'string' || !/^wss?:\/\//i.test(data.friendsUrl)) return null;
      if (data.friendsUrl !== this.read().lastKnownUrl) {
        this.write({ lastKnownUrl: data.friendsUrl });
        console.log('[friends] backend moved to', data.friendsUrl);
      }
      return data.friendsUrl;
    } catch {
      // Offline, or the file isn't set up yet. Neither is an error worth
      // showing the user.
      return null;
    }
  }

  /** Connect now unless a live or in-progress connection already exists. */
  ensureConnected() {
    const t = this.transport;
    if (t.kind === 'socket' && t.connected) {
      if (this.globalAvailable === false) this.globalAvailable = null;
      this.probeGlobal();
      return this.globalState();
    }
    if (t.kind === 'socket' && t.connecting) return this.globalState();
    this.connect();
    return this.globalState();
  }

  /** Swap transports based on config. Safe to call repeatedly. */
  connect() {
    if (!this._connectRun) this._connectRun = this._connect().finally(() => { this._connectRun = null; });
    return this._connectRun;
  }

  async _connect() {
    const serverUrl = await this.resolveBackendUrl();
    this.transport.close();
    this.transport.removeAllListeners();

    if (!serverUrl) {
      this.transport = new LocalTransport();
      this.emit('connection', { connected: false, mode: 'offline' });
      this.push();
      return;
    }

    // Auth is a Mojang session handshake, not a self-asserted UUID — see
    // authenticate() below.
    // Forward the serverId through. This arrow function used to take no
    // parameter, so the challenge's serverId was silently dropped and the
    // provider POSTed `serverId: null` to Mojang, which answers
    // "Invalid serverId: null" with a 403 — the account and the token were
    // never the problem.
    this.transport = new SocketTransport(serverUrl, (serverId) => this.authProvider?.(serverId));
    this.transport.on('open', (info) => {
      this.myRole = info?.role || 'member';
      this.isOwner = !!info?.isOwner;
      this.isMod = !!info?.isMod;
      if (this.self) this.roleCache.set(String(this.self.id).replace(/-/g, ''), this.myRole);
      this.emit('connection', { connected: true, mode: 'online', isMod: this.isMod });
      this.hello();
      this.startHeartbeat();
      this.globalAvailable = null;
      this.probeGlobal();
      if (this._chatOpen) this.transport.send({ t: 'global_open' });
      this.transport.send({ t: 'community_list' });
      this.transport.send({ t: 'profile_set', profile: this.profileMeta() });
      this.push();
      this.pushGlobal();
    });
    this.transport.on('banned', (b) => {
      this.isMod = false;
      this.emit('banned', b);
    });
    this.transport.on('close', () => {
      this.isMod = false;
      for (const done of [...this._modWaiters.values()]) done({ ok: false, reason: 'Disconnected from SolarClient online.' });
      this.globalViewers = null;
      this.globalPeople = [];
      // Everyone goes dark rather than lingering as falsely "online".
      this.peers.clear();
      this.emit('connection', { connected: false, mode: 'reconnecting' });
      this.push();
      this.pushGlobal();
    });
    this.transport.on('message', (m) => this.onMessage(m));
    this.transport.on('error', (e) => this.emit('error', e?.message || String(e)));
    await this.transport.connect();
  }

  hello() {
    const s = this.read();
    this.transport.send({
      t: 'hello',
      uuid: this.self?.id,
      name: this.self?.name,
      following: s.following,
      showStatus: s.settings.showOnlineStatus,
    });
  }

  startHeartbeat() {
    clearInterval(this._hb);
    this._hb = setInterval(() => {
      if (!this.transport.connected) return;
      this.transport.send({
        t: 'heartbeat',
        status: this.activity ? STATUS.IN_GAME : STATUS.ONLINE,
        activity: this.activity,
        showStatus: this.read().settings.showOnlineStatus,
      });
    }, HEARTBEAT_MS);
  }

  stop() {
    clearInterval(this._hb);
    this.transport.close();
  }

  /** Called by the launcher when a game starts or stops. */
  setActivity(activity) {
    this.activity = activity;  // { instanceName, versionNumber, server } | null
    if (this.transport.connected) {
      this.transport.send({
        t: 'heartbeat',
        status: activity ? STATUS.IN_GAME : STATUS.ONLINE,
        activity,
        showStatus: this.read().settings.showOnlineStatus,
      });
    }
    this.push();
  }

  // ---- inbound ------------------------------------------------------
  onMessage(m) {
    // Voice frames arrive ~50/s per speaker; skip the store read and go straight to the UI.
    if (typeof m.t === 'string' && m.t.startsWith('voice_')) {
      this.emit('voice', m);
      return;
    }
    const s = this.read();
    switch (m.t) {
      case 'presence': {
        // Authoritative list of who is online right now.
        for (const p of m.peers || []) {
          if (s.blocked.includes(p.uuid)) continue;
          this.peers.set(p.uuid, {
            status: p.status || STATUS.ONLINE,
            activity: p.activity || null,
            lastSeen: Date.now(),
          });
          if (p.name) {
            s.people[p.uuid] = { ...(s.people[p.uuid] || {}), name: p.name, lastSeenAt: Date.now() };
          }
        }
        for (const gone of m.offline || []) this.peers.delete(gone);
        this.write({ people: s.people });
        this.push();
        break;
      }
      case 'followed': {
        if (s.blocked.includes(m.uuid)) break;
        if (!s.followers.includes(m.uuid)) s.followers.push(m.uuid);
        s.people[m.uuid] = { name: m.name, lastSeenAt: Date.now() };
        this.write({ followers: s.followers, people: s.people });
        const mutual = s.following.includes(m.uuid);
        if (mutual ? s.settings.notifyOnFollowBack : s.settings.notifyOnFollow) {
          this.emit('notify', {
            kind: mutual ? 'follow_back' : 'follow',
            uuid: m.uuid,
            name: m.name,
            title: mutual ? 'Friends now' : 'New follower',
            body: mutual ? `${m.name} followed you back` : `${m.name} followed you`,
          });
        }
        this.push();
        break;
      }
      case 'unfollowed': {
        this.write({ followers: s.followers.filter(u => u !== m.uuid) });
        this.push();
        break;
      }
      case 'dm': {
        if (s.blocked.includes(m.from)) break;   // blocked = silently dropped
        const thread = s.dms[m.from] || [];
        thread.push({
          id: m.id, from: m.from, name: m.name || s.people[m.from]?.name,
          text: m.text, at: m.at || Date.now(), invite: m.invite || null, reply: m.reply || null,
        });
        s.dms[m.from] = thread.slice(-300);
        s.unread[m.from] = (s.unread[m.from] || 0) + 1;
        this.write({ dms: s.dms, unread: s.unread });
        if (s.settings.notifyOnMessage) {
          this.emit('notify', {
            kind: m.invite ? 'invite' : 'dm', uuid: m.from,
            name: s.people[m.from]?.name || 'Someone',
            title: s.people[m.from]?.name || 'Message', body: m.text,
          });
        }
        this.push();
        break;
      }
      case 'group_message': {
        const g = s.groups[m.groupId];
        if (!g) break;
        if (s.blocked.includes(m.from)) break;
        g.messages = [...(g.messages || []), {
          id: m.id, from: m.from, name: m.name, text: m.text,
          at: m.at || Date.now(), invite: m.invite || null, reply: m.reply || null,
        }].slice(-300);
        s.unread[m.groupId] = (s.unread[m.groupId] || 0) + 1;
        this.write({ groups: s.groups, unread: s.unread });
        if (s.settings.notifyOnMessage) {
          this.emit('notify', { kind: 'group', groupId: m.groupId, title: g.name, body: `${m.name}: ${m.text}` });
        }
        this.push();
        break;
      }
      // Only the person who wrote a message can change it, and in a group
      // the owner can also remove it. `from` is stamped by the server from
      // the verified account, so it can't be spoofed.
      case 'dm_edit':
      case 'dm_delete': {
        const thread = s.dms[m.from];
        const i = thread ? thread.findIndex(x => x.id === m.id && x.from === m.from) : -1;
        if (i < 0) break;
        if (m.t === 'dm_edit') thread[i] = { ...thread[i], text: m.text, edited: m.at || Date.now() };
        else thread.splice(i, 1);
        this.write({ dms: s.dms });
        this.push();
        break;
      }
      case 'group_message_edit':
      case 'group_message_delete': {
        const g = s.groups[m.groupId];
        const list = g?.messages || [];
        const i = list.findIndex(x => x.id === m.id);
        if (i < 0) break;
        const author = list[i].from === m.from;
        if (m.t === 'group_message_edit') {
          if (!author) break;
          list[i] = { ...list[i], text: m.text, edited: m.at || Date.now() };
        } else {
          if (!author && g.ownerId !== m.from) break;
          list.splice(i, 1);
        }
        g.messages = list;
        this.write({ groups: s.groups });
        this.push();
        break;
      }
      case 'group_sync': {
        // Sync frames carry no history — keep what we already have.
        m.group.messages = s.groups[m.group.id]?.messages || m.group.messages || [];
        s.groups[m.group.id] = m.group;
        this.write({ groups: s.groups });
        this.push();
        break;
      }
      case 'group_deleted': {
        // The owner deleted the group — drop it from our roster.
        if (s.groups[m.groupId]) {
          delete s.groups[m.groupId];
          this.write({ groups: s.groups });
          this.push();
        }
        break;
      }
      // NOTE: there is no standalone 'invite' frame any more. An invite is
      // a message with an attachment, so it arrives through 'dm' or
      // 'group_message' and lives in the conversation as history.
      case 'invite_revoked': {
        this.write({ deadInvites: [...(s.deadInvites || []), m.id].slice(-200) });
        this.push();
        break;
      }
      case 'community_list': {
        const all = {};
        for (const c of Array.isArray(m.communities) ? m.communities : []) if (c?.id) all[c.id] = c;
        this.communitiesLoaded = true;
        this.write({ communities: all });
        this.push();
        break;
      }
      case 'community_sync': {
        const c = m.community;
        if (!c?.id) break;
        const all = s.communities || {};
        all[c.id] = { ...c, messages: c.messages || all[c.id]?.messages || {} };
        this.write({ communities: all });
        this.settleCommunity(c.id, { ok: true, community: all[c.id] });
        this.push();
        break;
      }
      case 'community_deleted': {
        const all = s.communities || {};
        if (all[m.id]) {
          delete all[m.id];
          this.write({ communities: all });
          this.push();
        }
        break;
      }
      case 'community_error': {
        this.settleCommunity(m.id, { ok: false, reason: m.reason || 'That did not work.' });
        break;
      }
      case 'community_message': {
        const all = s.communities || {};
        const c = all[m.id];
        if (!c || !m.message) break;
        const list = (c.messages ||= {})[m.channelId] || [];
        if (!list.some(x => x.id === m.message.id)) list.push(m.message);
        c.messages[m.channelId] = list.slice(-200);
        this.write({ communities: all });
        this.push();
        break;
      }
      // Result of a /solarclient admin command — resolve whoever's waiting.
      case 'admin_result': {
        for (const w of [...this._adminWaiters]) w(m);
        break;
      }
      // Our own (or a queried player's) badge tier changed.
      case 'role': {
        if (m.uuid) this.roleCache.set(String(m.uuid).replace(/-/g, ''), m.role || 'member');
        if (this.self && String(m.uuid).replace(/-/g, '') === String(this.self.id).replace(/-/g, '')) {
          this.myRole = m.role || 'member';
        }
        this.push();
        break;
      }
      case 'global_history': {
        this.globalAvailable = true;
        clearTimeout(this._globalProbe);
        this.globalChat = Array.isArray(m.messages) ? m.messages.slice(-200) : [];
        this.globalCanModerate = !!m.canModerate;
        if (typeof m.viewers === 'number') this.globalViewers = m.viewers;
        this.globalPeople = cleanPeople(m.people);
        this.pushGlobal();
        break;
      }
      case 'online_list': {
        const s2 = this.read();
        const blocked = new Set(s2.blocked);
        const selfId = String(this.self?.id || '').replace(/-/g, '');
        const people = (Array.isArray(m.people) ? m.people : [])
          .filter(p => p && /^[0-9a-f]{32}$/i.test(String(p.uuid || '')) && !blocked.has(p.uuid))
          .map(p => ({
            uuid: String(p.uuid),
            name: String(p.name || '').slice(0, 16),
            inGame: p.status === STATUS.IN_GAME,
            role: typeof p.role === 'string' ? p.role : 'member',
            self: p.uuid === selfId,
            following: s2.following.includes(p.uuid),
            follower: s2.followers.includes(p.uuid),
          }));
        this.emit('online_list', { people, total: Number(m.total) || people.length, hidden: Number(m.hidden) || 0 });
        break;
      }
      case 'global_viewers': {
        if (typeof m.count === 'number') this.globalViewers = m.count;
        this.globalPeople = cleanPeople(m.people);
        this.pushGlobal();
        break;
      }
      case 'global_message': {
        if (!m.message?.id || this.globalChat.some(x => x.id === m.message.id)) break;
        this.globalChat = [...this.globalChat, m.message].slice(-200);
        this.pushGlobal({ incoming: m.message });
        break;
      }
      case 'global_deleted': {
        this.globalChat = this.globalChat.filter(x => x.id !== m.id);
        this.pushGlobal();
        break;
      }
      case 'global_error': {
        this.pushGlobal({ error: m.reason || 'Message not sent.', blocked: !!m.blocked, muted: !!m.muted });
        break;
      }
      case 'req_result': {
        this._modWaiters.get(m.reqId)?.(m);
        break;
      }
      case 'mod_report': {
        if (this.isMod && m.report) this.emit('mod', { kind: 'report', report: m.report });
        break;
      }
      // The server refused a message for breaking the rules. Take back the
      // copy we showed straight away, so nobody thinks it went through.
      case 'msg_blocked': {
        const mineWithId = (x) => m.id && x.id === m.id && (x.mine || x.from === this.self?.id);
        if (m.kind === 'dm' || m.kind === 'dm_edit') {
          for (const thread of Object.values(s.dms || {})) {
            const i = Array.isArray(thread) ? thread.findIndex(mineWithId) : -1;
            if (i >= 0) { thread.splice(i, 1); this.write({ dms: s.dms }); this.push(); break; }
          }
        } else if (m.kind === 'group' || m.kind === 'group_edit') {
          const g = s.groups[m.groupId];
          const i = g?.messages ? g.messages.findIndex(mineWithId) : -1;
          if (i >= 0) { g.messages.splice(i, 1); this.write({ groups: s.groups }); this.push(); }
        }
        if (m.kind !== 'global') this.emit('blocked', { kind: m.kind, reason: m.reason || "Your message wasn't sent." });
        break;
      }
      case 'mod_result': {
        this._modWaiters.get(m.reqId)?.(m);
        break;
      }
      case 'mod_flag': {
        if (this.isMod && m.flag) this.emit('mod', { kind: 'flag', flag: m.flag });
        break;
      }
      case 'mod_changed': {
        if (this.isMod) this.emit('mod', { kind: 'changed' });
        break;
      }
      // Bulk badge lookup answer (mod asked for players on its server).
      case 'roles': {
        for (const [u, r] of Object.entries(m.map || {})) {
          this.roleCache.set(String(u).replace(/-/g, ''), r || 'member');
        }
        for (const w of [...this._roleWaiters]) w(m.map || {});
        this.emit('roles', m.map || {});
        break;
      }
      default: break;
    }
  }

  // ---- follow graph -------------------------------------------------
  follow(uuid, name) {
    const s = this.read();
    if (uuid === this.self?.id) throw new Error("You can't follow yourself.");
    if (s.blocked.includes(uuid)) throw new Error('Unblock them first.');
    if (!s.following.includes(uuid)) s.following.push(uuid);
    s.people[uuid] = { ...(s.people[uuid] || {}), name: name || s.people[uuid]?.name || uuid.slice(0, 8) };
    this.write({ following: s.following, people: s.people });
    this.transport.send({ t: 'follow', uuid });
    this.push();
    return this.snapshot();
  }

  unfollow(uuid) {
    const s = this.read();
    this.write({ following: s.following.filter(u => u !== uuid) });
    this.transport.send({ t: 'unfollow', uuid });
    this.push();
    return this.snapshot();
  }

  /**
   * Blocking is deliberately heavy: it removes the relationship in both
   * directions and suppresses everything from them. A block that still
   * let them see you or message you would not be a block.
   */
  block(uuid) {
    const s = this.read();
    if (!s.blocked.includes(uuid)) s.blocked.push(uuid);
    delete s.dms[uuid];
    delete s.unread[uuid];
    for (const g of Object.values(s.groups)) {
      g.members = (g.members || []).filter(m => m.uuid !== uuid);
    }
    this.write({
      blocked: s.blocked,
      following: s.following.filter(u => u !== uuid),
      followers: s.followers.filter(u => u !== uuid),
      dms: s.dms, unread: s.unread, groups: s.groups,
    });
    this.peers.delete(uuid);
    this.transport.send({ t: 'block', uuid });
    this.push();
    return this.snapshot();
  }

  unblock(uuid) {
    this.write({ blocked: this.read().blocked.filter(u => u !== uuid) });
    this.transport.send({ t: 'unblock', uuid });
    this.push();
    return this.snapshot();
  }

  // ---- messaging ----------------------------------------------------
  sendDm(uuid, text, invite = null, replyTo = null) {
    const s = this.read();
    if (s.blocked.includes(uuid)) throw new Error('You have blocked this person.');
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed && !invite) return this.snapshot();
    const reply = this.replyRef(s.dms[uuid], replyTo);
    const msg = {
      id: crypto.randomUUID(), from: this.self?.id, name: this.self?.name,
      text: trimmed, at: Date.now(), mine: true, invite, reply,
    };
    s.dms[uuid] = [...(s.dms[uuid] || []), msg].slice(-300);
    this.write({ dms: s.dms });
    this.transport.send({ t: 'dm', to: uuid, id: msg.id, text: trimmed, name: this.self?.name, invite, reply });
    this.push();
    return this.snapshot();
  }

  /** Short quote of the message being replied to, or null. */
  replyRef(list, id) {
    const m = id && (list || []).find(x => x.id === id);
    if (!m) return null;
    return { id: m.id, name: m.name || '', text: String(m.text || '').slice(0, 120) };
  }

  isMine(m) { return !!m && (m.mine || (this.self && m.from === this.self.id)); }

  /** Conversation message list + the fields needed to edit/delete in it. */
  conversation(s, kind, id) {
    if (kind === 'group') {
      const g = s.groups[id];
      if (!g) throw new Error('That group no longer exists.');
      return { list: g.messages || [], save: (list) => { g.messages = list; this.write({ groups: s.groups }); }, group: g };
    }
    return { list: s.dms[id] || [], save: (list) => { s.dms[id] = list; this.write({ dms: s.dms }); }, group: null };
  }

  editMessage({ kind, conversationId, id, text }) {
    const s = this.read();
    const conv = this.conversation(s, kind, conversationId);
    const i = conv.list.findIndex(x => x.id === id);
    const m = conv.list[i];
    if (!m) throw new Error('That message no longer exists.');
    if (!this.isMine(m)) throw new Error('You can only edit your own messages.');
    if (m.invite) throw new Error("Invites can't be edited.");
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed) throw new Error("A message can't be empty — delete it instead.");
    if (trimmed === m.text) return this.snapshot();
    conv.list[i] = { ...m, text: trimmed, edited: Date.now() };
    conv.save(conv.list);
    if (kind === 'group') this.transport.send({ t: 'group_message_edit', groupId: conversationId, id, text: trimmed });
    else this.transport.send({ t: 'dm_edit', to: conversationId, id, text: trimmed });
    this.push();
    return this.snapshot();
  }

  /**
   * forEveryone: take it back on every side (your own messages, or any
   * message in a group you own). Otherwise it only disappears for you.
   */
  deleteMessage({ kind, conversationId, id, forEveryone }) {
    const s = this.read();
    const conv = this.conversation(s, kind, conversationId);
    const m = conv.list.find(x => x.id === id);
    if (!m) return this.snapshot();
    if (forEveryone) {
      const ownsGroup = conv.group && conv.group.ownerId === this.self?.id;
      if (!this.isMine(m) && !ownsGroup) throw new Error('You can only delete your own messages for everyone.');
      if (kind === 'group') this.transport.send({ t: 'group_message_delete', groupId: conversationId, id });
      else this.transport.send({ t: 'dm_delete', to: conversationId, id });
    }
    conv.save(conv.list.filter(x => x.id !== id));
    this.push();
    return this.snapshot();
  }

  /** Wipes your copy of a conversation. Other people keep theirs. */
  clearConversation({ kind, conversationId }) {
    const s = this.read();
    this.conversation(s, kind, conversationId).save([]);
    delete s.unread[conversationId];
    this.write({ unread: s.unread });
    this.push();
    return this.snapshot();
  }

  createGroup(name, memberUuids, icon) {
    const s = this.read();
    const id = crypto.randomUUID();
    const members = [
      { uuid: this.self?.id, name: this.self?.name },
      ...(memberUuids || [])
        .filter(u => !s.blocked.includes(u) && u !== this.self?.id)
        .map(u => ({ uuid: u, name: s.people[u]?.name || u.slice(0, 8) })),
    ];
    const group = {
      id, name: String(name || 'Group').slice(0, 40),
      // Group picture everyone in the group sees. Either a member's face
      // (stored as their uuid) or a data URL they picked. Synced with the
      // group itself so it is not a per-device preference.
      icon: icon || null,
      ownerId: this.self?.id, members, messages: [], createdAt: Date.now(),
    };
    s.groups[id] = group;
    this.write({ groups: s.groups });
    this.transport.send({ t: 'group_create', group });
    this.push();
    return group;
  }

  setGroupIcon(groupId, icon) {
    const s = this.read();
    const g = s.groups[groupId];
    if (!g) throw new Error('That group no longer exists.');
    g.icon = icon || null;
    this.write({ groups: s.groups });
    this.transport.send({ t: 'group_icon', groupId, icon: g.icon });
    this.push();
    return g;
  }

  removeFromGroup(groupId, uuid) {
    const s = this.read();
    const g = s.groups[groupId];
    if (!g) throw new Error('That group no longer exists.');
    if (g.ownerId !== this.self?.id) throw new Error('Only the group owner can remove people.');
    g.members = g.members.filter(m => m.uuid !== uuid);
    this.write({ groups: s.groups });
    this.transport.send({ t: 'group_remove', groupId, uuid });
    this.push();
    return g;
  }

  addToGroup(groupId, uuid) {
    const s = this.read();
    const g = s.groups[groupId];
    if (!g) throw new Error('That group no longer exists.');
    if (s.blocked.includes(uuid)) throw new Error('You have blocked this person.');
    if (!g.members.some(m => m.uuid === uuid)) {
      g.members.push({ uuid, name: s.people[uuid]?.name || uuid.slice(0, 8) });
    }
    this.write({ groups: s.groups });
    this.transport.send({ t: 'group_add', groupId, uuid });
    this.push();
    return g;
  }

  leaveGroup(groupId) {
    const s = this.read();
    const g = s.groups[groupId];
    if (!g) return this.snapshot();
    // Either way it leaves MY list: the owner leaving dissolves the group
    // for everyone (the backend deletes it and notifies the rest), and a
    // member leaving just removes themselves — but from their own view the
    // group is gone in both cases. Previously a member's leave only stripped
    // them from the roster and left the group sitting in their list.
    delete s.groups[groupId];
    delete s.unread[groupId];
    this.write({ groups: s.groups, unread: s.unread });
    this.transport.send({ t: 'group_leave', groupId });
    this.push();
    return this.snapshot();
  }

  sendGroupMessage(groupId, text, invite = null, replyTo = null) {
    const s = this.read();
    const g = s.groups[groupId];
    if (!g) throw new Error('That group no longer exists.');
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed && !invite) return this.snapshot();
    const reply = this.replyRef(g.messages, replyTo);
    const msg = {
      id: crypto.randomUUID(), from: this.self?.id, name: this.self?.name,
      text: trimmed, at: Date.now(), mine: true, invite, reply,
    };
    g.messages = [...(g.messages || []), msg].slice(-300);
    this.write({ groups: s.groups });
    this.transport.send({ t: 'group_message', groupId, id: msg.id, text: trimmed, name: this.self?.name, invite, reply });
    this.push();
    return this.snapshot();
  }

  markRead(conversationId) {
    const s = this.read();
    delete s.unread[conversationId];
    this.write({ unread: s.unread });
    this.push();
  }

  // ---- invites ------------------------------------------------------
  /**
   * kind: 'world' (single-player, owner must be present) or 'server'.
   * target: { name } for a world, { address, name } for a server.
   */
  /**
   * Send an invite AS A MESSAGE into a conversation, rather than as a
   * separate notification that lives somewhere else. An invite is a thing
   * someone said to you, so it belongs in the conversation where they said
   * it, with a Join button attached — and it stays there as history.
   *
   * kind 'world'  — your single-player world, named as you see it. Only
   *                 joinable while you are actually in it.
   * kind 'server' — an address. Nothing about you needs to be true for it
   *                 to work, so it stays joinable forever.
   */
  sendInvite({ kind, conversationKind, conversationId, worldName, address, instanceName, versionNumber }) {
    const invite = {
      id: crypto.randomUUID(),
      kind,
      hostUuid: this.self?.id,
      hostName: this.self?.name,
      worldName: kind === 'world' ? String(worldName || instanceName || 'their world') : null,
      address: kind === 'server' ? String(address || '').trim() : null,
      instanceName: instanceName || null,
      versionNumber: versionNumber || null,
      at: Date.now(),
    };
    const text = kind === 'world'
      ? `invited you to “${invite.worldName}”`
      : `invited you to ${invite.address}`;

    if (conversationKind === 'group') this.sendGroupMessage(conversationId, text, invite);
    else this.sendDm(conversationId, text, invite);

    // Remember what we are hosting so a world invite can be revoked when
    // the session ends.
    if (kind === 'world') this.hosting = { id: invite.id, conversationKind, conversationId };
    return invite;
  }

  /** A world invite must not outlive the session that hosted it. */
  revokeHostedInvites() {
    if (!this.hosting) return;
    this.transport.send({ t: 'invite_revoke', id: this.hosting.id });
    this.hosting = null;
    this.push();
  }

  /**
   * Turn an invite message into something joinable, refusing when it
   * can't work. For a single-player world the host's LIVE presence is
   * re-checked at the moment of joining — the world only exists while
   * they are in it, and an invite from an hour ago proves nothing.
   */
  resolveInviteMessage(invite) {
    if (!invite) throw new Error('That invite is no longer available.');
    if (invite.kind === 'server') {
      if (!invite.address) throw new Error('That invite has no address.');
      return { kind: 'server', address: invite.address, name: invite.address };
    }
    const raw = this.peers.get(invite.hostUuid);
    const host = raw && (Date.now() - raw.lastSeen) < PRESENCE_TTL_MS ? raw : null;
    if (!host || host.status !== STATUS.IN_GAME) {
      throw new Error(`${invite.hostName} isn't in that world right now — a single-player world is only open while its owner is playing.`);
    }
    if (!host.activity?.lanPort) {
      throw new Error(`${invite.hostName} hasn't opened their world to LAN yet.`);
    }
    return {
      kind: 'world',
      address: `${host.activity.ip || '127.0.0.1'}:${host.activity.lanPort}`,
      name: invite.worldName,
    };
  }

  /** Find an invite by id across every conversation. */
  findInvite(inviteId) {
    const s = this.read();
    for (const thread of Object.values(s.dms)) {
      const m = thread.find(x => x.invite?.id === inviteId);
      if (m) return m.invite;
    }
    for (const g of Object.values(s.groups)) {
      const m = (g.messages || []).find(x => x.invite?.id === inviteId);
      if (m) return m.invite;
    }
    return null;
  }

  resolveInvite(inviteId) {
    return this.resolveInviteMessage(this.findInvite(inviteId));
  }

  // ---- communities --------------------------------------------------
  settleCommunity(id, result) {
    const done = this._communityWaiters.get(id);
    if (done) done(result);
  }

  /** Send a frame and wait for the server's sync (or error) for that community. */
  communityRequest(id, frame) {
    return new Promise((resolve) => {
      if (this.transport.kind !== 'socket' || !this.transport.connected) {
        return resolve({ ok: false, reason: 'Not connected to SolarClient online.' });
      }
      const done = (result) => {
        clearTimeout(timer);
        if (this._communityWaiters.get(id) === done) this._communityWaiters.delete(id);
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, reason: 'The server did not respond.' }), 10000);
      this._communityWaiters.set(id, done);
      this.transport.send(frame);
    });
  }

  createCommunity({ id, name, channels, messages }) {
    return this.communityRequest(id, { t: 'community_create', community: { id, name, channels, messages } });
  }

  joinCommunity({ id, code }) {
    return this.communityRequest(id, { t: 'community_join', id, code });
  }

  addCommunityChannel({ id, channel }) {
    this.transport.send({ t: 'community_channel_add', id, channel });
  }

  updateCommunity({ id, name, icon }) {
    const msg = { t: 'community_update', id };
    if (typeof name === 'string') msg.name = name.trim().slice(0, 32);
    if (icon === null || typeof icon === 'string') msg.icon = icon;
    return this.communityRequest(id, msg);
  }

  renameCommunityChannel({ id, channelId, name }) {
    if (!this.transport.connected) throw new Error('Not connected to SolarClient online.');
    this.transport.send({ t: 'community_channel_rename', id, channelId, name: String(name || '').trim().slice(0, 32) });
  }

  deleteCommunityChannel({ id, channelId }) {
    if (!this.transport.connected) throw new Error('Not connected to SolarClient online.');
    this.transport.send({ t: 'community_channel_delete', id, channelId });
  }

  leaveCommunity({ id }) {
    const s = this.read();
    const all = s.communities || {};
    delete all[id];
    this.write({ communities: all });
    this.transport.send({ t: 'community_leave', id });
    this.push();
  }

  /** Voice frames: join/leave/audio. Silently dropped while offline. */
  sendVoice(frame) {
    if (!frame || typeof frame.t !== 'string' || !frame.t.startsWith('voice_')) return false;
    if (this.transport.kind !== 'socket' || !this.transport.connected) return false;
    return this.transport.send(frame);
  }

  sendCommunityMessage({ id, channelId, text }) {
    const trimmed = String(text || '').trim().slice(0, 500);
    if (!trimmed) return;
    if (!this.transport.connected) throw new Error('Not connected to SolarClient online.');
    this.transport.send({ t: 'community_message', id, channelId, msgId: crypto.randomUUID(), text: trimmed });
  }

  // ---- settings -----------------------------------------------------
  setSetting(key, value) {
    const s = this.read();
    if (!(key in s.settings)) throw new Error(`Unknown setting: ${key}`);
    s.settings[key] = value;
    this.write({ settings: s.settings });
    if (key === 'serverUrlOverride') this.connect();
    if (key === 'showOnlineStatus' && this.transport.connected) {
      this.transport.send({ t: 'heartbeat', status: STATUS.ONLINE, showStatus: value });
    }
    this.push();
    return s.settings;
  }

  // ---- views --------------------------------------------------------
  friendUuids() {
    const s = this.read();
    return s.following.filter(u => s.followers.includes(u) && !s.blocked.includes(u));
  }

  personOf(s, uuid) {
    const p = this.peers.get(uuid);
    const fresh = p && (Date.now() - p.lastSeen) < PRESENCE_TTL_MS;
    return {
      uuid,
      name: s.people[uuid]?.name || uuid.slice(0, 8),
      // Only ever "online" on a live heartbeat through our own launcher.
      status: fresh ? p.status : STATUS.OFFLINE,
      activity: fresh ? p.activity : null,
      friend: s.following.includes(uuid) && s.followers.includes(uuid),
      following: s.following.includes(uuid),
      follower: s.followers.includes(uuid),
      blocked: s.blocked.includes(uuid),
      unread: s.unread[uuid] || 0,
    };
  }

  /**
   * Invites still worth showing: from the last 6 hours, not revoked, and
   * for a world, only while its host is genuinely in game. Derived from
   * the conversations so there is no second copy to fall out of step.
   */
  pendingInvites(s) {
    const dead = new Set(s.deadInvites || []);
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    const out = [];
    const consider = (msg, conversationKind, conversationId) => {
      const inv = msg.invite;
      if (!inv || inv.hostUuid === this.self?.id) return;
      if (dead.has(inv.id) || inv.at < cutoff) return;
      let joinable = true;
      try { this.resolveInviteMessage(inv); } catch { joinable = false; }
      if (!joinable && inv.kind === 'world') return;   // host left: stop offering it
      out.push({ ...inv, conversationKind, conversationId });
    };
    for (const [uuid, thread] of Object.entries(s.dms)) {
      for (const msg of thread) consider(msg, 'dm', uuid);
    }
    for (const g of Object.values(s.groups)) {
      for (const msg of g.messages || []) consider(msg, 'group', g.id);
    }
    return out.slice(-8);
  }

  snapshot() {
    const s = this.read();
    const visible = (u) => !s.blocked.includes(u);
    const following = s.following.filter(visible).map(u => this.personOf(s, u));
    const followers = s.followers.filter(visible).map(u => this.personOf(s, u));
    const friends = following.filter(p => p.friend);

    return {
      self: this.self,
      connected: this.transport.connected,
      mode: this.transport.kind === 'local' ? 'offline' : (this.transport.connected ? 'online' : 'reconnecting'),
      friends,
      following,
      followers,
      // Full person objects, via the same resolver as everyone else. These
      // used to be bare { uuid, name } pairs with no `blocked` flag, so
      // every `p.blocked` check in the UI read undefined — which is why a
      // blocked person could still be messaged and followed, and why their
      // menu offered "Block" again instead of "Unblock".
      blocked: s.blocked.map(u => this.personOf(s, u)),
      groups: Object.values(s.groups).map(g => ({
        ...g,
        unread: s.unread[g.id] || 0,
        isOwner: g.ownerId === this.self?.id,
      })),
      dms: s.dms,
      communities: Object.values(s.communities || {}).map(c => ({
        ...c,
        isOwner: String(c.ownerId) === String(this.self?.id || '').replace(/-/g, ''),
      })),
      communitiesLoaded: this.communitiesLoaded,
      invites: this.pendingInvites(s),
      settings: s.settings,
      counts: {
        friends: friends.length,
        following: following.length,
        followers: followers.length,
        unread: Object.values(s.unread).reduce((a, b) => a + b, 0),
      },
    };
  }

  push() { const snap = this.snapshot(); this.emit('changed', snap); return snap; }
}

module.exports = { Friends, STATUS, LocalTransport, SocketTransport };
