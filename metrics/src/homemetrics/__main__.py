"""Entry point: uv run python -m homemetrics."""

from __future__ import annotations

import asyncio
import sys

from .main import main


def cli() -> None:
    asyncio.run(main(sys.argv[1:]))


if __name__ == "__main__":
    cli()
