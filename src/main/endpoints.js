'use strict';
/**
 * Resolves the public SolarClient API base (updates, online count) from the
 * discovery file, caching the last good answer so an offline start still
 * knows where the API lives. No addresses or credentials are baked in here.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { BACKEND_DISCOVERY_URL, FALLBACK_API_URL } = require('./backendConfig');

const REFRESH_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 1000;

let cache = null;
let nextFetchAt = 0;
let inflight = null;

function cacheFile() {
  return path.join(app.getPath('userData'), 'backend-endpoints.json');
}

function readCache() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (j && typeof j.apiUrl === 'string') cache = j;
  } catch { /* none yet */ }
  return cache;
}

function cleanHttp(u) {
  return typeof u === 'string' && /^https?:\/\/[^\s/]+/i.test(u) ? u.replace(/\/+$/, '') : null;
}

function fromFriendsUrl(u) {
  try {
    const x = new URL(String(u).replace(/^ws/i, 'http'));
    return `${x.protocol}//${x.host}`;
  } catch {
    return null;
  }
}

function refresh() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(BACKEND_DISCOVERY_URL, { cache: 'no-store', signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
      const data = await res.json();
      const apiUrl = cleanHttp(data.apiUrl) || fromFriendsUrl(data.friendsUrl);
      if (!apiUrl) throw new Error('discovery has no apiUrl');
      cache = { apiUrl };
      nextFetchAt = Date.now() + REFRESH_MS;
      try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); } catch { /* ok */ }
    } catch {
      nextFetchAt = Date.now() + RETRY_MS;
    } finally {
      inflight = null;
    }
    return readCache();
  })();
  return inflight;
}

async function apiBase() {
  const override = cleanHttp(process.env.UPDATE_VPS_URL);
  if (override) return override;
  if (Date.now() >= nextFetchAt) await refresh();
  return readCache()?.apiUrl || FALLBACK_API_URL;
}

module.exports = { apiBase };
