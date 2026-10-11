# Seed documents

> [!WARNING]
> Personal home automation project. Made for a specific house; it will not work for others.

This directory contains the documents that the service starts with, and the tool that
extracts the device documents from the MQTT sources.

## Why this directory exists

The service controls the house through *device documents*. One device document binds MQTT
topics to the attributes of one device. A rule writes an attribute. The service publishes the
value to the write topic of that attribute. If the topic is wrong, the service reports no
error. The rule then does nothing, and nobody sees the problem.

The topics are long and easy to mistype. One thermostat has about 20 attributes. The committed
device file has 313 attributes. Manual typing is slow and unreliable.

The gateways already know all of this data:

* zigbee2mqtt knows the device names, the value types, the units, the limits and the write topics.
* zwave-js-ui knows the node names, the value labels, the units, the limits, the state tables
  and which values are writable.

Therefore you do not type the documents. A tool reads the gateway configuration and writes the
documents. You review the result and commit it. This directory holds the reviewed result.

### Who uses it

| Who | What they do |
|---|---|
| The operator (you) | Runs the extraction tool before the cutover, and after you add or replace a device. Reviews the diff. Installs the seed into the data directory. |
| The service | Reads `config.json` only. It never runs the tool and never reads this directory. |
| The tests | Load the seed and run the behaviour scenarios against it. |

## What this directory contains

| File | Kind | How it is made |
|---|---|---|
| `devices.json` | Device documents, keyed by device id. 40 devices and 313 attributes in the committed file. | Extracted by `generate_devices.py`, then reviewed by hand. |
| `groups.json` | Group documents. A group is a write-only alias for several devices. | Written by hand. |
| `rules.json` | The rule documents for the behaviour that must work at the cutover. | Written by hand, from `PLAN.md`. |
| `install.py` | Installer. It writes `<data dir>/config.json` from the three files above. | - |
| `generate_devices.py` | The extraction tool. It is not part of the running service. | - |

## What a device document contains

```json
"thermostat-toilet": {
  "name": "Toilet thermostat",
  "attributes": {
    "setpoint": {
      "read":  { "topic": "zwave/thermostat-toilet/67/1/setpoint/1", "path": "value" },
      "write": { "topic": "zwave/thermostat-toilet/67/1/setpoint/1/set", "payload": { "value": "$v" } },
      "type": "number", "unit": "C", "limits": [5, 35], "default": 15
    }
  }
}
```

| Field | Meaning |
|---|---|
| `read.topic` | The MQTT topic for the incoming value. |
| `read.path` | The JSON key inside the payload. Omit it when the payload is the value itself. |
| `write.topic` | The MQTT topic for the outgoing value. Omit the whole `write` block when the attribute is read-only. |
| `write.payload` | The payload template. `$v` is the value. |
| `type` | `number`, `string` or `boolean`. |
| `unit` | A label for the user interface. The service does not convert units. Use `scale` and `offset` for that. |
| `limits` | The lowest and the highest value that the service accepts for a write. |
| `enum` | The list of the accepted values. The service refuses other values on a write. |
| `default` | The value that a timed override restores when the service never saw the old value. |

## Where the data comes from

| Source | Location | What the tool reads |
|---|---|---|
| zwave-js-ui | The `/usr/src/app/store` directory of the `zwave2mqtt` pod. On the node it is the host path `/volumes/zwave2mqtt`. | `nodes.json` = node names. `<driver>.json` = the node list. `<driver>.metadata.jsonl` = the label, type, unit, limits, states and the read and write flags of each value. `settings.json` = the MQTT topic prefix and the topic format. |
| zigbee2mqtt | The ConfigMap `zigbee2mqtt-config`, keys `configuration.yaml` and `devices.yaml`. | The MQTT base topic and the friendly name of each device. |
| zigbee2mqtt | The retained MQTT topic `zigbee2mqtt/bridge/devices`. | The device list and the `exposes` of each device. The exposes give the type, the unit, the limits, the enum and the write access of each attribute. |
| home-metrics | The MQTT topics `home/<sensor>/<metric>`. | The metric names. These names live in the code of home-metrics, not in its configuration. The tool reads them from an MQTT capture. |

The extraction tool also imitates two rules of zwave-js-ui, because they change the topic text:

* `removeSlash`: a `/` inside a name becomes `-`.
* `sanitizeTopic`: a space becomes `_`, and characters outside `A-Z a-z 0-9 - _` are removed.

For example, the value label `Air temperature` becomes the topic part `Air_temperature`, and
`Door/Window` becomes `Door-Window`.

## How to extract the devices

### Preconditions

* You have `kubectl` access to the cluster.
* The `zwave2mqtt` and `zigbee2mqtt` pods run.
* You can reach the MQTT broker, on port 1883. From a machine in the house network, use the
  node address. Inside the cluster, use the service name `mosquitto`.

### Step 1 - Copy the zwave-js-ui store

```bash
kubectl exec deploy/zwave2mqtt -- tar -cf - -C /usr/src/app/store . > /tmp/zwave-store.tar
mkdir -p /tmp/zwave-store
tar -xf /tmp/zwave-store.tar -C /tmp/zwave-store
```

The store contains the Z-Wave security keys. Keep it in `/tmp`. Do not commit it.

### Step 2 - Copy the zigbee2mqtt configuration

```bash
mkdir -p /tmp/z2m
kubectl get cm zigbee2mqtt-config -o jsonpath='{.data.configuration\.yaml}' > /tmp/z2m/configuration.yaml
kubectl get cm zigbee2mqtt-config -o jsonpath='{.data.devices\.yaml}'       > /tmp/z2m/devices.yaml
```

### Step 3 - Run the extraction tool

```bash
cd <repository>
uv run python seed/generate_devices.py \
    --mqtt mosquitto --duration 60 \
    --zwave-store /tmp/zwave-store \
    --zigbee-config /tmp/z2m/configuration.yaml \
    --zigbee-devices /tmp/z2m/devices.yaml \
    --verify-topics --groups
```

Inside the cluster the broker name is `mosquitto`. From a machine outside the cluster, pass the
address of the node, for example `--mqtt 192.168.86.76`.

The tool listens to the broker for 60 seconds. During this time it receives the retained
zigbee2mqtt device list and the values that change. If your machine cannot reach the broker,
run the tool in a temporary pod instead:

```bash
kubectl run seed --image=quay.io/tsaarni/home-automator:latest --image-pull-policy=IfNotPresent \
    --restart=Never --command -- sleep 1800
kubectl cp seed/generate_devices.py seed:/tmp/generate_devices.py
kubectl cp /tmp/zwave-store seed:/tmp/zwave-store
kubectl cp /tmp/z2m seed:/tmp/z2m
kubectl exec seed -- python3 /tmp/generate_devices.py --mqtt mosquitto --duration 60 \
    --zwave-store /tmp/zwave-store --zigbee-config /tmp/z2m/configuration.yaml \
    --zigbee-devices /tmp/z2m/devices.yaml --devices-out /tmp/devices.json
kubectl cp seed:/tmp/devices.json /tmp/devices.json
kubectl delete pod seed
```

Useful options:

| Option | Effect |
|---|---|
| `--no-merge` | Ignore the current seed file and write a fresh one. Use this only for a full rebuild. |
| `--verify-topics` | Print the zwave topics that the capture did not see. |
| `--groups` | Also write `groups.json`, built from the device id prefixes. This replaces the hand-written groups. Use `--groups-out /tmp/groups.json` to compare first. |
| `--devices-out` | Write the result to another path. Use this to compare before you replace the seed. |
| `--sniff-topics FILE` | Use a saved capture instead of listening. Each line holds a topic, a TAB character, and the payload. |

### Step 4 - Read the report and the diff

The tool prints the number of devices that it derived, the number of devices in the output
file, and the unconfirmed topics. Read them, then run `git diff seed/devices.json`. Add the
new devices to the rules and the groups when a rule must use them.

### Step 5 - Install the seed

```bash
uv run python seed/install.py /tmp/data       # writes /tmp/data/config.json
```

In the cluster, copy the seed into the pod and run the installer on the data volume:

```bash
kubectl cp seed deploy/automator:/tmp/seed
kubectl exec deploy/automator -- python /tmp/seed/install.py /data
kubectl rollout restart deploy/automator
```

## How the tool makes names and topics

### zwave-js-ui

| Item | Rule |
|---|---|
| Device id | The node name from `nodes.json`, in lower case. The controller, node 1, is skipped. |
| Attribute id | The zwave-js label of the value, in lower case. If the label is absent, the property name. Example: `Electric Consumption [kWh]` becomes `electric-consumption-kwh`. |
| Topic | `<prefix>/<node>/<command class>/<endpoint>/<property>[/<key>]`, with the two rules above. A number is not quoted. |
| Write topic | The read topic plus `/set`, with the payload `{"value": "$v"}`. The tool adds the write topic when the metadata says `writeable`. |
| Type, unit, limits | From the metadata. `states` becomes an `enum` of the state codes. |
| Mirror values | zwave-js copies the values of a multi-channel device to endpoint 0. The broker publishes only one of the two. When a value exists at several endpoints, the tool keeps the endpoints that the capture saw. A value that exists at one endpoint is always kept. |
| Sleeping nodes | The tool reads these devices from the store, because they do not publish. When a value exists at several endpoints, the tool keeps the endpoint with the newest timestamp. |

### zigbee2mqtt

| Item | Rule |
|---|---|
| Device id | The friendly name, in lower case. |
| Attribute id | The property name of the expose, in lower case. |
| Topic | `<base topic>/<friendly name>`, plus the path of the property. The base topic comes from `configuration.yaml`. |
| Write topic | `<base topic>/<friendly name>/set`, with the payload `{"<property>": "$v"}`. The tool adds the write topic when the access value of the expose has the SET bit. |
| Type, unit, limits, enum | From the expose. A numeric expose gives a limit pair when the expose shows a minimum and a maximum. |

### home-metrics

| Item | Rule |
|---|---|
| Device id | The sensor part of the topic, in lower case. The tool merges it into the device with the same id, for example `thermostat-toilet`. |
| Attribute id | The metric part of the topic, in lower case. |
| Unit | From the metric name, for example `_kwh` gives `kWh`. |

## What the output is

* `seed/devices.json`, a JSON object. The keys are the device ids. The values are the device
  documents. The file in this repository holds 40 devices: 29 zigbee2mqtt devices, 12
  zwave-js-ui devices, and the home-metrics values merged into four thermostats.
* `seed/groups.json` and `seed/rules.json` are not overwritten, unless you use `--groups`.
* The standard output shows three lines, for example `derived 40 devices`,
  `wrote seed/devices.json: 40 devices`, and `zwave topics the capture never saw: 51`. The last
  line lists the values that the store knows and the capture did not see.

### Checks

| Check | Command |
|---|---|
| The documents are valid and the rules refer to real attributes | `uv run pytest tests/automator/test_seed.py -q` |
| The parity rules work on the seed | The same test file, the test `test_seeded_config_runs_the_parity_scenarios` |
| The tool is stable | Run the tool a second time without `--no-merge`. The output must not change. |

## Hand edits

Some data is not in any configuration. This data is hand-written in `seed/devices.json`:

| Kind | Example | Reason |
|---|---|---|
| Alias | `thermostat-bathroom.setpoint` for `67-0-setpoint-1` | The rules stay short and readable. |
| Default | `17` for the bathroom setpoint | A timed override must restore a value that the service never saw. |
| Name | `Terrace lights` for `powerplug-terrace` | The user interface shows a human name. |

The tool protects your edits. `merge_devices()` applies two rules:

1. The document in the seed wins over the extracted attribute with the same name.
2. An extracted attribute is dropped when an attribute in the seed already uses the same read
   topic. This rule keeps an alias when the tool adds the original name again.

Therefore a repeated extraction only adds new data. Review the diff before you commit it.

## Cautions

* The zwave-js-ui store holds the Z-Wave security keys in `settings.json`. Do not commit the
  store, and do not commit a capture of the MQTT traffic.
* A capture is a sample. A value that does not change during the capture can be absent. Use a
  longer duration, or add the attribute through the REST API.
* home-metrics repeats some zwave values under a second name, for example `temperature-celsius`
  next to `air-temperature`. Keep the attribute that you prefer and delete the other one.
* Use one topic for one attribute. Two attributes with the same read topic receive the same
  value, and the user interface then shows the same value two times.

## When to extract again

* After you pair a new device, or after you replace a device. A replacement can change the
  endpoint numbers and the topics.
* After an upgrade of a gateway, when it changes the names or the topic format.
* Before the cutover. Compare the report with the live topics.
