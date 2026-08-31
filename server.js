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
// geometry) once per day on disk.

const http = require('http');
const fs = require('fs');
const path = require('path');
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
    if (c.v === 2 && Date.now() - c.at < 24 * 3600 * 1000) return c.network;
  } catch (e) {}
  const network = await loadNetwork(API_KEY, console.log);
  fs.writeFileSync(NETWORK_CACHE, JSON.stringify({ at: Date.now(), v: 2, network }));
  return network;
}

let network = null;

let vehicleCache = { at: 0, payload: { updated: null, vehicles: [], error: null } };
async function getVehicles() {
  if (Date.now() - vehicleCache.at < REFRESH_MS) return vehicleCache.payload;
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
async function getDepartures(stop) {
  const c = stopCaches.get(stop);
  if (c && Date.now() - c.at < REFRESH_MS) return c.payload;
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
