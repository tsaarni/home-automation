from __future__ import annotations

import asyncio
import datetime
import logging
import random

logger = logging.getLogger("app.utils")


def next_wakeup(
    schedule: list[datetime.time],
    now: datetime.datetime | None = None,
) -> tuple[datetime.timedelta, datetime.datetime]:
    """Calculate next scheduled wakeup time.

    :param schedule: Array of times to wake up at.
    :param now: Optional current time (defaults to datetime.datetime.now()).
    :return: Tuple of seconds until wakeup and the time to wake up at.
    """
    if not schedule:
        raise ValueError("Schedule cannot be empty")

    # Sort the times in the schedule from earliest to latest.
    sorted_schedule = sorted(schedule)

    if now is None:
        now = datetime.datetime.now()

    next_wakeup_time: datetime.datetime | None = None
    for dt in sorted_schedule:
        if now.time() < dt:
            # It's before scheduled time, so schedule for today.
            next_wakeup_time = datetime.datetime(now.year, now.month, now.day, dt.hour, dt.minute, dt.second)
            break

    if next_wakeup_time is None:
        # It was past all scheduled times, so schedule for earliest time tomorrow.
        next_wakeup_time = datetime.datetime.combine(now.date() + datetime.timedelta(days=1), sorted_schedule[0])

    seconds_until_wakeup = next_wakeup_time - now
    return seconds_until_wakeup, next_wakeup_time


async def retry_until_successful(func, max_retries: int = 5):
    """Retry a function until it succeeds.

    :param func: The function to call.
    :param max_retries: Maximum number of retries.
    """
    delay = 1

    for _ in range(max_retries):
        try:
            return await func()
        except Exception as e:
            logger.exception("Error:", exc_info=e)
            logger.info("Retrying in %s seconds", delay)
            await asyncio.sleep(delay)
            delay *= 2  # Exponential backoff.
            delay = min(delay, 60 * 5)  # Limit to 5 minutes.

    raise Exception(f"Failed after {max_retries} retries")


def parse_timedelta(interval: str) -> datetime.timedelta:
    """Parse a time interval string into a timedelta.

    :param interval: The interval string. For example, "5m" for 5 minutes. Supported units are "s", "m", "h", and "d".
    :return: The timedelta.
    """
    if not interval or len(interval) < 2:
        raise ValueError(f"Invalid interval: {interval}")

    unit = interval[-1]
    value = int(interval[:-1])
    if unit == "s":
        return datetime.timedelta(seconds=value)
    elif unit == "m":
        return datetime.timedelta(minutes=value)
    elif unit == "h":
        return datetime.timedelta(hours=value)
    elif unit == "d":
        return datetime.timedelta(days=value)
    else:
        raise ValueError(f"Invalid unit: {unit}")


def random_jitter(interval: datetime.timedelta, jitter: float = 0.1) -> datetime.timedelta:
    """Add a random jitter to a timedelta.

    :param interval: The timedelta to add jitter to.
    :param jitter: The amount of jitter to add, as a percentage of the interval.
    :return: The jittered timedelta.
    """
    return interval * (1 + (random.random() * 2 - 1) * jitter)
