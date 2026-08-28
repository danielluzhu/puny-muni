// GET /api/departures?stop=<id> — upcoming arrivals at a stop.
const { parseStopVisits } = require('../docs/core.js');
const { OPERATOR, getJSON } = require('../lib/transit511.js');
const { KEY, getRouteNetwork } = require('./_shared.js');

const REFRESH_MS = 65_000;
const stopCaches = new Map(); // stop id -> { at, payload }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const stop = String(req.query.stop || '');
  // Unlike the local server there is no stop list here to validate against;
  // 511 just returns no visits for an unknown stop.
  if (!/^\w{1,16}$/.test(stop)) return res.status(400).json({ error: 'unknown stop' });
  try {
    const c = stopCaches.get(stop);
    if (!c || Date.now() - c.at > REFRESH_MS) {
      const network = await getRouteNetwork();
      const data = await getJSON(KEY, 'StopMonitoring', { agency: OPERATOR, stopcode: stop });
      stopCaches.set(stop, {
        at: Date.now(),
        payload: { updated: new Date().toISOString(), departures: parseStopVisits(data, network), error: null },
      });
    }
    res.setHeader('Cache-Control', 's-maxage=65, stale-while-revalidate=600');
    res.status(200).json(stopCaches.get(stop).payload);
  } catch (err) {
    res.status(200).json({ updated: null, departures: [], error: String(err) });
  }
};
