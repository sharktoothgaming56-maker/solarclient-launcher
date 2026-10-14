// =====================================================================
// CALLS, SCREEN SHARE AND WEBCAM
// Friend calls (audio + video) and community voice screen share / webcam.
// The media goes straight between players over WebRTC; the SolarClient
// server only passes the small setup messages along (voice_call_*,
// voice_rtc, voice_media), and a relay is only used for networks that
// can't connect directly. Community voice audio keeps its own Opus relay
// (renderer.js); this adds video on top of it.
// Loaded after renderer.js and shares its globals (voice prefs, mic chain,
// friendsState, toasts, faces).
// =====================================================================
(function scMediaModule() {
  const CALL_RING_MS = 35000;
  const CALL_CONNECT_MS = 25000;
  let rtcIce = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const links = new Map();           // `${scope}|${uuid}` -> link
  const local = { screen: null, cam: null, screenOpts: null };
  let call = null;                   // the friend call, ringing or live
  const roomWatch = new Set();       // people in the voice room whose screen we're watching
  let roomMembers = [];              // last voice_room member list for the room we're in

  const ICONS = {
    cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/></svg>',
    camOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/><path d="M12 6.5 8.5 10H11v4h2v-4h2.5z"/></svg>',
    screenOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/><path d="M9 8l6 6m0-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    full: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    grow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11V3h-8l3.3 3.3-10 10L3 13v8h8l-3.3-3.3 10-10z"/></svg>',
    caret: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  // ---------- preferences ----------
  const PREFS_KEY = 'solar.media.prefs';
  const QUALITY = {
    source: { label: 'Source', w: 7680, h: 4320 },
    2160: { label: '4K', w: 3840, h: 2160 },
    1440: { label: '1440p', w: 2560, h: 1440 },
    1080: { label: '1080p', w: 1920, h: 1080 },
    720: { label: '720p', w: 1280, h: 720 },
  };
  function prefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { p = {}; }
    return {
      quality: QUALITY[p.quality] ? String(p.quality) : 'source',
      fps: [30, 60, 120].includes(p.fps) ? p.fps : 60,
      hint: p.hint === 'motion' ? 'motion' : 'detail',
      audio: p.audio === true,
      camId: typeof p.camId === 'string' ? p.camId : '',
    };
  }
  function savePrefs(patch) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), ...patch })); } catch { /* storage full */ }
  }

  /** Bits per second to allow for a video track; the connection still adapts below it. */
  function bitrateFor(w, h, fps, kind) {
    const bpp = kind === 'cam' ? 0.08 : 0.1;
    return Math.round(Math.min(120e6, Math.max(2.5e6, w * h * fps * bpp)));
  }

  // Hardware encoders first (they keep high resolutions at full frame rate without eating
  // the CPU), then VP9, which handles text and UI best in software. mediaCapabilities
  // reports no hardware for WebRTC here, so probe once by encoding a short test clip.
  let codecOrder = ['video/VP9', 'video/AV1', 'video/H264', 'video/VP8'];
  let hwCodecs = [];
  let probe = null;
  function probeCodecs() {
    probe ||= (async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
      const g = canvas.getContext('2d');
      const src = canvas.captureStream(30);
      let n = 0;
      const draw = setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360},60%,40%)`; g.fillRect(0, 0, 1280, 720); }, 33);
      const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
      const one = async (mime) => {
        if (!caps.some((c) => c.mimeType === mime)) return null;
        const a = new RTCPeerConnection(), b = new RTCPeerConnection();
        try {
          a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate).catch(() => {});
          b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate).catch(() => {});
          const tr = a.addTransceiver(src.getVideoTracks()[0], { direction: 'sendonly' });
          tr.setCodecPreferences([...caps.filter((c) => c.mimeType === mime), ...caps.filter((c) => c.mimeType !== mime)]);
          await a.setLocalDescription();
          await b.setRemoteDescription(a.localDescription);
          await b.setLocalDescription();
          // Below ~360p Chromium always uses the software encoder, so hold the probe at 720p.
          await a.setRemoteDescription({ type: 'answer', sdp: b.localDescription.sdp.replace(/^(a=fmtp:\d+ .*)$/gm, '$1;x-google-start-bitrate=5000') });
          const p = tr.sender.getParameters();
          p.degradationPreference = 'maintain-resolution';
          await tr.sender.setParameters(p).catch(() => {});
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 250));
            let hw = null;
            (await a.getStats()).forEach((s) => { if (s.type === 'outbound-rtp' && s.framesEncoded > 3 && s.frameWidth >= 1280) hw = !!s.powerEfficientEncoder; });
            if (hw !== null) return hw ? mime : null;
          }
          return null;
        } finally { a.close(); b.close(); }
      };
      try {
        hwCodecs = (await Promise.all(['video/AV1', 'video/H264', 'video/VP9'].map((m) => one(m).catch(() => null)))).filter(Boolean);
        codecOrder = [...hwCodecs, ...codecOrder.filter((m) => !hwCodecs.includes(m))];
      } finally {
        clearInterval(draw);
        src.getTracks().forEach((t) => t.stop());
      }
    })().catch(() => {});
    return probe;
  }
  /** Hardware H.264 stops at 4096 wide, so bigger sources (8K) go to VP9/AV1 instead. */
  function codecsFor(track) {
    const w = track?.getSettings?.().width || 0;
    if (w <= 4096) return codecOrder;
    return [...codecOrder.filter((m) => m !== 'video/H264'), 'video/H264'];
  }

  // ---------- signaling ----------
  const signal = (frame) => Promise.resolve(window.nebula.voiceSignal?.(frame)).catch(() => false);
  const send = (l, data) => signal({ t: 'voice_rtc', to: l.uuid, scope: l.scope, data: { ...data, sid: l.sid, to: l.remoteSid || undefined } });
  const roomScope = () => (voiceSession ? `room:${voiceSession.communityId}:${voiceSession.channelId}` : null);
  const callScope = () => (call && call.state !== 'ringing' ? `call:${call.id}` : null);
  const activeScope = () => callScope() || roomScope();
  const isFriend = (uuid) => (friendsState?.friends || []).some((p) => normVoiceId(p.uuid) === normVoiceId(uuid));
  const nameOf = (uuid) => {
    const id = normVoiceId(uuid);
    const s = friendsState || {};
    const hit = [...(s.friends || []), ...(s.following || []), ...(s.followers || [])].find((p) => normVoiceId(p.uuid) === id);
    return hit?.name || s.people?.[uuid]?.name || roomMembers.find((x) => normVoiceId(x.uuid) === id)?.name || 'Player';
  };

  function scopeOk(scope, from) {
    if (typeof scope !== 'string') return false;
    if (scope.startsWith('call:')) {
      return !!call && callScope() === scope && normVoiceId(call.peer.uuid) === normVoiceId(from);
    }
    if (scope.startsWith('room:')) return !call && roomScope() === scope;
    return false;
  }

  // Opus in stereo at a high bitrate (shared PC audio), and a high starting bitrate
  // for video so a share is sharp from the first second instead of ramping up.
  function tuneSdp(sdp) {
    const lines = sdp.split('\r\n');
    const codec = {};
    for (const line of lines) {
      const m = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
      if (m) codec[m[1]] = m[2].toLowerCase();
    }
    return lines.map((line) => {
      const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
      if (!m) return line;
      const c = codec[m[1]];
      if (c === 'opus' && !/maxaveragebitrate/.test(m[2])) return `${line};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`;
      if (['vp9', 'av1', 'h264', 'vp8'].includes(c) && !/x-google-start-bitrate/.test(m[2])) return `${line};x-google-start-bitrate=6000`;
      return line;
    }).join('\r\n');
  }

  // ---------- peer links ----------
  // One RTCPeerConnection per person per call/room. Each side owns its send
  // transceivers ("slots") and tells the other which mid carries what.
  const SLOTS = [['mic', 'audio'], ['screen', 'video'], ['screen', 'audio'], ['cam', 'video']];

  function link(scope, uuid) {
    const key = `${scope}|${normVoiceId(uuid)}`;
    let l = links.get(key);
    if (l) return l;
    const pc = new RTCPeerConnection({ iceServers: rtcIce, bundlePolicy: 'max-bundle' });
    l = {
      key, scope, uuid, pc, isCall: scope.startsWith('call:'),
      polite: myVoiceId() < normVoiceId(uuid), making: false, ignore: false, q: Promise.resolve(),
      tx: new Map(), remoteKinds: {}, remote: new Map(), wants: { screen: false, cam: false }, sentWant: null,
      sid: Math.random().toString(36).slice(2, 12), remoteSid: null, dead: new Set(),
    };
    const me = l;
    pc.onicecandidate = ({ candidate }) => { if (candidate) send(me, { ice: candidate.toJSON() }); };
    pc.onnegotiationneeded = () => offer(me);
    pc.ontrack = () => scanRemote(me);
    pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') { tune(me); scanRemote(me); } };
    pc.onconnectionstatechange = () => onLinkState(me);
    links.set(key, l);
    return l;
  }

  function closeLink(l) {
    links.delete(l.key);
    try { l.pc.close(); } catch { /* already closed */ }
    l.remote.clear();
    paint();
  }

  async function offer(l) {
    try {
      l.making = true;
      const o = await l.pc.createOffer();
      if (l.pc.signalingState !== 'stable') return;
      await l.pc.setLocalDescription({ type: 'offer', sdp: tuneSdp(o.sdp) });
      send(l, { sdp: l.pc.localDescription.toJSON(), kinds: localKinds(l) });
    } catch (err) {
      console.warn('[rtc] offer', err);
    } finally {
      l.making = false;
    }
  }

  function localKinds(l) {
    const kinds = {};
    for (const [slot, tr] of l.tx) if (tr.mid) kinds[tr.mid] = slot.split(':')[0];
    return kinds;
  }

  function onSignal(m) {
    if (!m.from || !scopeOk(m.scope, m.from)) return;
    const data = m.data || {};
    let l = link(m.scope, m.from);
    let restarted = false;
    const sid = typeof data.sid === 'string' ? data.sid : '';
    if (sid) {
      if ((data.to && data.to !== l.sid) || l.dead.has(sid)) return;
      if (l.remoteSid && sid !== l.remoteSid) {
        // They restarted (reload, crash, quick rejoin), so their side of this connection is gone.
        const dead = new Set([...l.dead, l.remoteSid]);
        closeLink(l);
        l = link(m.scope, m.from);
        l.dead = dead;
        restarted = true;
      }
      l.remoteSid = sid;
    }
    const me = l;
    l.q = l.q.then(() => handle(me, data)).then(() => { if (restarted) resume(me); }).catch((err) => console.warn('[rtc] signal', err));
  }

  function resume(l) {
    if (!links.has(l.key)) return;
    if (l.isCall) { sync(l); return; }
    if (voiceSession && l.scope === roomScope()) onRoom({ id: voiceSession.communityId, channelId: voiceSession.channelId, members: roomMembers });
  }

  async function handle(l, data) {
    if (!links.has(l.key)) return;
    if (data.kinds && typeof data.kinds === 'object') Object.assign(l.remoteKinds, data.kinds);
    if (data.want && typeof data.want === 'object') {
      l.wants = { screen: data.want.screen === true, cam: data.want.cam === true };
      sync(l);
    }
    if (data.sdp && (data.sdp.type === 'offer' || data.sdp.type === 'answer')) {
      const isOffer = data.sdp.type === 'offer';
      const collision = isOffer && (l.making || l.pc.signalingState !== 'stable');
      l.ignore = !l.polite && collision;
      if (l.ignore) return;
      await l.pc.setRemoteDescription(data.sdp);
      if (isOffer) {
        const a = await l.pc.createAnswer();
        await l.pc.setLocalDescription({ type: 'answer', sdp: tuneSdp(a.sdp) });
        send(l, { sdp: l.pc.localDescription.toJSON(), kinds: localKinds(l) });
      }
      scanRemote(l);
    }
    if (data.ice) {
      try { await l.pc.addIceCandidate(data.ice); } catch (err) { if (!l.ignore) console.warn('[rtc] ice', err); }
    }
    if (data.bye) closeLink(l);
  }

  /** What this person should get from us right now. */
  function streamFor(l, kind) {
    if (kind === 'mic') return l.isCall ? call?.out?.stream || null : null;
    const s = local[kind];
    if (!s) return null;
    return l.isCall || l.wants[kind] ? s : null;
  }

  function sync(l) {
    if (l.pc.signalingState === 'closed') return;
    for (const [kind, tk] of SLOTS) {
      const stream = streamFor(l, kind);
      const track = stream?.getTracks().find((t) => t.kind === tk && t.readyState === 'live') || null;
      const slot = `${kind}:${tk}`;
      let tr = l.tx.get(slot);
      if (!track && !tr) continue;
      if (!tr) {
        tr = l.pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
        l.tx.set(slot, tr);
        if (tk === 'video' && tr.setCodecPreferences) {
          const caps = RTCRtpReceiver.getCapabilities?.('video')?.codecs || [];
          const order = codecsFor(track);
          const rank = (c) => { const i = order.indexOf(c.mimeType); return i < 0 ? 99 : i; };
          try { tr.setCodecPreferences([...caps].sort((a, b) => rank(a) - rank(b))); } catch { /* browser default */ }
        }
        continue;
      }
      if (tr.sender.track !== track) tr.sender.replaceTrack(track).catch(() => {});
      const dir = track ? 'sendonly' : 'inactive';
      if (tr.direction !== dir) tr.direction = dir;
    }
    tune(l);
  }

  function tune(l) {
    for (const [slot, tr] of l.tx) {
      const t = tr.sender.track;
      if (!t || t.kind !== 'video') continue;
      const kind = slot.split(':')[0];
      const p = tr.sender.getParameters();
      if (!p.encodings?.length) continue;
      const st = t.getSettings();
      const fps = Math.max(1, Math.round(st.frameRate || 30));
      const want = bitrateFor(st.width || 1920, st.height || 1080, fps, kind);
      const e = p.encodings[0];
      if (e.maxBitrate === want && e.maxFramerate === fps) continue;
      e.maxBitrate = want;
      e.maxFramerate = fps;
      e.priority = kind === 'screen' ? 'high' : 'medium';
      e.networkPriority = e.priority;
      p.degradationPreference = kind === 'screen'
        ? (local.screenOpts?.hint === 'motion' ? 'maintain-framerate' : 'maintain-resolution')
        : 'balanced';
      tr.sender.setParameters(p).catch(() => {});
    }
  }

  function scanRemote(l) {
    const next = new Map();
    for (const tr of l.pc.getTransceivers()) {
      const kind = tr.mid != null ? l.remoteKinds[tr.mid] : null;
      if (!kind || !/recv/.test(tr.currentDirection || '')) continue;
      if (!next.has(kind)) next.set(kind, []);
      next.get(kind).push(tr.receiver.track);
    }
    let changed = false;
    for (const [kind, tracks] of next) {
      const old = l.remote.get(kind);
      const same = old && old.getTracks().length === tracks.length && tracks.every((t) => old.getTracks().includes(t));
      if (same) continue;
      l.remote.set(kind, new MediaStream(tracks));
      changed = true;
    }
    for (const kind of [...l.remote.keys()]) if (!next.has(kind)) { l.remote.delete(kind); changed = true; }
    if (changed) paint();
  }

  function onLinkState(l) {
    const st = l.pc.connectionState;
    if (l.isCall && call && callScope() === l.scope) {
      if (st === 'connected' && call.state !== 'live') {
        call.state = 'live';
        call.startedAt = call.startedAt || Date.now();
        clearTimeout(call.timer);
        playVoiceSfx('join');
      } else if (st === 'disconnected' && call.state === 'live') {
        call.state = 'reconnecting';
      } else if (st === 'connected' && call.state === 'reconnecting') {
        call.state = 'live';
      } else if (st === 'failed') {
        try { l.pc.restartIce(); } catch { /* closing */ }
      }
      paintCall();
    }
    if (st === 'closed') closeLink(l);
  }

  // ---------- local media ----------
  async function startScreen() {
    if (!activeScope()) return;
    probeCodecs();
    const pick = await screenPicker();
    if (!pick) return;
    await Promise.race([probeCodecs(), new Promise((r) => setTimeout(r, 3000))]);
    savePrefs({ quality: pick.quality, fps: pick.fps, hint: pick.hint, audio: pick.audio });
    const q = pick.quality === 'source' || !QUALITY[pick.quality] ? { w: pick.w || 3840, h: pick.h || 2160 } : QUALITY[pick.quality];
    let stream;
    try {
      await window.nebula.mediaPick({ id: pick.id, audio: pick.audio });
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: pick.fps, max: pick.fps } },
        audio: pick.audio,
      });
    } catch (err) {
      showToast('Screen share', escapeHtml(err?.message || "Couldn't start sharing."), 'error');
      return;
    }
    if (!activeScope()) { stream.getTracks().forEach((t) => t.stop()); return; }
    const v = stream.getVideoTracks()[0];
    if (v) {
      v.contentHint = pick.hint === 'motion' ? 'motion' : 'detail';
      v.addEventListener('ended', () => { if (local.screen === stream) stopScreen(); });
    }
    stopScreen(true);
    local.screen = stream;
    local.screenOpts = pick;
    changed();
  }

  function stopScreen(quiet = false) {
    const s = local.screen;
    if (!s) return;
    local.screen = null;
    local.screenOpts = null;
    s.getTracks().forEach((t) => t.stop());
    if (!quiet) changed();
  }

  // Without a deviceId Chromium picks whichever camera best fits 4K60, which is
  // often a virtual one (OBS, PRISM) that shows nothing. Default to a real one.
  const VIRTUAL_CAM = /virtual|\bobs\b|prism|lsvcam|xsplit|manycam|snap camera|splitcam|\bvcam\b|\bndi\b/i;
  async function listCams() {
    try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
  }
  function defaultCam(cams) {
    return (cams.find((d) => d.label && !VIRTUAL_CAM.test(d.label)) || cams[0])?.deviceId || '';
  }

  async function startCam(deviceId = prefs().camId, retry = true) {
    if (!activeScope()) return;
    await Promise.race([probeCodecs(), new Promise((r) => setTimeout(r, 3000))]);
    // Resolution first (asking for 60 fps up front makes most webcams drop to 720p),
    // then 60 fps only if the camera can do it at that size.
    const video = { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } };
    const id = deviceId || defaultCam(await listCams());
    if (id) video.deviceId = { exact: id };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video });
    } catch (err) {
      if (deviceId && retry) { savePrefs({ camId: '' }); return startCam('', false); }
      const msg = err?.name === 'NotFoundError' ? 'No camera found.'
        : err?.name === 'NotReadableError' ? 'Your camera is being used by another app.'
        : (err?.message || "Couldn't turn on the camera.");
      showToast('Camera', escapeHtml(msg), 'error');
      return;
    }
    if (!activeScope()) { stream.getTracks().forEach((t) => t.stop()); return; }
    const v = stream.getVideoTracks()[0];
    if (v) {
      v.contentHint = 'motion';
      v.addEventListener('ended', () => { if (local.cam === stream) stopCam(); });
      const { width, height } = v.getSettings();
      if (width && height && (v.getCapabilities?.().frameRate?.max || 0) >= 50) {
        await v.applyConstraints({ width: { exact: width }, height: { exact: height }, frameRate: { min: 50, ideal: 60 } })
          .catch(() => v.applyConstraints({ width: { exact: width }, height: { exact: height }, frameRate: { ideal: 30 } }).catch(() => {}));
      }
    }
    stopCam(true);
    local.cam = stream;
    changed();
  }

  function stopCam(quiet = false) {
    const s = local.cam;
    if (!s) return;
    local.cam = null;
    s.getTracks().forEach((t) => t.stop());
    if (!quiet) changed();
  }

  function stopAll() {
    stopScreen(true);
    stopCam(true);
  }

  /** Our shares changed: update every link in the active call/room and tell the room. */
  function changed() {
    const scope = activeScope();
    for (const l of links.values()) if (l.scope === scope) sync(l);
    if (voiceSession && !call) signal({ t: 'voice_media', screen: !!local.screen, cam: !!local.cam });
    paint();
  }

  async function camMenu(x, y) {
    const cams = await listCams();
    const cur = prefs().camId || defaultCam(cams);
    const items = cams.map((d, i) => [d.label || `Camera ${i + 1}`, () => {
      savePrefs({ camId: d.deviceId });
      if (local.cam) startCam(d.deviceId);
    }, { check: true, on: d.deviceId === cur }]);
    if (!items.length) items.push(['No cameras found', null, {}]);
    if (local.cam) items.push('-', ['Turn off camera', () => stopCam(), { danger: true }]);
    scMenu(x, y, items, { title: 'Camera' });
  }

  // ---------- screen picker ----------
  function screenPicker() {
    return new Promise((resolve) => {
      const p = prefs();
      const scrim = document.createElement('div');
      scrim.className = 'sp-scrim';
      scrim.innerHTML = `
        <div class="sp" role="dialog" aria-label="Share your screen">
          <div class="sp-head"><span class="sp-ic">${ICONS.screen}</span><b>Share your screen</b><button type="button" class="sp-x" aria-label="Close">&times;</button></div>
          <div class="sp-tabs"><button type="button" data-tab="screen" class="on">Screens</button><button type="button" data-tab="window">Windows</button></div>
          <div class="sp-grid"><div class="sp-wait">Finding screens…</div></div>
          <div class="sp-opts">
            <div class="sp-opt"><span>Quality</span><div class="sp-seg" data-k="quality"></div></div>
            <div class="sp-opt"><span>Frame rate</span><div class="sp-seg" data-k="fps"></div></div>
            <div class="sp-opt"><span>Best for</span><div class="sp-seg" data-k="hint">
              <button type="button" data-v="detail">Text &amp; detail</button><button type="button" data-v="motion">Games &amp; video</button></div></div>
            <label class="sp-audio ${navigator.platform.startsWith('Win') ? '' : 'hidden'}"><span class="toggle"><input type="checkbox" class="sp-audio-in"><span class="toggle-track"><span class="toggle-thumb"></span></span></span>
              <span><b>Share PC audio</b><em>Everything you hear, including voice chat.</em></span></label>
          </div>
          <div class="sp-foot"><span class="sp-note"></span><button type="button" class="sp-cancel">Cancel</button><button type="button" class="sp-go" disabled>${ICONS.screen}Go live</button></div>
        </div>`;
      document.body.appendChild(scrim);
      const $ = (s) => scrim.querySelector(s);
      const state = { tab: 'screen', sources: [], pick: null, quality: p.quality, fps: p.fps, hint: p.hint };
      $('.sp-audio-in').checked = p.audio;
      const done = (val) => {
        document.removeEventListener('keydown', onKey, true);
        scrim.classList.add('out');
        setTimeout(() => scrim.remove(), 160);
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        if (e.key === 'Enter' && state.pick) { e.stopPropagation(); go(); }
      };
      document.addEventListener('keydown', onKey, true);
      scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) done(null); });
      $('.sp-x').addEventListener('click', () => done(null));
      $('.sp-cancel').addEventListener('click', () => done(null));

      const paintOpts = () => {
        const src = state.pick;
        const native = src?.w ? `${src.w}×${src.h}` : '';
        $('[data-k="quality"]').innerHTML = Object.entries(QUALITY).map(([k, q]) => {
          const tooBig = src?.w && k !== 'source' && q.h > src.h;
          return `<button type="button" data-v="${k}" ${tooBig ? 'disabled' : ''}>${k === 'source' ? `Source${native ? ` <em>${native}</em>` : ''}` : q.label}</button>`;
        }).join('');
        const fpsList = [30, 60, ...(!src?.hz || src.hz >= 120 ? [120] : [])];
        if (!fpsList.includes(state.fps)) state.fps = 60;
        $('[data-k="fps"]').innerHTML = fpsList.map((f) => `<button type="button" data-v="${f}">${f} fps</button>`).join('');
        if (src?.w && state.quality !== 'source' && QUALITY[state.quality].h > src.h) state.quality = 'source';
        for (const seg of scrim.querySelectorAll('.sp-seg')) {
          const v = String(state[seg.dataset.k]);
          seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
        }
        const q = QUALITY[state.quality];
        const w = state.quality === 'source' ? (src?.w || 0) : q.w;
        const h = state.quality === 'source' ? (src?.h || 0) : q.h;
        $('.sp-note').textContent = src
          ? `${w ? `${w}×${h}` : 'Full size'} at ${state.fps} fps, sent straight to viewers`
          : 'Pick a screen or window';
        $('.sp-go').disabled = !src;
      };
      scrim.querySelector('.sp-opts').addEventListener('click', (e) => {
        const b = e.target.closest('.sp-seg button');
        if (!b || b.disabled) return;
        const k = b.closest('.sp-seg').dataset.k;
        state[k] = k === 'fps' ? Number(b.dataset.v) : b.dataset.v;
        paintOpts();
      });
      const paintGrid = () => {
        const list = state.sources.filter((s) => s.kind === state.tab);
        scrim.querySelectorAll('.sp-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
        $('.sp-grid').innerHTML = list.length ? list.map((s, i) => `
          <button type="button" class="sp-src${state.pick?.id === s.id ? ' on' : ''}" data-id="${escapeHtml(s.id)}" style="--i:${Math.min(i, 10)}">
            <span class="sp-thumb">${s.thumb ? `<img src="${s.thumb}" alt="">` : ''}</span>
            <span class="sp-name">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<span>${escapeHtml(s.name)}</span>${s.w ? `<em>${s.w}×${s.h}${s.hz ? ` · ${s.hz}Hz` : ''}</em>` : ''}</span>
          </button>`).join('') : `<div class="sp-wait">No ${state.tab === 'screen' ? 'screens' : 'windows'} to share.</div>`;
      };
      $('.sp-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tab]');
        if (!b) return;
        state.tab = b.dataset.tab;
        paintGrid();
      });
      $('.sp-grid').addEventListener('click', (e) => {
        const b = e.target.closest('.sp-src');
        if (!b) return;
        state.pick = state.sources.find((s) => s.id === b.dataset.id) || null;
        scrim.querySelectorAll('.sp-src').forEach((x) => x.classList.toggle('on', x === b));
        paintOpts();
      });
      $('.sp-grid').addEventListener('dblclick', (e) => { if (e.target.closest('.sp-src') && state.pick) go(); });
      const go = () => {
        if (!state.pick) return;
        const screens = state.sources.filter((s) => s.kind === 'screen' && s.w);
        const big = screens.sort((a, b) => b.w * b.h - a.w * a.h)[0] || { w: 3840, h: 2160 };
        done({
          id: state.pick.id, name: state.pick.name, w: state.pick.w || big.w, h: state.pick.h || big.h,
          quality: state.quality, fps: state.fps, hint: state.hint, audio: $('.sp-audio-in').checked,
        });
      };
      $('.sp-go').addEventListener('click', go);
      paintOpts();
      window.nebula.mediaSources().then((list) => {
        state.sources = Array.isArray(list) ? list : [];
        state.pick = state.sources.find((s) => s.kind === 'screen') || null;
        paintGrid();
        paintOpts();
      }).catch((err) => {
        $('.sp-grid').innerHTML = `<div class="sp-wait">${escapeHtml(err?.message || "Couldn't list your screens.")}</div>`;
      });
    });
  }

  // ---------- calls ----------
  let toneTimer = 0;
  function tone(kind) {
    clearInterval(toneTimer);
    toneTimer = 0;
    if (!kind) return;
    const play = () => {
      try {
        if (!voiceSfxCtx) { voiceSfxCtx = new AudioContext(); routeOutput(voiceSfxCtx); }
        const ctx = voiceSfxCtx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const peak = Math.max(0.0002, (kind === 'ring' ? 0.22 : 0.1) * (voicePrefs().outputVolume / 100));
        const notes = kind === 'ring'
          ? [[783.99, 0], [987.77, 0.14], [783.99, 0.42], [987.77, 0.56]]
          : [[440, 0], [480, 0]];
        const len = kind === 'ring' ? 0.13 : 1.1;
        const t0 = ctx.currentTime + 0.02;
        for (const [freq, at] of notes) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          const start = t0 + at;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
          gain.gain.setValueAtTime(peak, start + len - 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
          osc.connect(gain).connect(ctx.destination);
          osc.start(start);
          osc.stop(start + len + 0.02);
        }
      } catch { /* no audio device */ }
    };
    play();
    toneTimer = setInterval(play, kind === 'ring' ? 2200 : 3200);
  }

  async function startCall(person) {
    if (!person?.uuid) return;
    if (!friendsState?.connected) { showToast('Calls', 'Connect to SolarClient online to call your friends.', 'error'); return; }
    if (!isFriend(person.uuid)) {
      showToast('Follow each other first', `You can call ${escapeHtml(person.name || 'them')} once you follow each other.`, 'info');
      return;
    }
    if (call) {
      if (normVoiceId(call.peer.uuid) !== normVoiceId(person.uuid)) showToast('Already in a call', 'Hang up first.', 'info');
      return;
    }
    probeCodecs();
    const c = { id: crypto.randomUUID(), peer: { uuid: person.uuid, name: person.name || nameOf(person.uuid) }, dir: 'out', state: 'ringing', at: Date.now() };
    call = c;
    tone('ringback');
    paintCall();
    const ok = await signal({ t: 'voice_call_ring', to: c.peer.uuid, callId: c.id, name: friendsState?.self?.name });
    if (call !== c) return;
    if (!ok) { end('Could not reach SolarClient online.'); return; }
    c.timer = setTimeout(() => {
      if (call !== c || c.state !== 'ringing') return;
      signal({ t: 'voice_call_end', to: c.peer.uuid, callId: c.id });
      end(`${c.peer.name} didn't answer.`);
    }, CALL_RING_MS);
  }

  function onRing(m) {
    if (!m.from || !m.callId) return;
    const name = String(m.name || nameOf(m.from)).slice(0, 16);
    if (call) {
      signal({ t: 'voice_call_busy', to: m.from, callId: m.callId });
      showToast('Missed call', `${escapeHtml(name)} tried to call you while you were in a call.`, 'info');
      return;
    }
    probeCodecs();
    const c = { id: String(m.callId), peer: { uuid: m.from, name }, dir: 'in', state: 'ringing', at: Date.now() };
    call = c;
    tone('ring');
    paintCall();
    window.nebula.callAttention?.({ on: true, title: `${name} is calling`, body: 'Open SolarClient to answer.' });
    c.timer = setTimeout(() => {
      if (call !== c || c.state !== 'ringing') return;
      signal({ t: 'voice_call_end', to: c.peer.uuid, callId: c.id });
      end(null);
      showToast('Missed call', escapeHtml(name), 'info');
    }, CALL_RING_MS);
  }

  async function accept() {
    const c = call;
    if (!c || c.dir !== 'in' || c.state !== 'ringing') return;
    clearTimeout(c.timer);
    tone(null);
    window.nebula.callAttention?.({ on: false });
    if (voiceSession) await leaveVoice(true);
    c.state = 'connecting';
    paintCall();
    await openCallMic(c);
    if (call !== c) return;
    signal({ t: 'voice_call_accept', to: c.peer.uuid, callId: c.id });
    connect(c);
  }

  async function onAccept(m) {
    const c = call;
    if (!c || c.id !== m.callId || c.dir !== 'out' || c.state !== 'ringing') return;
    clearTimeout(c.timer);
    tone(null);
    if (voiceSession) await leaveVoice(true);
    c.state = 'connecting';
    paintCall();
    await openCallMic(c);
    if (call !== c) return;
    connect(c);
  }

  function connect(c) {
    const l = link(`call:${c.id}`, c.peer.uuid);
    sync(l);
    c.timer = setTimeout(() => {
      if (call === c && c.state === 'connecting') {
        signal({ t: 'voice_call_end', to: c.peer.uuid, callId: c.id });
        end("Couldn't connect the call. One of your networks may be blocking it.");
      }
    }, CALL_CONNECT_MS);
  }

  function decline() {
    const c = call;
    if (!c) return;
    signal({ t: c.dir === 'in' && c.state === 'ringing' ? 'voice_call_decline' : 'voice_call_end', to: c.peer.uuid, callId: c.id });
    end(null);
  }

  function onRemoteEnd(m) {
    const c = call;
    if (!c || c.id !== m.callId) return;
    if (m.from && normVoiceId(m.from) !== normVoiceId(c.peer.uuid)) return;
    const who = escapeHtml(c.peer.name);
    const why = {
      voice_call_decline: `${who} declined.`,
      voice_call_busy: `${who} is in another call.`,
    }[m.t] || {
      offline: `${who} isn't online.`,
      not_friends: `You can only call friends.`,
      answered_elsewhere: null,
    }[m.reason];
    const missed = c.dir === 'in' && c.state === 'ringing' && m.reason !== 'answered_elsewhere';
    end(why === undefined ? (c.state === 'ringing' ? null : 'Call ended.') : why);
    if (missed) showToast('Missed call', who, 'info');
  }

  function end(msg) {
    const c = call;
    if (!c) return;
    call = null;
    clearTimeout(c.timer);
    tone(null);
    window.nebula.callAttention?.({ on: false });
    for (const l of [...links.values()]) if (l.scope === `call:${c.id}`) closeLink(l);
    closeCallMic(c);
    if (!voiceSession) stopAll();
    for (const a of callAudio.values()) { a.srcObject = null; a.remove(); }
    callAudio.clear();
    if (c.state === 'live' || c.state === 'reconnecting') playVoiceSfx('leave');
    paintCall();
    paint();
    if (msg) showToast('Call', msg, 'info');
  }

  // Your mic goes through the same cleanup as voice chat (low cut, RNNoise, volume),
  // then into the call as an ordinary WebRTC track.
  async function openCallMic(c) {
    const ctx = new AudioContext({ sampleRate: VOICE_RATE, latencyHint: 'interactive' });
    const s = { ctx, closed: false, peers: new Map(), master: null, stream: null, src: null, denoise: null, routedDenoise: null };
    s.lowCut = ctx.createBiquadFilter();
    s.lowCut.type = 'highpass';
    s.micGain = ctx.createGain();
    s.dest = ctx.createMediaStreamDestination();
    s.micGain.connect(s.dest);
    try {
      s.denoise = await createDenoiser(ctx);
      s.denoise.connect(s.micGain);
    } catch { s.denoise = null; }
    s.stream = null;
    c.out = { ctx, graph: s, stream: s.dest.stream };
    applyVoicePrefs(s);
    try {
      await attachMic(s);
    } catch (err) {
      showToast('Microphone', escapeHtml(err?.message || "Couldn't use the microphone. You're muted."), 'error');
    }
    applyCallPrefs();
  }

  function closeCallMic(c) {
    const s = c.out?.graph;
    if (!s) return;
    s.closed = true;
    try { s.denoise?.port.postMessage('destroy'); } catch { /* ok */ }
    try { s.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ok */ }
    c.out.ctx.close().catch(() => {});
    c.out = null;
  }

  function applyCallPrefs() {
    const p = voicePrefs();
    const t = call?.out?.stream?.getAudioTracks()[0];
    if (t) t.enabled = !(p.muted || p.deafened);
    if (call?.out?.graph) applyVoicePrefs(call.out.graph);
    for (const a of callAudio.values()) {
      a.muted = p.deafened;
      a.volume = Math.min(1, (p.outputVolume / 100) * (peerVolume(a.dataset.uuid) / 100));
      if (a.setSinkId && (a.sinkId || '') !== p.outputId) a.setSinkId(p.outputId).catch(() => {});
    }
    for (const t2 of tiles.values()) if (!t2.mine) t2.video.muted = p.deafened;
  }

  // ---------- community voice rooms ----------
  function onRoom(m) {
    const scope = `room:${m.id}:${m.channelId}`;
    if (scope !== roomScope() || call) return;
    const me = myVoiceId();
    roomMembers = Array.isArray(m.members) ? m.members : [];
    const here = new Set();
    for (const x of roomMembers) {
      const u = normVoiceId(x.uuid);
      if (u === me) continue;
      here.add(u);
      if (!x.screen) roomWatch.delete(u);
      const want = { cam: !!x.cam, screen: !!x.screen && roomWatch.has(u) };
      const key = `${scope}|${u}`;
      if (!want.cam && !want.screen && !links.has(key)) continue;
      const l = link(scope, x.uuid);
      if (l.sentWant?.cam !== want.cam || l.sentWant?.screen !== want.screen) {
        l.sentWant = want;
        send(l, { want });
      }
    }
    for (const l of [...links.values()]) if (l.scope === scope && !here.has(normVoiceId(l.uuid))) closeLink(l);
    paint();
  }

  function watch(uuid, on) {
    const u = normVoiceId(uuid);
    if (on) roomWatch.add(u); else roomWatch.delete(u);
    const scope = roomScope();
    if (!scope) return;
    onRoom({ id: voiceSession.communityId, channelId: voiceSession.channelId, members: roomMembers });
  }

  function onVoiceLeave() {
    const scope = [...links.values()].filter((l) => l.scope.startsWith('room:'));
    scope.forEach(closeLink);
    roomWatch.clear();
    roomMembers = [];
    if (!call) stopAll();
    paint();
  }

  async function beforeVoiceJoin() {
    if (call) decline();
    for (const l of [...links.values()]) if (l.scope.startsWith('room:')) closeLink(l);
    roomWatch.clear();
    roomMembers = [];
    stopAll();
  }

  // ---------- video tiles ----------
  const tiles = new Map();      // key -> { el, video, mine, kind, frames, at }
  const callAudio = new Map();  // link key -> <audio>

  function tile(key, w) {
    let t = tiles.get(key);
    if (t) return t;
    const el = document.createElement('div');
    el.className = `mv-tile ${w.kind}${w.mine ? ' mine' : ''}`;
    el.innerHTML = `<video autoplay playsinline></video>
      <span class="mv-label"><b></b><em class="mv-res"></em></span>
      <button type="button" class="mv-full" title="Full screen" aria-label="Full screen">${ICONS.full}</button>`;
    const video = el.querySelector('video');
    video.muted = w.mine || w.kind === 'cam' || voicePrefs().deafened;
    t = { el, video, mine: w.mine, kind: w.kind, frames: 0, at: 0 };
    el.querySelector('.mv-full').addEventListener('click', (e) => { e.stopPropagation(); toggleFull(el); });
    el.addEventListener('dblclick', () => { if (!el.classList.contains('loop')) toggleFull(el); });
    const sink = voicePrefs().outputId;
    if (sink && video.setSinkId) video.setSinkId(sink).catch(() => {});
    tiles.set(key, t);
    return t;
  }

  function toggleFull(el) {
    if (document.fullscreenElement === el) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }

  function wanted() {
    const out = [];
    const scope = activeScope();
    if (!scope) return out;
    if (local.screen) out.push({ key: 'me:screen', stream: local.screen, kind: 'screen', mine: true, label: 'Your screen' });
    if (local.cam) out.push({ key: 'me:cam', stream: local.cam, kind: 'cam', mine: true, label: 'You' });
    for (const l of links.values()) {
      if (l.scope !== scope) continue;
      const who = l.isCall ? call.peer.name : nameOf(l.uuid);
      for (const [kind, stream] of l.remote) {
        if (kind === 'mic') continue;
        out.push({ key: `${l.key}:${kind}`, stream, kind, mine: false, label: kind === 'screen' ? `${who}'s screen` : who });
      }
    }
    return out;
  }

  function paint() {
    const host = callScope() ? document.getElementById('call-stage') : document.getElementById('cs-video-grid');
    const want = wanted();
    for (const [key, t] of tiles) {
      if (want.some((w) => w.key === key)) continue;
      t.video.srcObject = null;
      t.el.remove();
      tiles.delete(key);
    }
    for (const w of want) {
      const t = tile(w.key, w);
      if (t.video.srcObject !== w.stream) t.video.srcObject = w.stream;
      t.el.querySelector('.mv-label b').textContent = w.label;
      // Your own whole-screen share, full screen, films itself forever (the cursor smears everywhere).
      const loop = w.mine && w.kind === 'screen' && String(local.screenOpts?.id || '').startsWith('screen:');
      t.el.classList.toggle('loop', loop);
      t.el.title = loop ? 'What others see. No full screen for your own screen, it would show itself.' : '';
      if (loop && document.fullscreenElement === t.el) document.exitFullscreen().catch(() => {});
      if (host && t.el.parentNode !== host) {
        host.appendChild(t.el);
        t.video.play().catch(() => {});
      }
    }
    if (host) {
      host.dataset.n = String(want.length);
      host.classList.toggle('has-video', want.length > 0);
      host.classList.toggle('has-screen', want.some((w) => w.kind === 'screen'));
      host.closest('.cs-voice')?.classList.toggle('has-video', want.length > 0);
    }
    paintCallAudio();
    paintButtons();
    paintRes();
  }

  function paintCallAudio() {
    const scope = callScope();
    const keep = new Set();
    for (const l of links.values()) {
      if (l.scope !== scope) continue;
      const s = l.remote.get('mic');
      if (!s) continue;
      keep.add(l.key);
      let a = callAudio.get(l.key);
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        a.dataset.uuid = l.uuid;
        a.className = 'hidden';
        document.body.appendChild(a);
        callAudio.set(l.key, a);
      }
      if (a.srcObject !== s) { a.srcObject = s; a.play().catch(() => {}); }
    }
    for (const [k, a] of callAudio) if (!keep.has(k)) { a.srcObject = null; a.remove(); callAudio.delete(k); }
    applyCallPrefs();
  }

  // Resolution and frame rate on each tile, so you can see what quality is getting through.
  let resTimer = 0;
  function paintRes() {
    if (resTimer || !tiles.size) return;
    resTimer = setInterval(() => {
      if (!tiles.size) { clearInterval(resTimer); resTimer = 0; return; }
      const now = performance.now();
      for (const t of tiles.values()) {
        const v = t.video;
        const frames = v.getVideoPlaybackQuality?.().totalVideoFrames || 0;
        const fps = t.at ? Math.round(((frames - t.frames) * 1000) / (now - t.at)) : 0;
        t.frames = frames;
        t.at = now;
        const res = v.videoWidth ? `${v.videoWidth}×${v.videoHeight}${fps ? ` · ${fps} fps` : ''}` : '';
        const em = t.el.querySelector('.mv-res');
        if (em.textContent !== res) em.textContent = res;
      }
    }, 1000);
  }

  function paintButtons() {
    const set = (btn, on, onIcon, offIcon, onTitle, offTitle) => {
      if (!btn) return;
      const html = on ? onIcon : offIcon;
      if (btn.dataset.icon !== html) { btn.innerHTML = html; btn.dataset.icon = html; }
      btn.classList.toggle('is-live', on);
      btn.title = on ? onTitle : offTitle;
      btn.setAttribute('aria-pressed', String(on));
    };
    for (const root of [document.getElementById('call-panel'), document.querySelector('.cs-voice-actions')]) {
      if (!root) continue;
      set(root.querySelector('[data-media="cam"]'), !!local.cam, ICONS.cam, ICONS.camOff, 'Turn off camera', 'Turn on camera');
      set(root.querySelector('[data-media="screen"]'), !!local.screen, ICONS.screenOff, ICONS.screen, 'Stop sharing', 'Share your screen');
    }
  }

  /** Voice channel page: camera + share buttons beside mute/deafen, and the video grid. */
  function bindStage(main) {
    const actions = main.querySelector('.cs-voice-actions');
    const hang = actions?.querySelector('#cs-hangup');
    if (!actions || !hang) return;
    const here = !hang.classList.contains('hidden');
    if (here && !actions.querySelector('[data-media]')) {
      hang.insertAdjacentHTML('beforebegin', `
        <button type="button" class="vc-btn vc-media" data-media="cam"></button>
        <button type="button" class="vc-btn vc-media" data-media="screen"></button>`);
      actions.querySelector('[data-media="cam"]').addEventListener('click', () => (local.cam ? stopCam() : startCam()));
      actions.querySelector('[data-media="cam"]').addEventListener('contextmenu', (e) => { e.preventDefault(); camMenu(e.clientX, e.clientY); });
      actions.querySelector('[data-media="screen"]').addEventListener('click', () => (local.screen ? stopScreen() : startScreen()));
    }
    const members = main.querySelector('#cs-voice-members');
    if (members && !main.querySelector('#cs-video-grid')) members.insertAdjacentHTML('beforebegin', '<div class="mv-grid" id="cs-video-grid"></div>');
    paint();
  }

  /** LIVE / camera badges and a Watch button on voice members who are sharing. */
  function decorateMembers(host) {
    if (!host) return;
    const me = myVoiceId();
    const shown = openCommunityId && openChannelId ? voiceRooms.get(voiceKey(openCommunityId, openChannelId)) || [] : [];
    const inRoom = !call && !!voiceSession && roomScope() === `room:${openCommunityId}:${openChannelId}`;
    for (const row of host.querySelectorAll('.cs-member[data-uuid]')) {
      const u = normVoiceId(row.dataset.uuid);
      const x = shown.find((m) => normVoiceId(m.uuid) === u);
      const mine = u === me;
      const screen = mine ? !!local.screen : !!x?.screen;
      const cam = mine ? !!local.cam : !!x?.cam;
      let badge = row.querySelector('.mv-badges');
      if (!screen && !cam) { badge?.remove(); continue; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mv-badges';
        (row.querySelector('.cs-member-name') || row).after(badge);
      }
      const watching = roomWatch.has(u);
      const html = `${cam ? `<i class="mv-b cam" title="Camera on">${ICONS.cam}</i>` : ''}${screen ? '<i class="mv-b live">LIVE</i>' : ''}`
        + (screen && !mine && inRoom ? `<button type="button" class="mv-watch${watching ? ' on' : ''}" data-watch="${escapeHtml(row.dataset.uuid)}">${watching ? 'Stop watching' : 'Watch'}</button>` : '');
      if (badge.dataset.html !== html) {
        badge.innerHTML = html;
        badge.dataset.html = html;
        badge.querySelector('[data-watch]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          watch(e.currentTarget.dataset.watch, !roomWatch.has(u));
          decorateMembers(host);
        });
      }
    }
  }

  // ---------- call UI ----------
  function paintCall() {
    let card = document.getElementById('call-card');
    let panel = document.getElementById('call-panel');
    const c = call;
    if (!c) {
      card?.classList.add('leaving');
      setTimeout(() => { if (!call) card?.remove(); }, 220);
      panel?.classList.add('leaving');
      setTimeout(() => { if (!call) panel?.remove(); }, 220);
      clearInterval(paintCall.tick);
      paintCall.tick = 0;
      return;
    }
    const face = frAvatar(c.peer.uuid);
    if (c.state === 'ringing') {
      panel?.remove();
      if (!card || card.dataset.id !== c.id) {
        card?.remove();
        card = document.createElement('div');
        card.id = 'call-card';
        card.className = `call-card dir-${c.dir}`;
        card.dataset.id = c.id;
        card.innerHTML = `
          <span class="cc-face"><i></i><i></i><img src="${face}" alt=""></span>
          <span class="cc-txt"><b>${escapeHtml(c.peer.name)}</b><em>${c.dir === 'in' ? 'is calling you' : 'Calling…'}</em></span>
          ${c.dir === 'in' ? `<button type="button" class="cc-btn no" title="Decline">${VOICE_ICONS.hangup}</button>
          <button type="button" class="cc-btn yes" title="Answer">${ICONS.phone}</button>`
            : `<button type="button" class="cc-btn no" title="Cancel">${VOICE_ICONS.hangup}</button>`}`;
        document.body.appendChild(card);
        card.querySelector('.cc-btn.no').addEventListener('click', decline);
        card.querySelector('.cc-btn.yes')?.addEventListener('click', accept);
      }
      return;
    }
    card?.remove();
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'call-panel';
      panel.className = 'call-panel';
      panel.innerHTML = `
        <div class="cp-head">
          <img class="cp-face" src="${face}" alt="">
          <span class="cp-who"><b>${escapeHtml(c.peer.name)}</b><em class="cp-status"></em></span>
          <button type="button" class="cp-grow" title="Bigger">${ICONS.grow}</button>
        </div>
        <div class="cp-stage mv-grid" id="call-stage">
          <div class="cp-idle"><span class="cp-ring"><img src="${frAvatar(c.peer.uuid)}" alt=""></span></div>
        </div>
        <div class="cp-controls">
          <button type="button" class="vc-btn" data-call="mute"></button>
          <button type="button" class="vc-btn" data-call="deafen"></button>
          <span class="cp-split"><button type="button" class="vc-btn vc-media" data-media="cam"></button><button type="button" class="cp-caret" data-call="cams" title="Pick a camera">${ICONS.caret}</button></span>
          <button type="button" class="vc-btn vc-media" data-media="screen"></button>
          <button type="button" class="vc-btn vc-hang" data-call="hang" title="Hang up">${VOICE_ICONS.hangup}</button>
        </div>`;
      document.body.appendChild(panel);
      panel.querySelector('[data-call="hang"]').addEventListener('click', decline);
      panel.querySelector('[data-media="cam"]').addEventListener('click', () => (local.cam ? stopCam() : startCam()));
      panel.querySelector('[data-call="cams"]').addEventListener('click', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        camMenu(r.left, r.top - 8);
      });
      panel.querySelector('[data-media="screen"]').addEventListener('click', () => (local.screen ? stopScreen() : startScreen()));
      panel.querySelector('[data-call="mute"]').addEventListener('click', () => {
        const p = voicePrefs();
        if (p.deafened) saveVoicePrefs({ deafened: false, muted: false });
        else saveVoicePrefs({ muted: !p.muted });
        applyCallPrefs();
        paintCallControls();
      });
      panel.querySelector('[data-call="deafen"]').addEventListener('click', () => {
        saveVoicePrefs({ deafened: !voicePrefs().deafened });
        applyCallPrefs();
        paintCallControls();
      });
      panel.querySelector('.cp-grow').addEventListener('click', () => panel.classList.toggle('big'));
      dragPanel(panel);
      paint();
    }
    paintCallControls();
    const status = panel.querySelector('.cp-status');
    const tick = () => {
      if (!call) return;
      const s = call.state === 'live' && call.startedAt ? Math.floor((Date.now() - call.startedAt) / 1000) : -1;
      status.textContent = s >= 0
        ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
        : call.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
      panel.classList.toggle('live', call.state === 'live');
      const speaking = [...links.values()].some((l) => l.scope === callScope() && l.pc.getReceivers()
        .some((r) => r.track.kind === 'audio' && (r.getSynchronizationSources?.()[0]?.audioLevel || 0) > 0.03));
      panel.classList.toggle('speaking', speaking);
    };
    tick();
    if (!paintCall.tick) paintCall.tick = setInterval(tick, 250);
  }

  function paintCallControls() {
    const panel = document.getElementById('call-panel');
    if (!panel) return;
    const p = voicePrefs();
    const muted = p.muted || p.deafened;
    const mute = panel.querySelector('[data-call="mute"]');
    const deaf = panel.querySelector('[data-call="deafen"]');
    mute.innerHTML = muted ? VOICE_ICONS.micOff : VOICE_ICONS.mic;
    mute.classList.toggle('is-on', muted);
    mute.title = muted ? 'Unmute' : 'Mute';
    deaf.innerHTML = p.deafened ? VOICE_ICONS.headphonesOff : VOICE_ICONS.headphones;
    deaf.classList.toggle('is-on', p.deafened);
    deaf.title = p.deafened ? 'Undeafen' : 'Deafen';
    paintButtons();
  }

  function dragPanel(panel) {
    const head = panel.querySelector('.cp-head');
    head.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || panel.classList.contains('big')) return;
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      const ox = e.clientX - r.left, oy = e.clientY - r.top;
      panel.classList.add('dragging');
      const move = scPerFrame((ev) => {
        panel.style.left = `${Math.max(8, Math.min(ev.clientX - ox, window.innerWidth - r.width - 8))}px`;
        panel.style.top = `${Math.max(40, Math.min(ev.clientY - oy, window.innerHeight - r.height - 8))}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      });
      const up = () => {
        move.flush();
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        panel.classList.remove('dragging');
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  // ---------- events ----------
  window.nebula.onVoiceEvent?.((m) => {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'voice_rtc': onSignal(m); break;
      case 'voice_room': onRoom(m); break;
      case 'voice_call_ring': onRing(m); break;
      case 'voice_call_accept': onAccept(m); break;
      case 'voice_call_decline':
      case 'voice_call_busy':
      case 'voice_call_end': onRemoteEnd(m); break;
      case 'voice_ice':
        if (Array.isArray(m.servers) && m.servers.length) {
          rtcIce = m.servers.filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
        }
        break;
      default: break;
    }
  });
  // Voice rooms are rejoined after a reconnect (renderer.js); tell the room about our shares again once that's done.
  window.nebula.onFriendsConnection?.((c) => {
    if (!c?.connected) return;
    setTimeout(() => {
      if (voiceSession && !call && (local.screen || local.cam)) signal({ t: 'voice_media', screen: !!local.screen, cam: !!local.cam });
    }, 1500);
  });
  window.addEventListener('beforeunload', () => {
    if (call) signal({ t: 'voice_call_end', to: call.peer.uuid, callId: call.id });
  });

  window.scMedia = {
    call: startCall,
    hangUp: decline,
    bindStage,
    decorateMembers,
    onVoiceLeave,
    beforeVoiceJoin,
    get inCall() { return !!call; },
  };
})();
