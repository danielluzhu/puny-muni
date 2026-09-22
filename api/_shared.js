// Shared bits for the Vercel serverless functions. Underscore-prefixed files
// in api/ are modules, not endpoints.
//
// Caching on Vercel works differently from the local server: a warm function
// instance keeps module-level state between invocations (the same 65 s
// in-memory caches server.js uses), and on top of that each endpoint sets
// s-maxage so Vercel's CDN serves repeat requests without invoking the
// function at all. Together they keep the 511 key inside its 60 req/hour
// budget no matter how many people are watching.

const { loadRoutes, getQuota } = require('../lib/transit511.js');

const KEY = process.env.TRANSIT_511_API_KEY;

// A manual refresh (?fresh=1) is allowed to skip the in-memory caches, but
// not to drain the hourly budget: one forced 511 call every FORCE_MIN_MS per
// warm instance at most, and none once the budget is down to the last few
// calls the automatic cadence still needs. The CDN shields the origin too —
// a fresh response is cached briefly (see the endpoints), so a crowd clicking
// refresh together still costs one function invocation per ration window.
const FORCE_MIN_MS = 10_000;
let lastForced = 0;
function claimForce() {
  if (Date.now() - lastForced < FORCE_MIN_MS) return false;
  const quota = getQuota();
  if (quota.remaining != null && quota.remaining <= 3) return false;
  lastForced = Date.now();
  return true;
}

let routesAt = 0;
let routesNetwork = null; // { routes } — enough for parseVehicles/parseStopVisits
async function getRouteNetwork() {
  if (!routesNetwork || Date.now() - routesAt > 24 * 3600 * 1000) {
    routesNetwork = { routes: await loadRoutes(KEY) };
    routesAt = Date.now();
  }
  return routesNetwork;
}

module.exports = { KEY, getRouteNetwork, claimForce };
