// puny-muni — local server.
//
// Unlike BART, Muni's real-time data comes from the 511.org API, which needs
// an API key and doesn't allow cross-origin browser requests — so this server
// proxies and caches 511 data for the site in docs/ and exposes it as a JSON
// API. The 511 access lives in lib/transit511.js and the SIRI parsing in
// docs/core.js (both shared with the Vercel functions in api/).
//
// Default 511 keys are rate-limited to 60 requests/hour, so everything is
// fetched lazily and cached: vehicles at most once per REFRESH_MS, departures
// per stop at most once per REFRESH_MS, and the network (lines, stops, route
// geometry) once per day on disk. A manual refresh (?fresh=1) may jump a
// cache, on a ration.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseVehicles, parseStopVisits } = require('./docs/core.js');
const { OPERATOR, REFRESH_SECONDS, getJSON, getQuota, loadNetwork } = require('./lib/transit511.js');

// The key can come from the environment or a gitignored .env file.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (e) {}

const API_KEY = process.env.TRANSIT_511_API_KEY;
const PORT = process.env.PORT || 8643;
const REFRESH_MS = REFRESH_SECONDS * 1000;
const NETWORK_CACHE = path.join(__dirname, '.network-cache.json');

if (!API_KEY) {
  console.error('Missing TRANSIT_511_API_KEY.');
  console.error('Get a free key at https://511.org/open-data/token then run:');
  console.error('  TRANSIT_511_API_KEY=yourkey npm start');
  process.exit(1);
}

// The network changes rarely; cache it on disk for a day so restarts don't
// eat into the hourly request budget.
async function cachedNetwork() {
  try {
    const c = JSON.parse(fs.readFileSync(NETWORK_CACHE, 'utf8'));
    // v3 = route shapes simplified on the way in (see simplify() in the lib)
    if (c.v === 3 && Date.now() - c.at < 24 * 3600 * 1000) return c.network;
  } catch (e) {}
  const network = await loadNetwork(API_KEY, console.log);
  fs.writeFileSync(NETWORK_CACHE, JSON.stringify({ at: Date.now(), v: 3, network }));
  return network;
}

let network = null;

// A manual refresh in the browser is allowed to skip these caches, but not to
// drain the hourly budget with it: one forced 511 call every FORCE_MIN_MS at
// most, and none at all once the budget is down to the last few calls the
// automatic cadence still needs. Only consulted when a cache would otherwise
// have been served, so a forced fetch that was due anyway costs nothing here.
const FORCE_MIN_MS = 10_000;
let lastForced = 0;
function claimForce() {
  if (Date.now() - lastForced < FORCE_MIN_MS) return false;
  const quota = getQuota();
  if (quota.remaining != null && quota.remaining <= 3) return false;
  lastForced = Date.now();
  return true;
}

let vehicleCache = { at: 0, payload: { updated: null, vehicles: [], error: null } };
async function getVehicles(force = false) {
  const cached = Date.now() - vehicleCache.at < REFRESH_MS;
  if (cached && !(force && claimForce())) return vehicleCache.payload;
  vehicleCache.at = Date.now(); // on failure too — wait a full cycle before retrying
  try {
    const data = await getJSON(API_KEY, 'VehicleMonitoring', { agency: OPERATOR });
    vehicleCache.payload = {
      updated: new Date().toISOString(),
      vehicles: parseVehicles(data, network),
      quota: getQuota(),
      error: null,
    };
  } catch (err) {
    vehicleCache.payload = { ...vehicleCache.payload, error: String(err) };
    console.error('Vehicle refresh failed:', err.message);
  }
  return vehicleCache.payload;
}

const stopCaches = new Map(); // stop id -> { at, payload }
async function getDepartures(stop, force = false) {
  const c = stopCaches.get(stop);
  const cached = c && Date.now() - c.at < REFRESH_MS;
  if (cached && !(force && claimForce())) return c.payload;
  let payload;
  try {
    const data = await getJSON(API_KEY, 'StopMonitoring', { agency: OPERATOR, stopcode: stop });
    payload = { updated: new Date().toISOString(), departures: parseStopVisits(data, network), error: null };
  } catch (err) {
    payload = { updated: null, departures: [], error: String(err) };
    console.error('Departures refresh failed:', err.message);
  }
  stopCaches.set(stop, { at: Date.now(), payload });
  return payload;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

// Everything here is text, and most of it is repetitive JSON: the vehicle feed
// is ~10x smaller gzipped and the network (lines, stops, geometry) ~5x, which
// on a page that re-polls every cycle is the difference between megabytes an
// hour and a few hundred kilobytes. Anything under a packet isn't worth the
// header, so small responses go out as they are.
const COMPRESSIBLE = /^(application\/json|text\/|image\/svg)/;
const GZIP_MIN = 1400;

// Keyed by ETag, so a file or a payload that hasn't changed compresses once
// instead of once per request. Bounded: it holds responses, not a heap.
const gzipCache = new Map();
function gzipped(buf, etag) {
  if (gzipCache.has(etag)) return Promise.resolve(gzipCache.get(etag));
  return new Promise((resolve, reject) =>
    zlib.gzip(buf, { level: 6 }, (err, out) => {
      if (err) return reject(err);
      if (gzipCache.size > 32) gzipCache.clear();
      gzipCache.set(etag, out);
      resolve(out);
    }));
}

const etagOf = (buf) => `"${crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 22)}"`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  // `no-cache` rather than a max-age: the browser must always ask, but an
  // unchanged answer costs a 304 instead of the whole body. Live positions go
  // stale in seconds, so guessing an expiry would only serve old vehicles.
  const send = async (code, body, type = 'application/json') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const etag = etagOf(buf);
    const head = {
      'Content-Type': type, 'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); return res.end(); }
    const gzip = code === 200 && wantsGzip && buf.length >= GZIP_MIN && COMPRESSIBLE.test(type);
    const out = gzip ? await gzipped(buf, etag) : buf;
    if (gzip) head['Content-Encoding'] = 'gzip';
    res.writeHead(code, { ...head, 'Content-Length': out.length });
    res.end(out);
  };

  // ?fresh=1 is the manual refresh asking to skip the cache; claimForce() decides
  const force = url.searchParams.get('fresh') === '1';
  if (url.pathname === '/api/vehicles') return send(200, JSON.stringify(await getVehicles(force)));
  if (url.pathname === '/api/departures') {
    const stop = url.searchParams.get('stop');
    if (!stop || !network.stops[stop]) return send(400, '{"error":"unknown stop"}');
    return send(200, JSON.stringify(await getDepartures(stop, force)));
  }
  if (url.pathname === '/api/network') {
    return send(200, JSON.stringify({
      refreshSeconds: REFRESH_SECONDS, // the browser polls at whatever cadence the server uses
      routes: Object.values(network.routes),
      stops: Object.values(network.stops),
    }));
  }

  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const fsPath = path.join(__dirname, 'docs', path.normalize(file));
  if (!fsPath.startsWith(path.join(__dirname, 'docs'))) return send(404, '{"error":"not found"}');
  fs.readFile(fsPath, (err, data) => {
    if (err) return send(404, '{"error":"not found"}');
    send(200, data, MIME[path.extname(fsPath)] || 'application/octet-stream');
  });
});

(async () => {
  network = await cachedNetwork();
  console.log(`Loaded ${Object.keys(network.routes).length} routes, ${Object.keys(network.stops).length} stops.`);
  server.listen(PORT, () => {
    console.log(`Refreshing live positions every ${REFRESH_SECONDS}s.`);
    console.log(`puny-muni running at http://localhost:${PORT}`);
  });
})();
