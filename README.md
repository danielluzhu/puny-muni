# puny-muni 🚋💨

A live map of every Muni vehicle in San Francisco — Metro trains, buses,
historic streetcars, and cable cars. A port of
[bart-fart](https://github.com/danielluzhu/bart-fart) from BART to Muni.

**Site: https://danielluzhu.github.io/puny-muni/** (a landing page — the
tracker itself needs an API key, so it runs locally; see below)

Four interfaces, switchable from the header (your choice is remembered):

- **NEON** — dark mission-control map with glowing vehicles
- **DAY** — the same map on a light basemap
- **PONY** — every vehicle is a pony in its line's colour, trotting the way
  it's actually heading
- **DEPARTURES** — a vintage split-flap board (pick any stop in the system,
  watch the flaps clatter as ETAs change)

The locate button on the map frames the stops nearest you, and each one
opens its own departures board.

## Run it

Muni's real-time data comes from the [511.org API](https://511.org/open-data),
which requires a free API key — get one at https://511.org/open-data/token.
Then:

```
TRANSIT_511_API_KEY=yourkey npm start
```

which serves the site at http://localhost:8643. No dependencies — just Node 18+.

Unlike bart-fart, the local server is **required** (there is no static
GitHub Pages version): 511.org blocks cross-origin browser requests, and the
key shouldn't be shipped to browsers anyway, so the server proxies and caches
everything and exposes it as a JSON API.

## How it works

Where bart-fart had to *estimate* train positions from departure countdowns,
Muni just tells you: 511.org's SIRI VehicleMonitoring feed carries the actual
GPS position (and bearing, destination, next stop, and occupancy) of every
vehicle in the system. So there is no estimation logic here — the server:

1. **At startup** loads the route list, all ~3,500 stops, and every route's
   street geometry — from the GTFS feed's `shapes.txt`, since the real-time
   API has no shapes endpoint (all cached on disk for a day). The route lines
   are drawn under the vehicles on the map: rail bright, buses as faint
   threads.
2. **On demand** fetches real-time vehicle positions (for the map) or
   stop predictions (for the departures board), each cached for 65 seconds.
3. The browser polls the local API and glides each vehicle marker to its new
   position, keyed by vehicle id.

Everything is fetched lazily and cached because default 511 keys are
rate-limited to **60 requests/hour** — hence the 65-second refresh (BART
allowed 15). Only the visible view fetches: the map view polls vehicles, the
departures view polls the selected stop. The wheel in the header drains over
one refresh interval, so you can see when the next positions are due.

You can ask 511 for a higher limit; if you get one, set `REFRESH_SECONDS` to
match and both server and browser follow it:

```
TRANSIT_511_API_KEY=yourkey REFRESH_SECONDS=20 npm start
```

Muni Metro, historic, and cable car lines get their brand-ish colors; bus
routes get a stable generated hue. The SIRI parsing and styling live in
[`docs/core.js`](docs/core.js), shared with the server.

## API (local server)

- `GET /api/vehicles` — current position of every vehicle: route, category
  (metro / historic / cable car / bus), color, destination, direction,
  coordinates, bearing, occupancy, next stop and minutes to it.
- `GET /api/network` — routes and stops (with coordinates).
- `GET /api/departures?stop=<id>` — upcoming arrivals at a stop: route,
  destination, direction, minutes.

Data: [511.org Open Data](https://511.org/open-data) (SIRI VehicleMonitoring
and StopMonitoring for operator `SF`). Set `TRANSIT_511_API_KEY` to your key.
