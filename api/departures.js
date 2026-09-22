// GET /api/departures?stop=<id> — upcoming arrivals at a stop.
const { parseStopVisits } = require('../docs/core.js');
const { OPERATOR, REFRESH_SECONDS, getJSON } = require('../lib/transit511.js');
const { KEY, getRouteNetwork, claimForce } = require('./_shared.js');

const REFRESH_MS = REFRESH_SECONDS * 1000;
const stopCaches = new Map(); // stop id -> { at, payload }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const stop = String(req.query.stop || '');
  // Unlike the local server there is no stop list here to validate against;
  // 511 just returns no visits for an unknown stop.
  if (!/^\w{1,16}$/.test(stop)) return res.status(400).json({ error: 'unknown stop' });
  // ?fresh=1 is the manual refresh asking to skip the cache; claimForce() decides
  const force = String(req.query.fresh || '') === '1';
  try {
    const c = stopCaches.get(stop);
    const cached = c && Date.now() - c.at < REFRESH_MS;
    if (!cached || (force && claimForce())) {
      const network = await getRouteNetwork();
      const data = await getJSON(KEY, 'StopMonitoring', { agency: OPERATOR, stopcode: stop });
      stopCaches.set(stop, {
        at: Date.now(),
        payload: { updated: new Date().toISOString(), departures: parseStopVisits(data, network), error: null },
      });
    }
    // fresh responses cache only for the ration window, so the next click can land
    res.setHeader('Cache-Control', force ? 's-maxage=10' : `s-maxage=${REFRESH_SECONDS}, stale-while-revalidate=600`);
    res.status(200).json(stopCaches.get(stop).payload);
  } catch (err) {
    res.status(200).json({ updated: null, departures: [], error: String(err) });
  }
};
