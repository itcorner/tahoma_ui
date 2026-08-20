# Tahoma UI

A lightweight local web app for controlling and monitoring Somfy TaHoma roller
blinds through the gateway's local API. It provides a live overview, manual
controls, and minute-by-minute telemetry history (RSSI, closure state, target
closure, moving state, etc.) charted over time.

## Features

- Discovers roller blind / cover devices from the TaHoma gateway
- Live overview with status, RSSI signal, position, and moving state
- Open / stop / close / set-position controls per device
- Automatic telemetry collection every 60 seconds into a local SQLite database
- Time-series charts (RSSI level, closure state, target closure state)
  clustered per metric across all devices, with **last hour / today / last
  week / last month** ranges
- Docker image and Compose file for containerized deployment

## Architecture

```
public/            Static frontend (HTML/CSS/vanilla JS), served by Express
src/server.js       Express app, REST API, minute-interval telemetry collector
src/tahomaClient.js Axios client for the TaHoma local API (devices, states, actions)
src/historyStore.js SQLite-backed telemetry history (via the sqlite3 CLI)
data/               Runtime SQLite database (tahoma.sqlite), git-ignored
```

## Requirements

- Node.js 22+
- `sqlite3` CLI available on `PATH` (used by `src/historyStore.js`)
- A Somfy TaHoma (or compatible Overkiz) gateway reachable on the local
  network with local API / Developer Mode enabled

## Configuration

Copy the example environment file and fill in your gateway details:

```bash
cp .env.example .env
```

| Variable               | Description                                                                 | Default |
|-------------------------|-------------------------------------------------------------------------------|---------|
| `PORT`                  | Port the app listens on                                                       | `3000`  |
| `TAHOMA_BASE_URL`       | Base URL of the gateway's local API, e.g. `https://gateway-<pin>.local:8443/enduser-mobile-web/1/enduserAPI` | — |
| `TAHOMA_BEARER_TOKEN`   | Developer Mode token generated for the gateway                                | —       |

### Finding your gateway

The gateway advertises itself via mDNS as `_kizboxdev._tcp.local`. On macOS
you can discover it with:

```bash
dns-sd -B _kizboxdev._tcp local
dns-sd -L '<gateway-name>' _kizboxdev._tcp local
```

This returns the gateway's hostname (`gateway-<pin>.local`), port (`8443`), API
version, and firmware version. Generate a Developer Mode token following
[Somfy's instructions](https://github.com/Somfy-Developer/Somfy-TaHoma-Developer-Mode).

## Running locally

```bash
npm install
npm start
```

The app listens on `http://localhost:3000` and starts collecting telemetry
into `data/tahoma.sqlite` immediately, then every 60 seconds.

## Running with Docker

### Build and run directly

```bash
docker build -t tahoma-ui:local .
docker run -d \
  --name tahoma-ui \
  --env-file .env \
  -p 3000:3000 \
  -v tahoma-data:/app/data \
  tahoma-ui:local
```

### Docker Compose

```bash
docker compose up -d --build
```

`docker-compose.yml` loads variables from `.env` (via `env_file`) and also
defines `TAHOMA_BASE_URL` / `TAHOMA_BEARER_TOKEN` directly under
`environment:` — the `environment:` values take precedence, so you can either
edit `.env`, edit the compose file, or override at the command line
(`TAHOMA_BEARER_TOKEN=... docker compose up`).

Telemetry data persists in the named volume `tahoma-data`, mounted at
`/app/data` inside the container.

## API reference

| Method | Path                     | Description                                             |
|--------|--------------------------|-----------------------------------------------------------|
| GET    | `/health`                | Basic liveness check                                      |
| GET    | `/api/version`           | TaHoma gateway API version                                 |
| GET    | `/api/blinds`            | List blind devices with their current states               |
| POST   | `/api/blinds/command`    | Send a command (`open`, `close`, `stop`, `setPosition`) to a device |
| GET    | `/api/history`           | Telemetry history; `?range=hour\|today\|week\|month` and optional `?deviceURL=` |

### `POST /api/blinds/command` body

```json
{ "deviceURL": "io://...", "command": "setPosition", "value": 50 }
```

### `GET /api/history` response

```json
{
  "range": "today",
  "points": [
    {
      "device_url": "io://...",
      "label": "Living Room",
      "sampled_at": 1755600000,
      "rssi_level": 92,
      "closure_state": 20,
      "target_closure_state": 20
    }
  ]
}
```

## Telemetry history

Every 60 seconds, `src/server.js` polls all discovered blind devices and
records the following fields per device into `blind_samples`:

- RSSI level and discrete RSSI level
- Status
- Slat orientation
- Closure state
- Open/closed state
- Target closure state
- Moving state

The frontend charts group by metric (not by device), so a single RSSI chart
shows every device's RSSI over time, a single closure-state chart shows every
device's position, etc.

## Project scripts

| Script        | Description                     |
|---------------|----------------------------------|
| `npm start`   | Start the server                |
| `npm run dev` | Same as `start` (no watch mode) |
| `npm test`    | Placeholder — no tests yet      |

## Notes and limitations

- The local API does not support scenarios or climate entities; this app
  focuses on cover/blind devices.
- `sqlite3` must be installed on the host (or included in the container
  image, as done in the provided `Dockerfile`) since history storage shells
  out to the CLI rather than using a native binding.
- For a broader smart-home integration (sensors, automations, other device
  types), consider using Home Assistant's official
  [Overkiz integration](https://www.home-assistant.io/integrations/overkiz/)
  alongside or instead of this app.
