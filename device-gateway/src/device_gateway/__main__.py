import argparse
import asyncio
import json
import logging
from pathlib import Path

from .config import load
from .export import bindings, merge
from .factory import AdapterFactory
from .service import Service


async def run(args):
    config = load(args.config)
    if args.command == "validate-config":
        print("Configuration valid")
        return
    if args.command == "run":
        await Service(config).run()
        return
    factory = AdapterFactory(config)
    try:
        if args.command == "clear-retained":
            import aiomqtt
            from .config import secret
            mqtt = config.mqtt
            async with aiomqtt.Client(hostname=mqtt.host, port=mqtt.port,
                username=secret(mqtt.username_env) if mqtt.username_env else None,
                password=secret(mqtt.password_env) if mqtt.password_env else None) as client:
                for name in args.devices:
                    if name in config.devices or "/" in name or "+" in name or "#" in name:
                        raise ValueError("only removed concrete device ids may be cleared")
                    for suffix in ("state", "availability"):
                        await client.publish(f"{mqtt.topic_prefix}/{name}/{suffix}", b"", qos=1, retain=True)
        elif args.command == "inspect":
            result = {}
            for name, adapter in factory.create_all().items():
                try:
                    result[name] = {"adapter": config.devices[name].adapter, **await adapter.inspect()}
                except Exception as exc:
                    result[name] = {"error": type(exc).__name__, "reason": str(exc) if isinstance(exc, ValueError) else "inspection_failed"}
            print(json.dumps(result, indent=2, sort_keys=True))
        elif args.command == "export-automator":
            documents = await bindings(config, factory.create_all())
            output = {"devices": documents}
            if args.merge:
                output, conflicts = merge(json.loads(Path(args.merge).read_text()), documents)
                if conflicts:
                    raise ValueError("merge conflicts: " + "; ".join(conflicts))
            text = json.dumps(output, indent=2, sort_keys=True) + "\n"
            if args.output:
                Path(args.output).write_text(text)
            else:
                print(text, end="")
    finally:
        await factory.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run")
    sub.add_parser("validate-config")
    sub.add_parser("inspect")
    export = sub.add_parser("export-automator")
    export.add_argument("--merge", help="existing automator config.json; writes a reviewable merged document")
    export.add_argument("--output")
    clear = sub.add_parser("clear-retained")
    clear.add_argument("devices", nargs="+")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
