// puny-muni — local server (required).
//
// Unlike BART, Muni's real-time data comes from the 511.org API, which needs
// an API key and doesn't allow cross-origin browser requests — so this server
// proxies and caches 511 data for the site in docs/ and exposes it as a JSON
// API. The SIRI parsing and route styling live in docs/core.js.
//
// Default 511 keys are rate-limited to 60 requests/hour, so everything is
// fetched lazily and cached: vehicles at most once per REFRESH_MS, departures
// per stop at most once per REFRESH_MS, and the network (lines + stops) once
// per day on disk. A manual refresh (?fresh=1) may jump a cache, on a ration.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { asArray, makeRoute, parseVehicles, parseStopVisits } = require('./docs/core.js');

const API_KEY = process.env.TRANSIT_511_API_KEY;
const PORT = process.env.PORT || 8643;
const OPERATOR = 'SF'; // San Francisco Muni's 511 operator id
// How often live positions and predictions are re-fetched. 65s is the default
// because a free 511 key allows 60 requests an hour and the map spends one per
// cycle; if you've been granted a higher limit, set REFRESH_SECONDS lower.
const REFRESH_SECONDS = Math.min(3600, Math.max(5, Number(process.env.REFRESH_SECONDS) || 65));
const REFRESH_MS = REFRESH_SECONDS * 1000;
const NETWORK_CACHE = path.join(__dirname, '.network-cache.json');

if (!API_KEY) {
  console.error('Missing TRANSIT_511_API_KEY.');
  console.error('Get a free key at https://511.org/open-data/token then run:');
  console.error('  TRANSIT_511_API_KEY=yourkey npm start');
  process.exit(1);
}

const api = (endpoint, params) =>
  `https://api.511.org/transit/${endpoint}?` +
  new URLSearchParams({ api_key: API_KEY, format: 'json', ...params });

// 511 reports the hourly budget on every response; keep the latest so the
// browser can show how much of it is left. This is the number that decides how
// fast the map can possibly refresh.
let quota = { limit: null, remaining: null };

async function getJSON(url) {
  const res = await fetch(url);
  const limit = Number(res.headers.get('ratelimit-limit'));
  const remaining = Number(res.headers.get('ratelimit-remaining'));
  if (Number.isFinite(limit) && limit > 0) {
    quota = { limit, remaining: Number.isFinite(remaining) ? remaining : null };
  }
  if (!res.ok) throw new Error(`511 API ${res.status} for ${url.replace(API_KEY, '<key>')}`);
  const text = await res.text();
  return JSON.parse(text.replace(/^\uFEFF/, '')); // 511 responses start with a BOM
}

// ---- GTFS zip handling, for route geometry -------------------------------
// 511's real-time API has no shapes endpoint, but its `datafeeds` endpoint
// serves the operator's GTFS dataset (one small zip), whose shapes.txt has
// the actual street geometry of every route. Node has no zip reader, so this
// is a minimal one: central directory -> named entries -> inflateRawSync.

function unzip(buf, wanted) {
  let i = buf.length - 22; // End of Central Directory record (no comment)
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error('not a zip file');
  let off = buf.readUInt32LE(i + 16);
  const files = {};
  for (let n = buf.readUInt16LE(i + 10); n > 0; n--) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (wanted.includes(name)) {
      // Local header repeats name/extra with its own lengths; data follows.
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(start, start + csize);
      files[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  for (const name of wanted) if (!(name in files)) throw new Error(`${name} missing from GTFS zip`);
  return files;
}

const splitCsv = (line) =>
  (line.match(/(?:"(?:[^"]|"")*"|[^,])*/g) || []).filter((_, i) => i % 2 === 0)
    .map((f) => f.startsWith('"') ? f.slice(1, -1).replace(/""/g, '"') : f);

// csv text -> array of row objects keyed by header names (only `cols`).
function parseCsv(text, cols) {
  const lines = text.replace(/^﻿/, '').trim().split(/\r?\n/);
  const header = splitCsv(lines[0]);
  const idx = cols.map((c) => header.indexOf(c));
  return lines.slice(1).map((line) => {
    const f = splitCsv(line);
    const row = {};
    cols.forEach((c, i) => { row[c] = f[idx[i]]; });
    return row;
  });
}

// For each route, pick the most-used shape per direction from trips.txt and
// attach its geometry as route.paths = [[[lat, lon], ...], ...].
function attachShapes(network, zipBuf) {
  const files = unzip(zipBuf, ['trips.txt', 'shapes.txt']);

  const counts = new Map(); // "route|dir" -> Map(shape_id -> trip count)
  for (const t of parseCsv(files['trips.txt'], ['route_id', 'direction_id', 'shape_id'])) {
    if (!t.route_id || !t.shape_id || !network.routes[t.route_id]) continue;
    const key = `${t.route_id}|${t.direction_id}`;
    if (!counts.has(key)) counts.set(key, new Map());
    const m = counts.get(key);
    m.set(t.shape_id, (m.get(t.shape_id) || 0) + 1);
  }
  const routeShapes = new Map(); // route id -> Set(shape_id)
  for (const [key, m] of counts) {
    const route = key.split('|')[0];
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
    if (!routeShapes.has(route)) routeShapes.set(route, new Set());
    routeShapes.get(route).add(best);
  }

  const points = new Map(); // shape_id -> [[seq, lat, lon], ...]
  const wanted = new Set([...routeShapes.values()].flatMap((s) => [...s]));
  for (const p of parseCsv(files['shapes.txt'], ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) {
    if (!wanted.has(p.shape_id)) continue;
    if (!points.has(p.shape_id)) points.set(p.shape_id, []);
    points.get(p.shape_id).push([Number(p.shape_pt_sequence), Number(p.shape_pt_lat), Number(p.shape_pt_lon)]);
  }

  const round = (x) => Math.round(x * 1e5) / 1e5;
  for (const [route, shapeIds] of routeShapes) {
    network.routes[route].paths = [...shapeIds].map((id) =>
      simplify((points.get(id) || [])
        .sort((a, b) => a[0] - b[0])
        .map(([, lat, lon]) => [round(lat), round(lon)]))
    ).filter((p) => p.length > 1);
  }
}

// GTFS shapes carry survey-grade detail: 26k points over 135 routes, or a
// point every few metres. The map stops at zoom 16, where one pixel is about
// 2.4m, so anything Douglas-Peucker drops at a 2m tolerance was never going to
// be a visible bend — and the browser was reprojecting all of it on every pan,
// twice over (each line is drawn again as an invisible twin that takes clicks).
// Measured: 25,850 points -> 8,591, pan cost 11.3ms -> 5.7ms, and the network
// payload 834KB -> 448KB before compression.
const SIMPLIFY_M = 2;
const M_PER_DEG_LAT = 111320;
function simplify(pts, tolerance = SIMPLIFY_M) {
  if (pts.length < 3) return pts;
  // metres per degree of longitude shrinks with latitude; SF is close enough
  // to one value for the whole city that a constant beats a cosine per point
  const kx = M_PER_DEG_LAT * Math.cos((pts[0][0] * Math.PI) / 180);
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    const ax = pts[i][1] * kx, ay = pts[i][0] * M_PER_DEG_LAT;
    const dx = pts[j][1] * kx - ax, dy = pts[j][0] * M_PER_DEG_LAT - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let worst = 0, at = -1;
    for (let k = i + 1; k < j; k++) {
      // distance from the point to the chord, the usual cross-product form
      const d = Math.abs((pts[k][1] * kx - ax) * dy - (pts[k][0] * M_PER_DEG_LAT - ay) * dx) / len;
      if (d > worst) { worst = d; at = k; }
    }
    if (at > 0 && worst > tolerance) { keep[at] = true; stack.push([i, at], [at, j]); }
  }
  return pts.filter((_, k) => keep[k]);
}

// Lines, stops, and route geometry change rarely; cache them on disk for a
// day so restarts don't eat into the hourly request budget.
async function loadNetwork() {
  try {
    const c = JSON.parse(fs.readFileSync(NETWORK_CACHE, 'utf8'));
    // v3 = route shapes simplified on the way in (see simplify())
    if (c.v === 3 && Date.now() - c.at < 24 * 3600 * 1000) return c.network;
  } catch (e) {}
  console.log('Loading Muni network (lines, stops) from 511.org...');
  const [lineData, stopData] = await Promise.all([
    getJSON(api('lines', { operator_id: OPERATOR })),
    getJSON(api('stops', { operator_id: OPERATOR })),
  ]);
  const network = { routes: {}, stops: {} };
  for (const l of asArray(lineData)) network.routes[l.Id] = makeRoute(l.Id, l.Name, l.TransportMode);
  for (const s of asArray(stopData?.Contents?.dataObjects?.ScheduledStopPoint)) {
    const lat = Number(s.Location?.Latitude), lon = Number(s.Location?.Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      network.stops[s.id] = { id: s.id, name: s.Name, lat, lon };
    }
  }
  console.log('Loading Muni route shapes (GTFS)...');
  try {
    const res = await fetch(api('datafeeds', { operator_id: OPERATOR }));
    if (!res.ok) throw new Error(`511 API ${res.status} for datafeeds`);
    attachShapes(network, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    console.error('Route shapes unavailable (map lines will be missing):', err.message);
  }
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
    const data = await getJSON(api('VehicleMonitoring', { agency: OPERATOR }));
    vehicleCache.payload = {
      updated: new Date().toISOString(),
      vehicles: parseVehicles(data, network),
      quota,
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
    const data = await getJSON(api('StopMonitoring', { agency: OPERATOR, stopcode: stop }));
    payload = { updated: new Date().toISOString(), departures: parseStopVisits(data, network), error: null };
  } catch (err) {
    payload = { updated: null, departures: [], error: String(err) };
    console.error('Departures refresh failed:', err.message);
  }
  stopCaches.set(stop, { at: Date.now(), payload });
  return payload;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

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
  network = await loadNetwork();
  console.log(`Loaded ${Object.keys(network.routes).length} routes, ${Object.keys(network.stops).length} stops.`);
  server.listen(PORT, () => {
    console.log(`Refreshing live positions every ${REFRESH_SECONDS}s.`);
    console.log(`puny-muni running at http://localhost:${PORT}`);
  });
})();
