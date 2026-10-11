"""Built-in device adapters. Add an implementation and register its factory here."""
from typing import Callable

from ..config import Device
from . import melcloud_ata, shelly_rpc
from .base import Adapter, Resources

ADAPTERS: dict[str, Callable[[Device, Resources], Adapter]] = {
    "shelly-rpc": shelly_rpc.create,
    "melcloud-ata": melcloud_ata.create,
}
