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
// per day on disk.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { asArray, makeRoute, parseVehicles, parseStopVisits } = require('./docs/core.js');

const API_KEY = process.env.TRANSIT_511_API_KEY;
const PORT = process.env.PORT || 8643;
const OPERATOR = 'SF'; // San Francisco Muni's 511 operator id
const REFRESH_MS = 65_000;
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

async function getJSON(url) {
  const res = await fetch(url);
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
      (points.get(id) || [])
        .sort((a, b) => a[0] - b[0])
        .map(([, lat, lon]) => [round(lat), round(lon)])
    ).filter((p) => p.length > 1);
  }
}

// Lines, stops, and route geometry change rarely; cache them on disk for a
// day so restarts don't eat into the hourly request budget.
async function loadNetwork() {
  try {
    const c = JSON.parse(fs.readFileSync(NETWORK_CACHE, 'utf8'));
    if (c.v === 2 && Date.now() - c.at < 24 * 3600 * 1000) return c.network;
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
  fs.writeFileSync(NETWORK_CACHE, JSON.stringify({ at: Date.now(), v: 2, network }));
  return network;
}

let network = null;

let vehicleCache = { at: 0, payload: { updated: null, vehicles: [], error: null } };
async function getVehicles() {
  if (Date.now() - vehicleCache.at < REFRESH_MS) return vehicleCache.payload;
  vehicleCache.at = Date.now(); // on failure too — wait a full cycle before retrying
  try {
    const data = await getJSON(api('VehicleMonitoring', { agency: OPERATOR }));
    vehicleCache.payload = {
      updated: new Date().toISOString(),
      vehicles: parseVehicles(data, network),
      error: null,
    };
  } catch (err) {
    vehicleCache.payload = { ...vehicleCache.payload, error: String(err) };
    console.error('Vehicle refresh failed:', err.message);
  }
  return vehicleCache.payload;
}

const stopCaches = new Map(); // stop id -> { at, payload }
async function getDepartures(stop) {
  const c = stopCaches.get(stop);
  if (c && Date.now() - c.at < REFRESH_MS) return c.payload;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };

  if (url.pathname === '/api/vehicles') return send(200, JSON.stringify(await getVehicles()));
  if (url.pathname === '/api/departures') {
    const stop = url.searchParams.get('stop');
    if (!stop || !network.stops[stop]) return send(400, '{"error":"unknown stop"}');
    return send(200, JSON.stringify(await getDepartures(stop)));
  }
  if (url.pathname === '/api/network') {
    return send(200, JSON.stringify({
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
  server.listen(PORT, () => console.log(`puny-muni running at http://localhost:${PORT}`));
})();
