# Device gateway

> [!WARNING]
> Personal home automation project. Made for a specific house; it will not work for others.

Async Python bridge for Gen2+ Shelly switches and MELCloud air-to-air units. Automator retains
control logic; the gateway handles device I/O over MQTT.

## Run

```sh
uv sync --python 3.14
cp example-config.yaml config.yaml
uv run device-gateway --config config.yaml validate-config
uv run device-gateway --config config.yaml inspect
uv run device-gateway --config config.yaml run
```

Set the referenced secrets in the environment. For MELCloud, use a Celsius account and the
device ID from `User/ListDevices`. Configure setpoint bounds from device metadata.

## Automator bindings

```sh
uv run device-gateway --config config.yaml export-automator --output bindings.json
uv run device-gateway --config config.yaml export-automator --merge ../automator/data/config.json --output merged.json
```

Review the merged config before installing it. Back up the existing config and run automator
in dry-run first. The gateway does not edit automator at runtime.

## Checks

```sh
uv run pytest
```

`/healthz` reports process health; `/readyz` requires an MQTT connection (port 8080). Config
changes require a restart. Stop the gateway and restore the previous automator config to roll
back. The gateway does not change device-native settings.
