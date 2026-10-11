# Metrics scraper for home automation

⚠️ Note: This project is meant for personal use, and is not guaranteed to work for anyone else.

## Description

This project scrapes data from various sources and stores it in [VictoriaMetrics](https://victoriametrics.com/) time series database.
The data is then used to generate graphs.

Supported sources:

- [Shelly 3EM](https://kb.shelly.cloud/knowledge-base/shelly-3em) and [Shelly Plus 1PM](https://kb.shelly.cloud/knowledge-base/shelly-plus-1pm) for energy consumption data.
- [go-e Gemini Charger](https://go-e.com/en/products/go-e-charger-gemini) for car charging data.
- [MyŠkoda Public API](https://public.api.connect.skoda-auto.cz/docs) for car odometer, battery, range, charging and integration health data.
- [spot-hinta.fi](https://spot-hinta.fi/) for electricity price.
- Zigbee and Z-Wave sensors via MQTT broker for temperature and humidity data, among others, using [Z-Wave JS UI](https://github.com/zwave-js/zwave-js-ui) and [Zigbee2MQTT](https://github.com/Koenkk/zigbee2mqtt).
- [Melcloud](https://www.melcloud.com/) for heat pump data.

## Development

Install dependencies with:

```bash
uv sync
```

Execute the application:

```bash
uv run python -m homemetrics --config config.yaml
```

Run the test web server to see the metrics being pushed to it in Prometheus exposition format:

```bash
uv run python tests/httpserver.py
```

Build the container image:

```bash
# In the cluster (loads image into containerd and restarts deployment):
../infra/docker/build.sh homemetrics

# Or manual local build:
podman build -t quay.io/tsaarni/home-metrics:latest -f ../infra/docker/homemetrics/Dockerfile .
```

The documentation for used APIs is available at following links:

- [Shelly 1st gen REST API](https://shelly-api-docs.shelly.cloud/gen1/#shelly-family-overview) for Shelly 3EM [status](https://shelly-api-docs.shelly.cloud/gen1/#shelly-3em-status).
- [Shelly 2nd gen JSON RPC API](https://shelly-api-docs.shelly.cloud/gen2/) for Shelly Plus 1PM [status](https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/Switch#status).
- [go-e charger REST API](https://github.com/goecharger/go-eCharger-API-v2/blob/main/introduction-en.md)
- [MyŠkoda Public API contract](https://public.api.connect.skoda-auto.cz/docs/myskoda-public-api.yaml) (version 1.1.0, checked 2026-10-11).
- [spot-hinta.fi REST API](https://spot-hinta.fi/) for electricity price.
- VictoriaMetrics [API for importing](https://docs.victoriametrics.com/url-examples.html#apiv1importprometheus) time series data in Prometheus exposition format.
- Specification of [Prometheus datatypes](https://github.com/prometheus/docs/blob/main/content/docs/concepts/metric_types.md) and [Prometheus exposition format](https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md).
- [Z-Wave JS UI MQTT](https://zwave-js.github.io/zwave-js-ui/#/guide/mqtt) and Z-Wave [command classes](https://z-wave.me/manual/z-way/Command_Class_Reference.html#).

## Škoda configuration and migration

Create an API key in the [MyŠkoda app](https://go.skoda.eu/api-keys), authorizing
access to your vehicle. Set `api_key` and `vin` in the `skoda` sensor configuration;
`database_url` can remain in the global configuration. Keep keys out of version
control. Replace `username` and `password` and remove `poll-schedule`: these
legacy settings are rejected with migration messages. Only vehicle reads are used.

```yaml
- type: skoda
  config:
    api_key: your-api-key
    vin: your-vehicle-vin
    poll-period-disconnected: 2h
    poll-period-connected: 30m
    poll-period-charging: 10m
```

Intervals must be positive; these are the defaults. The first request is immediate.
Active charging polls every 10 minutes, explicit disconnection every 2 hours,
and connected or unknown status every 30 minutes. `CONNECT_CABLE` is a
disconnected fallback when the plug field is absent or unknown. Contradictory
CHARGING/DISCONNECTED or CONNECT_CABLE/CONNECTED combinations use 10 minutes
and are logged. Future charging states follow the plug rules. Polling is
independent of other modules: charging discovery can take approximately two
hours, and short sessions may be missed.

After an observed stop, missing battery/range or an absent or unchanged charging
capture timestamp causes one follow-up after the charging interval. The next
API attempt consumes it even if it fails. This is best effort and does not
guarantee a final battery reading. Missing state while connected does not by
itself establish a stop.

Quota headers and `Retry-After` defer requests. API failures back off for 1, 2, 4,
8, 16, then 30 minutes; a valid vehicle response resets backoff. Deadlines survive
coroutine restarts within the same process, not process restarts. A 401/403
suspends this sensor until you correct the authorized key and restart the
application; other sensors keep running. Key expiry is logged and exported.

Database POSTs have a 30-second timeout and retry the identical payload after
5 and then 15 seconds. After three failures the payload is discarded; samples
can be lost. There is no delivery queue. Database failures do not cause extra
vehicle requests or change polling decisions. Poll deadlines are measured from
the API fetch, before database retries.

## Škoda metrics

Every series has `sensor="car"`. `odometer_km` remains a counter; all other metrics
are gauges. Available zero values are retained; absent values and unknown boolean
enums are omitted. Partial HTTP 200 vehicle responses are successful fetches.
Odometry uses its own capture time, and charging readings use the charging
capture time. Missing capture times fall back to fetch time without fabricating a
vehicle capture timestamp.

| Metric | Unit or meaning |
| --- | --- |
| `odometer_km` | Mileage, km (counter) |
| `battery_percentage` | Battery state of charge, % |
| `range_km` | Remaining cruising range, km |
| `charging_power_w` | Charging power, W |
| `charging_remaining_seconds` | Time to full charge, seconds |
| `charging_target_percentage` | Target charge, % |
| `charging_state{state="…"}` | One-hot charging state, sampled at fetch time |
| `skoda_charging_state_available` | Non-empty state in latest response=1; otherwise 0 |
| `charging_plug_connected` | CONNECTED=1, DISCONNECTED=0 |
| `charging_plug_locked` | LOCKED=1, UNLOCKED=0 |
| `battery_care_enabled` | ACTIVATED=1, DEACTIVATED=0 |
| `skoda_vehicle_captured_timestamp_seconds{section="…"}` | Available capture time, Unix seconds; sections `odometer` and `charging` |
| `skoda_last_successful_fetch_timestamp_seconds` | Successful response time, Unix seconds, including partial or empty data |
| `skoda_fetch_success` | Valid HTTP 200 vehicle response=1; failure=0 |
| `skoda_section_available{section="…"}` | Section object present=1; absent or failed fetch=0; sections `odometer` and `charging` |
| `skoda_api_key_expiry_timestamp_seconds` | Parsed key expiry header, Unix seconds |

Health samples use fetch timestamps. Section presence does not imply complete
or fresh data. Failed fetches emit fetch, section and state availability as zero,
without advancing the last-successful timestamp or publishing vehicle readings.

Each reported state emits all documented states as 0/1: `CONNECT_CABLE`,
`CHARGING`, `CONSERVING`, `READY_FOR_CHARGING`, `DISCHARGING`, and
`CHARGING_INTERRUPTED`. Future strings become additional labels, and previously
observed future states are cleared on subsequent reported states. Missing state
emits availability=0 and no state samples.

Dashboard queries must require availability=1, a state sample timestamp matching
the availability timestamp, and a freshness window. A historical state value of
1 alone can show stale states, including future states from before a process
restart. For example, active states observed in the last 45 minutes:

```promql
(charging_state{sensor="car"} == 1)
and on(sensor) (skoda_charging_state_available{sensor="car"} == 1)
and on(sensor, state) (
  timestamp(charging_state{sensor="car"})
  == on(sensor) group_left
  timestamp(skoda_charging_state_available{sensor="car"})
)
and on(sensor) (
  time() - timestamp(skoda_charging_state_available{sensor="car"}) < 45 * 60
)
```

Adjust freshness and database lookback windows to your polling intervals. Use
capture-time metrics separately to assess vehicle freshness: fetch time describes
the API observation, not when the vehicle measured it.

Run focused tests without credentials:

```bash
PYTHONPATH=src uv run python -m unittest discover -s tests -v
uv lock --check
```
