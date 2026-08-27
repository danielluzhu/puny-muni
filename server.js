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

// Lines and stops change rarely; cache them on disk for a day so restarts
// don't eat into the hourly request budget.
async function loadNetwork() {
  try {
    const c = JSON.parse(fs.readFileSync(NETWORK_CACHE, 'utf8'));
    if (Date.now() - c.at < 24 * 3600 * 1000) return c.network;
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
  fs.writeFileSync(NETWORK_CACHE, JSON.stringify({ at: Date.now(), network }));
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
