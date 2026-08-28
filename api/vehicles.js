// GET /api/vehicles — current position of every Muni vehicle.
const { parseVehicles } = require('../docs/core.js');
const { OPERATOR, getJSON } = require('../lib/transit511.js');
const { KEY, getRouteNetwork } = require('./_shared.js');

const REFRESH_MS = 65_000;
let cache = { at: 0, payload: null };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!cache.payload || Date.now() - cache.at > REFRESH_MS) {
      const network = await getRouteNetwork();
      const data = await getJSON(KEY, 'VehicleMonitoring', { agency: OPERATOR });
      cache = {
        at: Date.now(),
        payload: { updated: new Date().toISOString(), vehicles: parseVehicles(data, network), error: null },
      };
    }
    res.setHeader('Cache-Control', 's-maxage=65, stale-while-revalidate=600');
    res.status(200).json(cache.payload);
  } catch (err) {
    res.status(200).json({ updated: null, vehicles: [], error: String(err) });
  }
};
