# home-automator

> [!WARNING]
> Personal home automation project. Made for a specific house; it will not work for others.

MQTT automation service with a REST API, web UI, and Prometheus metrics.

## Run

```sh
uv sync
uv run python -m automator
```

Defaults: `DATA_DIR=./data`, `MQTT_URL=mosquitto`, `PORT=80`. Set `DRY_RUN=true` to disable
writes. Set `TZ`, `LAT`, and `LON` for local and solar schedules.

To initialize data from the checked-in seed:

```sh
uv run python seed/install.py data
```

## Checks

```sh
uv run pytest -q
```

## Deployment

Build and deploy from `infra/` with `docker/build.sh homeautomator`. Runtime config and state
are stored in `DATA_DIR` as JSON files.

See [seed/README.md](seed/README.md) for regenerating device definitions.
