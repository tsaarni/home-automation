# Differences of this module to prometheus_client library
# - Acts only as a formatter for Prometheus exposition data format.
#   It does not implement a web server for Prometheus to scrape metrics from. We push metrics to VictoriaMetrics.
# - Implements only Prometheus data types that are needed by this project.
# - Allows setting Counter to given (monotonic) value instead of only allowing to incrementing it by one.
#   This is required for energy meter counters that are directly read from the meter.
# - Allows setting the optional timestamp parameter for each metric, which is needed when polling
#   the car data and electricity prices, which may contain data that was already scraped last time.

from __future__ import annotations


def escape_label(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


class Samples:
    def __init__(self, labels: dict[str, str] | None = None):
        self.common_labels_for_all_samples = labels if labels else {}
        self.samples: list[dict] = []

    def add(
        self,
        value: float,
        labels: dict[str, str] | None = None,
        timestamp_msec: float | None = None,
    ) -> None:
        self.samples.append(
            {
                "value": round(value, 3),
                "labels": labels if labels else {},
                "timestamp": timestamp_msec,
            }
        )

    def format(self) -> list[str]:
        output = []
        for sample in self.samples:
            s = ""
            labels = {**self.common_labels_for_all_samples, **sample["labels"]}
            if labels:
                labels_str = ",".join(f'{k}="{escape_label(v)}"' for k, v in labels.items())
                s += f"{{{labels_str}}} "

            s += f"{sample['value']}"

            if sample["timestamp"] is not None:
                s += f" {sample['timestamp']}"

            output.append(s)
        return output


class Metrics:
    def __init__(self):
        self.samples: list[dict] = []

    def num_samples(self) -> int:
        return len(self.samples)

    def counter(
        self,
        name: str,
        description: str = "",
        labels: dict[str, str] | None = None,
    ) -> Samples:
        s = Samples(labels)
        self.samples.append(
            {
                "type": "counter",
                "name": name,
                "description": description,
                "samples": s,
            }
        )
        return s

    def gauge(
        self,
        name: str,
        description: str = "",
        labels: dict[str, str] | None = None,
    ) -> Samples:
        s = Samples(labels)
        self.samples.append(
            {
                "type": "gauge",
                "name": name,
                "description": description,
                "samples": s,
            }
        )
        return s

    def format(self) -> str:
        output = ""
        for sample in self.samples:
            output += f"# HELP {sample['name']} {sample['description']}\n"
            output += f"# TYPE {sample['name']} {sample['type']}\n"
            for s in sample["samples"].format():
                output += f"{sample['name']} {s}\n"
        return output
