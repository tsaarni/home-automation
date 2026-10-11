"""Bootstrap configuration: environment variables only, everything else is a document."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .util import DurationError, parse_duration

LOGGER = logging.getLogger(__name__)

DEFAULT_TOPICS = ("zigbee2mqtt/#", "zwave/#", "home/#")
DISABLED_MQTT = ("", "none", "off", "disabled")


@dataclass
class MqttSettings:
    """Broker connection and subscriptions."""

    url: str | None = "mosquitto"
    host: str = "mosquitto"
    port: int = 1883
    username: str | None = None
    password: str | None = None
    client_id: str = "home-automator"
    keepalive: int = 30
    topics: tuple[str, ...] = DEFAULT_TOPICS
    reconnect_min: float = 1.0
    reconnect_max: float = 30.0

    @property
    def enabled(self) -> bool:
        return self.url is not None and self.url.strip().lower() not in DISABLED_MQTT


def parse_mqtt_url(url: str | None) -> tuple[str, int, str | None, str | None]:
    """Accept 'host', 'host:1883' and 'mqtt://user:pass@host:1883'."""
    if not url:
        return "mosquitto", 1883, None, None
    text = url.strip()
    if "://" not in text:
        text = "mqtt://" + text
    parsed = urlparse(text)
    host = parsed.hostname or "mosquitto"
    port = parsed.port or 1883
    username = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password else None
    return host, port, username, password


@dataclass
class Settings:
    """Service-wide settings resolved once at bootstrap."""

    data_dir: Path = Path("data")
    host: str = "0.0.0.0"
    port: int = 80
    log_level: str = "INFO"
    tz: str = "Europe/Helsinki"
    latitude: float | None = None
    longitude: float | None = None
    elevation: float = 0.0
    mqtt: MqttSettings = field(default_factory=MqttSettings)
    dry_run: bool = False
    scheduler_tick: float = 1.0
    catch_up_max_seconds: float = 12 * 3600.0
    events_max_bytes: int = 2_000_000
    events_memory: int = 1000
    events_default_limit: int = 100
    events_max_limit: int = 2000
    max_rule_depth: int = 8
    recent_write_ttl: float = 5.0

    @property
    def tzinfo(self) -> ZoneInfo:
        try:
            return ZoneInfo(self.tz)
        except (ZoneInfoNotFoundError, ValueError):
            LOGGER.warning("unknown timezone %r, falling back to UTC", self.tz)
            return ZoneInfo("UTC")

    @property
    def solar_available(self) -> bool:
        return self.latitude is not None and self.longitude is not None

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> "Settings":
        env = environ if environ is not None else dict(os.environ)

        def get(name: str, default: str | None = None) -> str | None:
            value = env.get(name)
            if value is None or not value.strip():
                return default
            return value.strip()

        def get_bool(name: str, default: bool = False) -> bool:
            value = get(name)
            if value is None:
                return default
            return value.lower() in ("1", "true", "yes", "on")

        def get_float(name: str, default: float | None = None) -> float | None:
            value = get(name)
            if value is None:
                return default
            try:
                return float(value)
            except ValueError:
                LOGGER.warning("%s=%r is not a number, using %s", name, value, default)
                return default

        def get_int(name: str, default: int) -> int:
            value = get(name)
            if value is None:
                return default
            try:
                return int(value)
            except ValueError:
                LOGGER.warning("%s=%r is not an integer, using %s", name, value, default)
                return default

        mqtt_url = get("MQTT_URL", "mosquitto")
        mqtt_host, mqtt_port, mqtt_user, mqtt_password = parse_mqtt_url(mqtt_url)
        topics_raw = get("MQTT_TOPICS")
        topics = tuple(t.strip() for t in (topics_raw.split(",") if topics_raw else DEFAULT_TOPICS) if t.strip())

        catch_up = get("CATCH_UP_MAX", "12h") or "12h"
        try:
            catch_up_seconds = parse_duration(catch_up).total_seconds()
        except DurationError:
            LOGGER.warning("CATCH_UP_MAX=%r is not a duration, using 12h", catch_up)
            catch_up_seconds = 12 * 3600.0

        return cls(
            data_dir=Path(get("DATA_DIR", "data") or "data"),
            host=get("HOST", "0.0.0.0") or "0.0.0.0",
            port=get_int("PORT", 80),
            log_level=(get("LOG_LEVEL", "INFO") or "INFO").upper(),
            tz=get("TZ", "Europe/Helsinki") or "Europe/Helsinki",
            latitude=get_float("LAT"),
            longitude=get_float("LON"),
            elevation=get_float("ELEVATION", 0.0) or 0.0,
            mqtt=MqttSettings(
                url=mqtt_url,
                host=mqtt_host,
                port=mqtt_port,
                username=get("MQTT_USERNAME", mqtt_user),
                password=get("MQTT_PASSWORD", mqtt_password),
                client_id=get("MQTT_CLIENT_ID", "home-automator") or "home-automator",
                topics=topics,
            ),
            dry_run=get_bool("DRY_RUN", False),
            scheduler_tick=get_float("SCHEDULER_TICK", 1.0) or 1.0,
            catch_up_max_seconds=catch_up_seconds,
            events_max_bytes=get_int("EVENTS_MAX_BYTES", 2_000_000),
            events_memory=get_int("EVENTS_MEMORY", 1000),
            events_default_limit=get_int("EVENTS_DEFAULT_LIMIT", 100),
            events_max_limit=get_int("EVENTS_MAX_LIMIT", 2000),
            max_rule_depth=get_int("MAX_RULE_DEPTH", 8),
        )

    def warnings(self) -> list[str]:
        messages = []
        if not self.solar_available:
            messages.append("LAT/LON not set: sunrise/sunset/dusk/dawn triggers are disabled")
        if not self.mqtt.enabled:
            messages.append("MQTT disabled: state can only change through the REST API")
        return messages


def configure_logging(settings: Settings) -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("aiomqtt").setLevel(max(level, logging.WARNING))
