"""Entry point: uv run python -m automator."""

from __future__ import annotations

import logging

import uvicorn

from . import __version__
from .api import create_app
from .config import Settings, configure_logging


def main() -> None:
    settings = Settings.from_env()
    configure_logging(settings)
    log = logging.getLogger("automator")
    log.info("home-automator %s starting: data_dir=%s tz=%s dry_run=%s", __version__, settings.data_dir, settings.tz, settings.dry_run)
    app = create_app(settings)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level=settings.log_level.lower(), access_log=False)


if __name__ == "__main__":
    main()
