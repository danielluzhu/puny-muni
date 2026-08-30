// Shared 511.org access — fetching, GTFS shape extraction, and network
// assembly. Used by both the local server (server.js) and the Vercel
// serverless functions (api/*). Route/vehicle parsing lives in docs/core.js.

const zlib = require('zlib');
const { asArray, makeRoute } = require('../docs/core.js');

const OPERATOR = 'SF'; // San Francisco Muni's 511 operator id

// How often live positions and predictions are re-fetched. 65s is the default
// because a free 511 key allows 60 requests an hour and the map spends one per
// cycle; if you've been granted a higher limit, set REFRESH_SECONDS lower.
const REFRESH_SECONDS = Math.min(3600, Math.max(5, Number(process.env.REFRESH_SECONDS) || 65));

const apiUrl = (key, endpoint, params) =>
  `https://api.511.org/transit/${endpoint}?` +
  new URLSearchParams({ api_key: key, format: 'json', ...params });

// 511 reports the hourly budget on every response; keep the latest so the
// browser can show how much of it is left. This is the number that decides how
// fast the map can possibly refresh.
let quota = { limit: null, remaining: null };
const getQuota = () => quota;

function noteQuota(res) {
  const limit = Number(res.headers.get('ratelimit-limit'));
  const remaining = Number(res.headers.get('ratelimit-remaining'));
  if (Number.isFinite(limit) && limit > 0) {
    quota = { limit, remaining: Number.isFinite(remaining) ? remaining : null };
  }
}

async function getJSON(key, endpoint, params) {
  const res = await fetch(apiUrl(key, endpoint, params));
  noteQuota(res);
  if (!res.ok) throw new Error(`511 API ${res.status} for ${endpoint}`);
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
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
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

// ---- loaders -------------------------------------------------------------

async function loadRoutes(key) {
  const lineData = await getJSON(key, 'lines', { operator_id: OPERATOR });
  const routes = {};
  for (const l of asArray(lineData)) routes[l.Id] = makeRoute(l.Id, l.Name, l.TransportMode);
  return routes;
}

async function loadStops(key) {
  const stopData = await getJSON(key, 'stops', { operator_id: OPERATOR });
  const stops = {};
  for (const s of asArray(stopData?.Contents?.dataObjects?.ScheduledStopPoint)) {
    const lat = Number(s.Location?.Latitude), lon = Number(s.Location?.Longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      stops[s.id] = { id: s.id, name: s.Name, lat, lon };
    }
  }
  return stops;
}

// The full network: routes, stops, and route geometry (unless it fails —
// the map just loses its lines then, everything else still works).
async function loadNetwork(key, log = () => {}) {
  log('Loading Muni network (lines, stops) from 511.org...');
  const [routes, stops] = await Promise.all([loadRoutes(key), loadStops(key)]);
  const network = { routes, stops };
  log('Loading Muni route shapes (GTFS)...');
  try {
    const res = await fetch(apiUrl(key, 'datafeeds', { operator_id: OPERATOR }));
    noteQuota(res);
    if (!res.ok) throw new Error(`511 API ${res.status} for datafeeds`);
    attachShapes(network, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    log('Route shapes unavailable (map lines will be missing): ' + err.message);
  }
  return network;
}

module.exports = { OPERATOR, REFRESH_SECONDS, getJSON, getQuota, loadRoutes, loadNetwork };
