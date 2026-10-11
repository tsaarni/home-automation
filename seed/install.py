"""Install the seed documents into a data directory (bootstrap for a fresh deploy).

    uv run python seed/install.py /data

Writes data/config.json from seed/devices.json, seed/groups.json and seed/rules.json.
Existing files are left alone unless --force is given.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SEED_DIR = Path(__file__).parent
SECTIONS = ("devices", "groups", "rules")


def load_seed(seed_dir: Path = SEED_DIR) -> dict[str, dict]:
    model: dict[str, dict] = {}
    for section in SECTIONS:
        path = seed_dir / f"{section}.json"
        model[section] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return model


def install(data_dir: Path, *, force: bool = False) -> Path:
    import os

    # make the package importable when run as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
    from automator.models import Device, Group, Rule  # noqa: PLC0415
    from automator.util import atomic_write_json  # noqa: PLC0415

    model = load_seed()
    for section, model_type in zip(SECTIONS, (Device, Group, Rule)):
        for key, document in model[section].items():
            payload = dict(document)
            payload.setdefault("id", key)
            model_type.model_validate(payload)

    config_path = Path(data_dir) / "config.json"
    if config_path.exists() and not force:
        raise SystemExit(f"{config_path} already exists, use --force to overwrite")
    config_path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_json(config_path, {"version": 1, **model})
    return config_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_dir", type=Path, nargs="?", default=Path("data"))
    parser.add_argument("--force", action="store_true", help="overwrite an existing config.json")
    args = parser.parse_args(argv)
    path = install(args.data_dir, force=args.force)
    model = load_seed()
    print(f"wrote {path}: {len(model['devices'])} devices, {len(model['groups'])} groups, {len(model['rules'])} rules")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
