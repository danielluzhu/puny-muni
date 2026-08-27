// puny-muni core — 511.org SIRI parsing and route styling.
// Muni (via 511.org) publishes real GPS positions for every vehicle, so unlike
// bart-fart there is no position estimation here — just turning SIRI responses
// into plain objects. Required by server.js; UMD-wrapped so the browser could
// share it too.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MuniCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

  // Muni Metro / historic / cable car brand-ish colors. Buses get a
  // deterministic hue from their route id instead.
  const RAIL_COLORS = {
    J: '#F5A31C', K: '#3AA5A8', L: '#92278F', M: '#008752', N: '#005B95',
    T: '#BF245E', S: '#FFD21E',
    F: '#7C9A3F', E: '#8A9A5B',
    CA: '#8D5B2D', PM: '#A0693A', PH: '#75482F',
  };

  function classify(id, mode) {
    if (mode === 'cableway' || ['CA', 'PM', 'PH'].includes(id)) return 'CABLE CAR';
    if (['F', 'E'].includes(id)) return 'HISTORIC';
    if (mode === 'tram' || mode === 'metro' || RAIL_COLORS[id]) return 'METRO';
    return 'BUS';
  }

  function colorFor(id, mode) {
    if (RAIL_COLORS[id]) return RAIL_COLORS[id];
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${Math.round(h * 137.508) % 360} 65% 55%)`;
  }

  const makeRoute = (id, name, mode) => ({
    id, name, mode,
    category: classify(id, mode),
    color: colorFor(id, mode),
  });

  // A journey's LineRef may name a route the lines endpoint didn't list
  // (special services); synthesize a route entry so it still renders.
  function routeFor(network, id) {
    if (!id) return null;
    if (!network.routes[id]) network.routes[id] = makeRoute(id, id, null);
    return network.routes[id];
  }

  const minutesUntil = (iso) =>
    iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000)) : null;

  const DIRECTIONS = { IB: 'Inbound', OB: 'Outbound' };

  // SIRI VehicleMonitoring -> [{id, route, ...}], one entry per live vehicle.
  function parseVehicles(siri, network) {
    const vehicles = [];
    for (const delivery of asArray(siri?.Siri?.ServiceDelivery?.VehicleMonitoringDelivery)) {
      for (const va of asArray(delivery.VehicleActivity)) {
        const j = va.MonitoredVehicleJourney || {};
        const lat = Number(j.VehicleLocation?.Latitude);
        const lon = Number(j.VehicleLocation?.Longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        // Skip vehicles that stopped reporting (they linger in the feed).
        const age = Date.now() - Date.parse(va.RecordedAtTime || 0);
        if (!(age < 10 * 60 * 1000)) continue;
        const route = routeFor(network, j.LineRef);
        if (!route) continue;
        const bearing = Number(j.Bearing);
        vehicles.push({
          id: j.VehicleRef || `${route.id}-${vehicles.length}`,
          route: route.id,
          routeName: route.name,
          category: route.category,
          color: route.color,
          direction: DIRECTIONS[j.DirectionRef] || j.DirectionRef || null,
          destination: j.DestinationName || route.name,
          lat, lon,
          bearing: Number.isFinite(bearing) ? Math.round(bearing) : null,
          occupancy: j.Occupancy || null,
          nextStop: j.MonitoredCall?.StopPointName || null,
          minutesToNext: minutesUntil(j.MonitoredCall?.ExpectedArrivalTime),
        });
      }
    }
    return vehicles;
  }

  // SIRI StopMonitoring -> [{route, dest, dir, mins, color}], soonest first.
  function parseStopVisits(siri, network) {
    const rows = [];
    for (const delivery of asArray(siri?.Siri?.ServiceDelivery?.StopMonitoringDelivery)) {
      for (const visit of asArray(delivery.MonitoredStopVisit)) {
        const j = visit.MonitoredVehicleJourney || {};
        const call = j.MonitoredCall || {};
        const mins = minutesUntil(call.ExpectedArrivalTime || call.AimedArrivalTime);
        if (mins == null) continue;
        const route = routeFor(network, j.LineRef);
        if (!route) continue;
        rows.push({
          route: route.id,
          dest: String(j.DestinationName || route.name),
          dir: DIRECTIONS[j.DirectionRef] || null,
          mins,
          color: route.color,
        });
      }
    }
    return rows.sort((a, b) => a.mins - b.mins);
  }

  return { asArray, classify, colorFor, makeRoute, parseVehicles, parseStopVisits };
});
