"""Home metrics: sensor scraping and pushing to VictoriaMetrics."""

__version__ = "1.0.0"

# Import all sensor tasks so they register in the task registry.
from . import goecharger, melcloud, shelly1, shelly2, skoda, spothinta, zigbee, zwave

__all__ = [
    "__version__",
    "goecharger",
    "melcloud",
    "shelly1",
    "shelly2",
    "skoda",
    "spothinta",
    "zigbee",
    "zwave",
]
