// GET /api/vehicles — current position of every Muni vehicle.
const { parseVehicles } = require('../docs/core.js');
const { OPERATOR, REFRESH_SECONDS, getJSON, getQuota } = require('../lib/transit511.js');
const { KEY, getRouteNetwork } = require('./_shared.js');

const REFRESH_MS = REFRESH_SECONDS * 1000;
let cache = { at: 0, payload: null };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!cache.payload || Date.now() - cache.at > REFRESH_MS) {
      const network = await getRouteNetwork();
      const data = await getJSON(KEY, 'VehicleMonitoring', { agency: OPERATOR });
      cache = {
        at: Date.now(),
        payload: { updated: new Date().toISOString(), vehicles: parseVehicles(data, network), quota: getQuota(), error: null },
      };
    }
    res.setHeader('Cache-Control', `s-maxage=${REFRESH_SECONDS}, stale-while-revalidate=600`);
    res.status(200).json(cache.payload);
  } catch (err) {
    res.status(200).json({ updated: null, vehicles: [], error: String(err) });
  }
};
