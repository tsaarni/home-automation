"""Read-only MyŠkoda Public API collector with independent delivery retries."""

import asyncio
import datetime
from email.utils import parsedate_to_datetime
import logging
import math
import time
from urllib.parse import quote

from aiohttp import ClientError, ClientSession, ClientTimeout

from . import prometheus, task, utils

logger = logging.getLogger("app.skoda")
STATES = ("CONNECT_CABLE", "CHARGING", "CONSERVING", "READY_FOR_CHARGING", "DISCHARGING", "CHARGING_INTERRUPTED")
API_URL = "https://public.api.connect.skoda-auto.cz/api/v1/vehicles/"


def timestamp(value):
    """Only timezone-aware vehicle timestamps establish capture time."""
    try:
        dt = datetime.datetime.fromisoformat(value)
        return dt.timestamp() if dt.tzinfo is not None else None
    except (TypeError, ValueError, OverflowError):
        return None


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def mapping(value):
    return value if isinstance(value, dict) else {}


class Skoda:
    def configure(self, instance_name, config):
        if "poll-schedule" in config:
            raise ValueError(
                "Škoda poll-schedule is no longer supported; use poll-period-disconnected, poll-period-connected and poll-period-charging"
            )
        if "username" in config or "password" in config:
            raise ValueError("Replace Škoda username/password with an api_key created in MyŠkoda")
        self.instance_name = instance_name
        self.api_key = config["api_key"]
        if not isinstance(self.api_key, str) or not self.api_key.strip():
            raise ValueError("Škoda api_key must be a non-empty string")
        self.vin = config["vin"]
        self.database_url = config["database_url"]
        for mode, default in (("disconnected", "2h"), ("connected", "30m"), ("charging", "10m")):
            seconds = utils.parse_timedelta(config.get(f"poll-period-{mode}", default)).total_seconds()
            if seconds <= 0:
                raise ValueError(f"poll-period-{mode} must be positive")
            setattr(self, f"period_{mode}", seconds)
        self.poll_deadline = self.backoff_deadline = self.retry_deadline = self.quota_deadline = 0
        self.failures = 0
        self.suspended = False
        self.future_states = set()
        self.was_charging = False
        self.last_charging_capture = None
        self.followup_pending = False
        self.key_expiry = None

    def next_deadline(self):
        return max(self.poll_deadline, self.backoff_deadline, self.retry_deadline, self.quota_deadline)

    async def start(self):
        async with ClientSession(timeout=ClientTimeout(total=30)) as session:
            while True:
                if self.suspended:
                    await asyncio.Event().wait()
                delay = self.next_deadline() - time.monotonic()
                if delay > 0:
                    await asyncio.sleep(delay)
                    continue
                await self.update_metrics(session)

    def poll_interval(self, state, plug):
        if (state == "CHARGING" and plug == "DISCONNECTED") or (state == "CONNECT_CABLE" and plug == "CONNECTED"):
            logger.warning("Contradictory charging state %s and plug state %s", state, plug)
            return self.period_charging
        if state == "CHARGING":
            return self.period_charging
        if plug == "DISCONNECTED":
            return self.period_disconnected
        if plug == "CONNECTED":
            return self.period_connected
        if state == "CONNECT_CABLE":
            return self.period_disconnected
        return self.period_connected

    def observation_interval(self, vehicle, consuming_followup=False):
        charging = mapping(vehicle.get("charging"))
        status = mapping(charging.get("status"))
        battery = mapping(status.get("battery"))
        state, plug = status.get("state"), status.get("plugConnectionState")
        capture = timestamp(charging.get("carCapturedTimestamp"))
        stopped = self.was_charging and (
            (isinstance(state, str) and bool(state.strip()) and state != "CHARGING")
            or (plug == "DISCONNECTED" and state != "CHARGING")
        )
        interval = self.poll_interval(state, plug)
        if (
            stopped
            and not consuming_followup
            and (
                not number(battery.get("stateOfChargeInPercent"))
                or not number(battery.get("remainingCruisingRangeInMeters"))
                or capture is None
                or self.last_charging_capture is None
                or capture <= self.last_charging_capture
            )
        ):
            self.followup_pending = True
            interval = self.period_charging
        if state == "CHARGING":
            self.was_charging = True
            self.last_charging_capture = capture
        elif stopped:
            self.was_charging = False
        return interval

    def collect(self, vehicle, fetched_at, expiry=None):
        metrics = prometheus.Metrics()
        samples = {}

        def add(name, value, captured=None, labels=None, counter=False):
            if number(value):
                factory = metrics.counter if counter else metrics.gauge
                if name not in samples:
                    samples[name] = factory(name, labels={"sensor": "car"})
                samples[name].add(
                    value, labels=labels, timestamp_msec=(fetched_at if captured is None else captured) * 1000
                )

        success = vehicle is not None
        add("skoda_fetch_success", int(success))
        if success:
            add("skoda_last_successful_fetch_timestamp_seconds", fetched_at)
        if expiry is not None:
            add("skoda_api_key_expiry_timestamp_seconds", expiry)
        vehicle = mapping(vehicle)
        for section in ("odometer", "charging"):
            present = success and isinstance(vehicle.get(section), dict)
            add("skoda_section_available", int(present), labels={"section": section})
            captured = timestamp(mapping(vehicle.get(section)).get("carCapturedTimestamp"))
            if captured is not None:
                add("skoda_vehicle_captured_timestamp_seconds", captured, labels={"section": section})
        odometer = mapping(vehicle.get("odometer"))
        charging = mapping(vehicle.get("charging"))
        status = mapping(charging.get("status"))
        settings = mapping(charging.get("settings"))
        battery = mapping(status.get("battery"))
        odometer_time = timestamp(odometer.get("carCapturedTimestamp"))
        charging_time = timestamp(charging.get("carCapturedTimestamp"))
        add("odometer_km", odometer.get("mileageInKm"), odometer_time, counter=True)
        for name, source, field, factor in (
            ("battery_percentage", battery, "stateOfChargeInPercent", 1),
            ("range_km", battery, "remainingCruisingRangeInMeters", 0.001),
            ("charging_power_w", status, "chargePowerInKw", 1000),
            ("charging_remaining_seconds", status, "remainingTimeToFullyChargedInMinutes", 60),
            ("charging_target_percentage", settings, "targetStateOfChargeInPercent", 1),
        ):
            value = source.get(field)
            if number(value):
                add(name, value * factor, charging_time)
        for name, source, field, enums in (
            ("charging_plug_connected", status, "plugConnectionState", {"CONNECTED": 1, "DISCONNECTED": 0}),
            ("charging_plug_locked", status, "plugLockState", {"LOCKED": 1, "UNLOCKED": 0}),
            ("battery_care_enabled", settings, "chargingCareMode", {"ACTIVATED": 1, "DEACTIVATED": 0}),
        ):
            value = source.get(field)
            if isinstance(value, str) and value in enums:
                add(name, enums[value], charging_time)
        state = status.get("state")
        available = isinstance(state, str) and bool(state.strip())
        add("skoda_charging_state_available", int(available))
        if available:
            if state not in STATES:
                self.future_states.add(state)
            for known in sorted(set(STATES) | self.future_states):
                add("charging_state", int(state == known), labels={"state": known})
        return metrics.format()

    def server_deadlines(self, headers, status, now, wall):
        def seconds(name):
            try:
                value = float(headers.get(name))
                return value if math.isfinite(value) and value >= 0 else None
            except (TypeError, ValueError):
                return None

        limit, remaining, reset = (
            seconds(name) for name in ("RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset")
        )
        logger.debug("API quota limit=%s remaining=%s reset=%s", limit, remaining, reset)
        if remaining == 0:
            self.quota_deadline = max(self.quota_deadline, now + (reset if reset is not None else 60))
        if status in (429, 503):
            retry = seconds("Retry-After")
            if retry is None:
                try:
                    retry = max(0, parsedate_to_datetime(headers.get("Retry-After")).timestamp() - wall)
                except (TypeError, ValueError, OverflowError):
                    retry = 60
            self.retry_deadline = max(self.retry_deadline, now + retry)
        expiry = timestamp(headers.get("X-API-Key-Expires-At"))
        if expiry is not None and expiry != self.key_expiry:
            self.key_expiry = expiry
            logger.info("MyŠkoda API key expires at %s", headers.get("X-API-Key-Expires-At"))
        return expiry

    async def update_metrics(self, session):
        # Also enforce deadlines for callers outside start(), including coroutine restarts.
        if self.suspended or time.monotonic() < self.next_deadline():
            return
        consuming_followup = self.followup_pending
        self.followup_pending = False
        vehicle = None
        expiry = None
        try:
            async with session.get(
                API_URL + quote(self.vin, safe=""),
                params={"include": "odometer,charging"},
                headers={"X-API-Key": self.api_key},
                timeout=ClientTimeout(total=30),
            ) as response:
                now, wall = time.monotonic(), time.time()
                expiry = self.server_deadlines(response.headers, response.status, now, wall)
                if response.status in (401, 403):
                    self.suspended = True
                    logger.error(
                        "MyŠkoda authorization failed; create or renew a key authorized for this VIN in MyŠkoda, correct api_key and restart the application"
                    )
                if response.status != 200:
                    raise ValueError(f"API HTTP {response.status}")
                data = await response.json()
                if not isinstance(data, dict) or not isinstance(data.get("vehicle"), dict):
                    raise ValueError("API response lacks a vehicle object")
                vehicle = data["vehicle"]
                errors = data.get("errors")
                for error in errors if isinstance(errors, list) else []:
                    if isinstance(error, dict):
                        logger.warning("MyŠkoda partial data error type=%s", error.get("type", "unknown"))
        except (ClientError, asyncio.TimeoutError, ValueError) as error:
            # Avoid exception text from the HTTP client, which may contain request data.
            logger.warning("MyŠkoda fetch failed (%s)", type(error).__name__)
        now, wall = time.monotonic(), time.time()
        if vehicle is None:
            self.failures += 1
            self.poll_deadline = 0
            self.backoff_deadline = now + min(60 * 2 ** min(self.failures - 1, 5), 1800)
        else:
            self.failures = 0
            self.backoff_deadline = 0
            self.poll_deadline = now + self.observation_interval(vehicle, consuming_followup)
        payload = self.collect(vehicle, wall, expiry)
        await self.publish(session, payload)

    async def publish(self, session, payload):
        for attempt, delay in enumerate((0, 5, 15)):
            if delay:
                await asyncio.sleep(delay)
            try:
                async with session.post(self.database_url, data=payload, timeout=ClientTimeout(total=30)) as response:
                    if 200 <= response.status < 300:
                        return
                    logger.warning("Škoda database POST failed with HTTP %s", response.status)
            except (ClientError, asyncio.TimeoutError):
                logger.warning("Škoda database POST failed on attempt %s", attempt + 1)
        logger.error("Discarding Škoda metrics after three failed database attempts")


task.register(Skoda, "skoda")
