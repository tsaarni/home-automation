"""Small shared helpers: durations, time, JSON paths, topic matching, atomic files.

Everything here is dependency-free so that any layer (models, store, mqtt) can use it.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UNIT_SECONDS = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0, "w": 604800.0}
_DURATION_TOKEN = re.compile(r"(?P<sign>[+-]?)\s*(?P<num>\d+(?:\.\d+)?)\s*(?P<unit>[smhdw])", re.IGNORECASE)
_TOPIC_SEGMENT = re.compile(r"^[^/#+]+$")


class DurationError(ValueError):
    """Raised for unparsable durations."""


def parse_duration(value: Any, *, allow_negative: bool = False) -> timedelta:
    """Parse '3h', '90s', '1h30m', '1d', a number of seconds or a timedelta."""
    if isinstance(value, timedelta):
        result = value
    elif isinstance(value, bool):
        raise DurationError(f"invalid duration: {value!r}")
    elif isinstance(value, (int, float)):
        result = timedelta(seconds=float(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise DurationError("empty duration")
        total = 0.0
        pos = 0
        while pos < len(text):
            match = _DURATION_TOKEN.match(text, pos)
            if match is None:
                raise DurationError(f"invalid duration: {value!r}")
            amount = float(match.group("num")) * UNIT_SECONDS[match.group("unit").lower()]
            if match.group("sign") == "-":
                amount = -amount
            total += amount
            pos = match.end()
        result = timedelta(seconds=total)
    else:
        raise DurationError(f"invalid duration: {value!r}")

    if result.total_seconds() < 0 and not allow_negative:
        raise DurationError(f"negative duration not allowed: {value!r}")
    return result


def format_duration(value: timedelta) -> str:
    """Inverse of parse_duration (lossy for mixed units, round-trips fine)."""
    seconds = value.total_seconds()
    sign = "-" if seconds < 0 else ""
    seconds = abs(seconds)
    if seconds == 0:
        return "0s"
    if seconds % 604800 == 0:
        return f"{sign}{int(seconds // 604800)}w"
    if seconds % 86400 == 0:
        return f"{sign}{int(seconds // 86400)}d"
    if seconds % 3600 == 0:
        return f"{sign}{int(seconds // 3600)}h"
    if seconds % 60 == 0:
        return f"{sign}{int(seconds // 60)}m"
    if float(seconds).is_integer():
        return f"{sign}{int(seconds)}s"
    return f"{sign}{seconds:g}s"


def now_utc() -> datetime:
    """Timezone-aware wall clock; every module takes its clock from the service."""
    return datetime.now(timezone.utc)


def to_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds")


def from_iso(text: str) -> datetime:
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def get_path(obj: Any, path: str | None) -> tuple[bool, Any]:
    """Follow a dotted JSON path ('value.temperature', '0.value')."""
    if path in (None, "", "."):
        return True, obj
    current = obj
    for part in str(path).split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, (list, tuple)) and part.lstrip("-").isdigit():
            index = int(part)
            if not -len(current) <= index < len(current):
                return False, None
            current = current[index]
        else:
            return False, None
    return True, current


def topic_matches(pattern: str, topic: str) -> bool:
    """MQTT wildcard match: '+' is one level, '#' is the rest of the topic."""
    if pattern == topic:
        return True
    if "#" not in pattern and "+" not in pattern:
        return False
    pattern_parts = pattern.split("/")
    topic_parts = topic.split("/")
    for index, segment in enumerate(pattern_parts):
        if segment == "#":
            return True
        if index >= len(topic_parts):
            return False
        if segment == "+":
            continue
        if segment != topic_parts[index]:
            return False
    return len(pattern_parts) == len(topic_parts)


def valid_topic_filter(pattern: str) -> bool:
    """True for a syntactically valid MQTT topic filter ('#' only at the end)."""
    if not pattern or pattern != pattern.strip():
        return False
    parts = pattern.split("/")
    for index, segment in enumerate(parts):
        if segment == "#":
            return index == len(parts) - 1
        if segment == "+" or _TOPIC_SEGMENT.match(segment):
            continue
        return False
    return True


def file_mtime_ns(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def atomic_write_text(path: Path, text: str) -> None:
    """Write via temp file + os.replace so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # cleartext, host-readable documents (the data dir is the backup)
        os.chmod(tmp_name, 0o644)
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False, default=str) + "\n")
