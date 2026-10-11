"""REST API and the static UI.

Every route works on documents: a PUT is an upsert by client-chosen id, and bad
references are rejected with 422 so the stored model stays consistent.
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, StreamingResponse
from pydantic import ValidationError

from . import __version__
from .config import Settings
from .evaluator import Trigger
from .models import (
    Device,
    Group,
    Rule,
    check_group_references,
    check_rule_references,
    groups_containing_device,
    rules_referencing_attribute,
    rules_referencing_device,
    rules_referencing_group,
)
from .service import Service
from .state import UNSET
from .util import DurationError, from_iso, parse_duration, valid_topic_filter

LOGGER = logging.getLogger(__name__)
UI_DIR = Path(__file__).parent / "ui"


def _error(status: int, detail: Any) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def _format_errors(exc: ValidationError) -> list[str]:
    problems = []
    for item in exc.errors():
        location = ".".join(str(part) for part in item.get("loc", ())) or "document"
        problems.append(f"{location}: {item.get('msg')}")
    return problems


def _validate(model: type, body: Any, doc_id: str) -> Any:
    if not isinstance(body, dict):
        raise _error(422, ["document must be a JSON object"])
    if body.get("id") not in (None, doc_id):
        raise _error(422, [f"id in body {body['id']!r} does not match path {doc_id!r}"])
    try:
        return model.model_validate({**body, "id": doc_id})
    except ValidationError as exc:
        raise _error(422, _format_errors(exc)) from None


async def _json_object(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - an empty body is fine for most POSTs
        return {}
    if body is None:
        return {}
    if not isinstance(body, dict):
        raise _error(422, ["body must be a JSON object"])
    return body


def create_app(settings: Settings | None = None, service: Service | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    svc = service or Service(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await svc.start()
        try:
            yield
        finally:
            await svc.stop()

    app = FastAPI(
        title="home-automator",
        version=__version__,
        summary="Home automation as data: devices, groups and rules",
        lifespan=lifespan,
    )
    app.state.service = svc

    # ------------------------------------------------------------------- health

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, Any]:
        return {"status": "ok", "version": __version__}

    @app.get("/readyz", tags=["ops"])
    async def readyz() -> dict[str, Any]:
        status = svc.status()
        if svc.started_at is None:
            raise _error(503, {"status": "starting", **status})
        return status

    @app.get("/metrics", tags=["ops"], response_class=PlainTextResponse)
    async def metrics() -> PlainTextResponse:
        svc.refresh_metrics()
        return PlainTextResponse(svc.metrics.render(), media_type="text/plain; version=0.0.4")

    @app.get("/", tags=["ui"], response_class=HTMLResponse)
    async def index() -> HTMLResponse:
        page = UI_DIR / "index.html"
        if not page.exists():
            return HTMLResponse("<h1>home-automator</h1><p>UI not installed.</p>")
        return HTMLResponse(page.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------ devices

    def device_payload(device: Device) -> dict[str, Any]:
        return {**device.doc(), "state": svc.state.device_snapshot(device.id), **svc.commands.describe(device.id), "referenced_by": rules_referencing_device(svc.store.rules, device.id)}

    @app.get("/api/v1/devices", tags=["devices"])
    async def list_devices() -> list[dict[str, Any]]:
        return [device_payload(device) for device in sorted(svc.store.devices.values(), key=lambda item: item.id)]

    @app.get("/api/v1/devices/{device_id}", tags=["devices"])
    async def get_device(device_id: str) -> dict[str, Any]:
        device = svc.store.devices.get(device_id)
        if device is None:
            raise _error(404, f"unknown device {device_id!r}")
        return device_payload(device)

    @app.put("/api/v1/devices/{device_id}", tags=["devices"])
    async def put_device(device_id: str, request: Request) -> dict[str, Any]:
        document: Device = _validate(Device, await _json_object(request), device_id)
        previous = svc.store.devices.get(device_id)
        problems: list[str] = []
        if previous is not None:
            for attr in previous.attributes:
                if attr in document.attributes:
                    continue
                referencing = rules_referencing_attribute(svc.store.rules, device_id, attr)
                if referencing:
                    problems.append(f"attribute {attr!r} is used by rules {referencing}")
        if problems:
            raise _error(422, problems)
        svc.store.put_device(document)
        for attr in list(previous.attributes) if previous is not None else []:
            if attr not in document.attributes:
                svc.state.forget_attribute(device_id, attr)
        return device_payload(document)

    @app.delete("/api/v1/devices/{device_id}", tags=["devices"])
    async def delete_device(device_id: str) -> dict[str, Any]:
        if device_id not in svc.store.devices:
            raise _error(404, f"unknown device {device_id!r}")
        referencing = rules_referencing_device(svc.store.rules, device_id)
        members = groups_containing_device(svc.store.groups, device_id)
        if referencing or members:
            raise _error(422, [f"device {device_id!r} is used by rules {referencing} and groups {members}"])
        svc.store.delete_device(device_id)
        svc.state.forget_device(device_id)
        svc.store.delete_timers(lambda timer: timer.get("device") == device_id)
        return {"deleted": device_id}

    @app.post("/api/v1/devices/{device_id}/set", tags=["devices"])
    async def set_device(device_id: str, request: Request) -> dict[str, Any]:
        device = svc.store.devices.get(device_id)
        if device is None:
            raise _error(404, f"unknown device {device_id!r}")
        body = await _json_object(request)
        revert_after = _revert_after(body)
        if not body:
            raise _error(422, ["no attribute values given"])
        unknown = [attr for attr in body if attr not in device.attributes]
        if unknown:
            raise _error(422, [f"device {device_id!r} has no attributes {sorted(unknown)}"])
        results = await svc.manual_set(device_id, body, revert_after=revert_after)
        return {"results": results}

    # ------------------------------------------------------------------- groups

    @app.get("/api/v1/groups", tags=["groups"])
    async def list_groups() -> list[dict[str, Any]]:
        return [
            {**group.doc(), "referenced_by": rules_referencing_group(svc.store.rules, group.id)}
            for group in sorted(svc.store.groups.values(), key=lambda item: item.id)
        ]

    @app.get("/api/v1/groups/{group_id}", tags=["groups"])
    async def get_group(group_id: str) -> dict[str, Any]:
        group = svc.store.groups.get(group_id)
        if group is None:
            raise _error(404, f"unknown group {group_id!r}")
        return {**group.doc(), "referenced_by": rules_referencing_group(svc.store.rules, group_id)}

    @app.put("/api/v1/groups/{group_id}", tags=["groups"])
    async def put_group(group_id: str, request: Request) -> dict[str, Any]:
        document: Group = _validate(Group, await _json_object(request), group_id)
        problems = check_group_references(document, svc.store.devices)
        if problems:
            raise _error(422, problems)
        svc.store.put_group(document)
        return document.doc()

    @app.delete("/api/v1/groups/{group_id}", tags=["groups"])
    async def delete_group(group_id: str) -> dict[str, Any]:
        if group_id not in svc.store.groups:
            raise _error(404, f"unknown group {group_id!r}")
        referencing = rules_referencing_group(svc.store.rules, group_id)
        if referencing:
            raise _error(422, [f"group {group_id!r} is used by rules {referencing}"])
        svc.store.delete_group(group_id)
        return {"deleted": group_id}

    @app.post("/api/v1/groups/{group_id}/set", tags=["groups"])
    async def set_group(group_id: str, request: Request) -> dict[str, Any]:
        group = svc.store.groups.get(group_id)
        if group is None:
            raise _error(404, f"unknown group {group_id!r}")
        body = await _json_object(request)
        revert_after = _revert_after(body)
        if not body:
            raise _error(422, ["no attribute values given"])
        problems = []
        for attr in body:
            for member in group.members:
                device = svc.store.devices.get(member)
                if device is None or attr not in device.attributes:
                    problems.append(f"{member!r} has no attribute {attr!r}")
        if problems:
            raise _error(422, problems)
        results = await svc.group_set(group_id, body, revert_after=revert_after)
        return {"results": results}

    # -------------------------------------------------------------------- state

    @app.get("/api/v1/state", tags=["state"])
    async def get_state() -> dict[str, Any]:
        return svc.state.snapshot()

    @app.get("/api/v1/state/{device_id}", tags=["state"])
    async def get_device_state(device_id: str) -> dict[str, Any]:
        if device_id not in svc.store.devices:
            raise _error(404, f"unknown device {device_id!r}")
        return svc.state.device_snapshot(device_id)

    @app.get("/api/v1/timers", tags=["state"])
    async def get_timers() -> dict[str, Any]:
        return {"timers": svc.store.list_timers(), "next_due": svc.scheduler.next_due_map()}

    # -------------------------------------------------------------------- rules

    @app.get("/api/v1/rules", tags=["rules"])
    async def list_rules() -> list[dict[str, Any]]:
        return [rule.doc() for rule in sorted(svc.store.rules.values(), key=lambda item: (-item.priority, item.id))]

    @app.get("/api/v1/rules/{rule_id}", tags=["rules"])
    async def get_rule(rule_id: str) -> dict[str, Any]:
        rule = svc.store.rules.get(rule_id)
        if rule is None:
            raise _error(404, f"unknown rule {rule_id!r}")
        return rule.doc()

    @app.put("/api/v1/rules/{rule_id}", tags=["rules"])
    async def put_rule(rule_id: str, request: Request) -> dict[str, Any]:
        document: Rule = _validate(Rule, await _json_object(request), rule_id)
        problems = check_rule_references(document, svc.store.devices, svc.store.groups)
        for index, action in enumerate(document.then):
            if action.publish is not None and not valid_topic_filter(action.publish.topic):
                problems.append(f"then[{index}]: invalid MQTT topic filter {action.publish.topic!r}")
        if problems:
            raise _error(422, problems)
        svc.store.put_rule(document)
        svc.evaluator.rebuild_index()
        svc.scheduler.rearm()
        return document.doc()

    @app.delete("/api/v1/rules/{rule_id}", tags=["rules"])
    async def delete_rule(rule_id: str) -> dict[str, Any]:
        if rule_id not in svc.store.rules:
            raise _error(404, f"unknown rule {rule_id!r}")
        svc.store.delete_rule(rule_id)
        svc.store.delete_timers(lambda timer: timer.get("rule") == rule_id)
        svc.evaluator.rebuild_index()
        svc.scheduler.rearm()
        return {"deleted": rule_id}

    @app.post("/api/v1/rules/{rule_id}/enable", tags=["rules"])
    async def enable_rule(rule_id: str) -> dict[str, Any]:
        return _set_enabled(rule_id, True)

    @app.post("/api/v1/rules/{rule_id}/disable", tags=["rules"])
    async def disable_rule(rule_id: str) -> dict[str, Any]:
        return _set_enabled(rule_id, False)

    def _set_enabled(rule_id: str, enabled: bool) -> dict[str, Any]:
        rule = svc.store.set_rule_enabled(rule_id, enabled)
        if rule is None:
            raise _error(404, f"unknown rule {rule_id!r}")
        svc.scheduler.rearm()
        return rule.doc()

    @app.post("/api/v1/rules/{rule_id}/test", tags=["rules"])
    async def test_rule(rule_id: str, request: Request) -> dict[str, Any]:
        rule = svc.store.rules.get(rule_id)
        if rule is None:
            raise _error(404, f"unknown rule {rule_id!r}")
        body = await _json_object(request)
        now = svc.clock()
        if isinstance(body.get("now"), str):
            try:
                now = from_iso(body["now"])
            except ValueError as exc:
                raise _error(422, [f"now: {exc}"]) from None
        if rule.when.kind == "state":
            assert rule.when.device is not None and rule.when.attr is not None
            value = svc.state.value(rule.when.device, rule.when.attr, UNSET)
            trigger = Trigger("state", rule.when.device, rule.when.attr, None if value is UNSET else value, now, True)
        else:
            trigger = Trigger(rule.when.kind, ts=now)
        report = svc.evaluator.dry_run_report(rule, trigger)
        if rule.when.kind == "state" and not svc.state.known(rule.when.device or "", rule.when.attr or ""):
            report["trigger"]["unknown_value"] = True
        return report

    # ------------------------------------------------------------------- events

    @app.get("/api/v1/events", tags=["events"])
    async def get_events(
        since: str | None = Query(None, description="ISO timestamp, only newer events"),
        until: str | None = None,
        rule: str | None = None,
        kind: str | None = None,
        category: str | None = Query(None, description="Event category: activity, telemetry, timers, system"),
        exclude_kinds: str | None = Query(None, description="Comma-separated event kinds to exclude (e.g. state,timer)"),
        limit: int = Query(default=settings.events_default_limit, ge=1, le=settings.events_max_limit),
    ) -> list[dict[str, Any]]:
        parsed_since: datetime | None = None
        parsed_until: datetime | None = None
        for name, raw, target in (("since", since, "since"), ("until", until, "until")):
            if raw is None:
                continue
            try:
                if target == "since":
                    parsed_since = from_iso(raw)
                else:
                    parsed_until = from_iso(raw)
            except ValueError as exc:
                raise _error(422, [f"{name}: {exc}"]) from None
        parsed_exclude = [k.strip() for k in exclude_kinds.split(",") if k.strip()] if exclude_kinds else None
        return svc.store.read_events(
            since=parsed_since,
            until=parsed_until,
            rule=rule,
            kind=kind,
            category=category,
            exclude_kinds=parsed_exclude,
            limit=limit,
        )

    @app.get("/api/v1/events/stream", tags=["events"])
    async def stream_events(
        request: Request,
        category: str | None = Query(None, description="Event category: activity, telemetry, timers, system"),
        exclude_kinds: str | None = Query(None, description="Comma-separated event kinds to exclude"),
        kind: str | None = None,
        rule: str | None = None,
    ) -> StreamingResponse:
        parsed_exclude = {k.strip() for k in exclude_kinds.split(",") if k.strip()} if exclude_kinds else None
        from .store import CATEGORY_KINDS

        allowed_kinds = CATEGORY_KINDS.get(category) if category is not None else None

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=100)

        def on_event(event: dict[str, Any]) -> None:
            ev_type = event.get("type")
            if kind is not None and ev_type != kind:
                return
            if allowed_kinds is not None and ev_type not in allowed_kinds:
                return
            if parsed_exclude and ev_type in parsed_exclude:
                return
            if rule is not None:
                from .store import _event_rules
                if rule not in _event_rules(event):
                    return
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass  # drop for slow consumers rather than blocking or growing unbounded

        unsubscribe = svc.store.subscribe(on_event)

        async def event_generator():
            try:
                # Send initial ping / comment to flush headers
                yield ": connected\n\n"
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=15.0)
                        data = json.dumps(event, default=str)
                        yield f"data: {data}\n\n"
                    except asyncio.TimeoutError:
                        # Keep-alive comment every 15s
                        yield ": ping\n\n"
            finally:
                unsubscribe()

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # -------------------------------------------------------------------- admin

    @app.post("/api/v1/reload", tags=["ops"])
    async def reload_config() -> dict[str, Any]:
        svc.store.load()
        svc.evaluator.rebuild_index()
        svc.scheduler.boot(svc.clock())
        return svc.status()

    @app.post("/api/v1/dry-run", tags=["ops"])
    async def set_dry_run(request: Request) -> dict[str, Any]:
        body = await _json_object(request)
        if "enabled" not in body:
            return {"dry_run": svc.dry_run}
        svc.dry_run = bool(body["enabled"])
        svc.store.append_event({"type": "config", "action": "dry_run", "enabled": svc.dry_run})
        return {"dry_run": svc.dry_run}

    return app


def _revert_after(body: dict[str, Any]) -> Any:
    raw = body.pop("revert_after", None)
    if raw in (None, "", False):
        return None
    try:
        return parse_duration(raw)
    except DurationError as exc:
        raise _error(422, [f"revert_after: {exc}"]) from None

