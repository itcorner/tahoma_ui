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
| `PUID`                  | Container application UID (Docker only)                                        | `1000` |
| `PGID`                  | Container application GID (Docker only)                                        | `1000` |
| `TAHOMA_BASE_URL`       | Base URL of the gateway's local API, e.g. `https://gateway-<pin>.local:8443/enduser-mobile-web/1/enduserAPI` | — |
| `TAHOMA_BEARER_TOKEN`   | Developer Mode token generated for the gateway                                | —       |
| `TAHOMA_UI_HOSTNAME`    | UI hostname for Traefik's Host routing rule (required with `docker-compose-traefik.yml`), e.g. `tahoma.example.com`; no scheme or port | — |

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

To use a different port, pass it after the npm command (or set `PORT`):

```bash
npm start -- --port 4000
```

## Running with Docker

### Build and run directly

```bash
docker build -t tahoma-ui:local .
PORT=3000
docker run -d \
  --name tahoma-ui \
  --env-file .env \
  -e PORT="$PORT" \
  -p "$PORT:$PORT" \
  --mount type=bind,source="$(pwd)/data",target=/app/data \
  tahoma-ui:local
```

For this direct Docker example, change the shell variable `PORT` to the desired
port. It overrides `.env`'s `PORT` so the application and published port agree.

### Docker Compose

```bash
docker compose up -d --build
```

`docker-compose.yml` loads variables from `.env` via `env_file`.
Both Compose files use `PORT` from `.env` (default `3000`) for the application
and routing: the regular Compose file publishes the same host/container port,
and the Traefik file routes to that container port. A shell override such as
`PORT=4000 docker compose up -d --build` takes precedence for both.
The Docker health check also follows the application's `PORT`. `EXPOSE 3000`
in the image documents the default only; it does not restrict custom ports.

Both examples bind-mount the local `data/` directory at `/app/data` inside
the container, preserving the existing `data/tahoma.sqlite` database across
redeployments. The `data/` directory must already exist (`mkdir -p data` for
a new installation). If `data/tahoma.sqlite` is missing, startup creates a new
database as the application user, and the application initializes its telemetry
schema. To retain previous history, restore your database before starting.
Compose requires the source directory to exist rather than silently creating
an empty directory.

At startup, the container checks database, directory, and SQLite sidecar
permissions as the application user. If necessary, it attempts to repair
ownership and owner permissions, then verifies that SQLite can open a write
transaction. This brief startup step runs as root and may change ownership of
the bind-mounted directory and database files to the application UID/GID. The
application itself runs without root, using `node`'s IDs (`1000:1000`) by default.

Set `PUID` and/or `PGID` in `.env` to use your host user's IDs, for example:

```dotenv
PUID=1001
PGID=1001
```

Find your host IDs with `id -u` and `id -g`. Both Compose files and the direct
Docker example load these overrides through `--env-file`/`env_file`. Each ID
must be a decimal integer from 1 to 2147483647 without leading zeros; root IDs
are not supported. Custom IDs need not exist as named users/groups in the image.
Overrides apply to database creation, permission checks/repairs, and the
application process.

When using Docker's `--user` override, checks and repairs run as that user
instead and cannot repair ownership. Omitted `PUID`/`PGID` then default to the
current user's IDs; explicit overrides must match them or startup fails.

A failed database creation or an unsuccessful repair/check exits the container
with a nonzero status and an error in the logs. Compose's `restart: unless-stopped`
policy may retry startup until the underlying problem is fixed.

To validate the container startup checks in isolation (requires Docker):

```bash
docker build -t tahoma-ui:db-startup-check .
node --test test/docker-entrypoint.test.js
```

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
