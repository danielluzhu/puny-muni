// Shared bits for the Vercel serverless functions. Underscore-prefixed files
// in api/ are modules, not endpoints.
//
// Caching on Vercel works differently from the local server: a warm function
// instance keeps module-level state between invocations (the same 65 s
// in-memory caches server.js uses), and on top of that each endpoint sets
// s-maxage so Vercel's CDN serves repeat requests without invoking the
// function at all. Together they keep the 511 key inside its 60 req/hour
// budget no matter how many people are watching.

const { loadRoutes } = require('../lib/transit511.js');

const KEY = process.env.TRANSIT_511_API_KEY;

let routesAt = 0;
let routesNetwork = null; // { routes } — enough for parseVehicles/parseStopVisits
async function getRouteNetwork() {
  if (!routesNetwork || Date.now() - routesAt > 24 * 3600 * 1000) {
    routesNetwork = { routes: await loadRoutes(KEY) };
    routesAt = Date.now();
  }
  return routesNetwork;
}

module.exports = { KEY, getRouteNetwork };
