// GET /api/network — routes (with street geometry) and stops.
//
// The heavy endpoint: lines + stops + the GTFS zip for shapes. The CDN caches
// it for a day, a warm instance keeps it in memory, and /tmp survives across
// invocations on the same instance — so the three upstream requests happen
// about once a day, matching the local server's disk cache.
const fs = require('fs');
const { loadNetwork } = require('../lib/transit511.js');
const { KEY } = require('./_shared.js');

const TMP = '/tmp/puny-muni-network.json';
let mem = null;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (!mem) {
      try {
        const c = JSON.parse(fs.readFileSync(TMP, 'utf8'));
        if (Date.now() - c.at < 24 * 3600 * 1000) mem = c.network;
      } catch (e) {}
    }
    if (!mem) {
      mem = await loadNetwork(KEY);
      try { fs.writeFileSync(TMP, JSON.stringify({ at: Date.now(), network: mem })); } catch (e) {}
    }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
    res.status(200).json({
      routes: Object.values(mem.routes),
      stops: Object.values(mem.stops),
    });
  } catch (err) {
    res.status(503).json({ error: String(err) });
  }
};
