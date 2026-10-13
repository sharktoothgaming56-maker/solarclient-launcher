// =====================================================================
// BACKEND CONFIG
//
// These ship with the launcher. Nobody using SolarClient should ever see
// a "server URL" box — friends should simply work, the way they do in any
// other launcher. The override below exists only so you can point a test
// build at a staging box without rebuilding.
// =====================================================================

// WHERE THE BACKEND LIVES, AND WHY IT IS LOOKED UP
//
// The address is fetched from a small file you host, rather than being
// hard-coded. That means you can move the backend — a tunnel URL that
// changes on every restart, your PC today and a VPS next month — by
// editing one file, instead of rebuilding the launcher and asking
// everyone to reinstall it.
//
// Point this at a raw file in your PUBLIC releases repo. It should
// contain, and nothing else:
//
//   { "friendsUrl": "wss://whatever-your-tunnel-is.trycloudflare.com/friends" }
//
// Raw GitHub URLs look like:
//   https://raw.githubusercontent.com/<user>/<repo>/main/backend.json
const BACKEND_DISCOVERY_URL =
  'https://raw.githubusercontent.com/sharktoothgaming56-maker/solarclientsite/main/backend.json';

// Used when discovery can't be reached (offline, or you haven't set the
// file up yet). Also what a fresh install uses for its very first attempt,
// before it has ever fetched discovery. Keep api.figgysmp.shop DNS pointed
// at the VPS so these hostname fallbacks resolve.
const FRIENDS_WS_URL = 'ws://api.figgysmp.shop:8090/friends';

// Public HTTP API (update manifest, online count). Discovery's "apiUrl"
// takes precedence; this is only the offline/first-run fallback.
const FALLBACK_API_URL = 'http://api.figgysmp.shop:8090';

// Where hosted servers are reachable. A server named "foo" is published as
// foo.nebulahosting.co, resolved by a wildcard DNS record pointing at the
// VPS, which relays traffic to whoever is hosting it.
const HOSTING_DOMAIN = 'nebulahosting.co';

// The relay the VPS runs for hosted servers. Home connections sit behind
// NAT, so a player cannot reach them directly; the host opens an outbound
// tunnel to this port and the relay forwards players down it.
const RELAY_HOST = 'api.figgysmp.shop';
const RELAY_PORT = 25599;

module.exports = { FRIENDS_WS_URL, FALLBACK_API_URL, BACKEND_DISCOVERY_URL, HOSTING_DOMAIN, RELAY_HOST, RELAY_PORT };
