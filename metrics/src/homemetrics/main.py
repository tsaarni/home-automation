"""Application lifecycle and runner for homemetrics."""

from __future__ import annotations

import argparse
import asyncio
import logging
import logging.config
import os
from pathlib import Path
import sys
import yaml

from . import __version__, task
from . import goecharger, melcloud, shelly1, shelly2, skoda, spothinta, zigbee, zwave  # noqa: F401


def configure_logging(logging_path: str | Path | None = None) -> None:
    """Configure logging from logging.yaml or fall back to standard configuration."""
    candidates: list[Path] = []
    if logging_path:
        candidates.append(Path(logging_path))
    candidates.append(Path.cwd() / "logging.yaml")
    candidates.append(Path(__file__).resolve().parent.parent.parent / "logging.yaml")

    for candidate in candidates:
        if candidate.is_file():
            try:
                with open(candidate, encoding="utf-8") as f:
                    cfg = yaml.safe_load(f)
                logging.config.dictConfig(cfg)
                return
            except Exception as e:
                print(f"Warning: Failed to load logging configuration from {candidate}: {e}", file=sys.stderr)

    # Fallback logging config
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, log_level, logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )
    logging.getLogger("aiomqtt").setLevel(max(level, logging.WARNING))


logger = logging.getLogger("app.main")


class Application:
    def __init__(self, args: list[str] | None = None):
        # Parse command line arguments.
        ap = argparse.ArgumentParser(description=f"home-metrics {__version__}")
        ap.add_argument(
            "--config",
            default=os.getenv("CONFIG_FILE", "config.yaml"),
            help="Path to config file (default: config.yaml or $CONFIG_FILE)",
        )
        ap.add_argument(
            "--logging",
            default=os.getenv("LOGGING_FILE"),
            help="Path to logging config file (default: logging.yaml)",
        )
        parsed_args = ap.parse_args(args)

        configure_logging(parsed_args.logging)

        if not parsed_args.config or not os.path.exists(parsed_args.config):
            logger.error("Configuration file not found: %s", parsed_args.config)
            sys.exit(1)

        # Load configuration file.
        logger.info("Loading configuration file: %s", parsed_args.config)
        with open(parsed_args.config, encoding="utf-8") as f:
            config = yaml.safe_load(f)

        # Instantiate task classes that are requested in the configuration file.
        self.tasks = []
        for s in config.get("sensors", []):
            # Combine global config with task-specific config.
            task_config = s.get("config", {}).copy()
            if "global" in config:
                task_config.update(config["global"])

            # Instantiate task class and configure it.
            cls = task.get_task_class(s["type"])
            instance = cls()
            instance.configure(s.get("name", ""), task_config)

            self.tasks.append(instance)

    async def start(self) -> None:
        # Start all tasks.
        for s in self.tasks:
            # Closure to wrap task in try/except block and retry on failure.
            async def task_wrapper(task_instance):
                logger.info("Starting task: %s", task_instance)
                delay = 10
                last_exception_time = asyncio.get_event_loop().time()
                while True:
                    try:
                        await task_instance.start()
                    except Exception as e:
                        # Reset retry delay to 10 seconds if no exceptions in the last 60 minutes.
                        current_time = asyncio.get_event_loop().time()
                        if current_time - last_exception_time > 60 * 60:
                            delay = 10
                        last_exception_time = current_time
                        logger.exception("Error in task %s, retry will be in %s seconds:", task_instance, delay, exc_info=e)
                        await asyncio.sleep(delay)
                        logger.info("Retrying task %s after %s seconds", task_instance, delay)
                        delay *= 2  # Exponential backoff.
                        delay = min(delay, 60 * 60)  # Limit to 60 minutes.

            asyncio.create_task(task_wrapper(s))

        # Do not exit, keep running until killed.
        await asyncio.Event().wait()


async def main(args: list[str] | None = None) -> None:
    await Application(args).start()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
