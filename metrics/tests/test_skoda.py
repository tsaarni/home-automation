import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import ClientError
from homemetrics.skoda import API_URL, STATES, Skoda, timestamp


class Response:
    def __init__(self, status=200, data=None, headers=None, error=None):
        self.status, self.data, self.headers, self.error = status, data, headers or {}, error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self

    async def __aexit__(self, *args):
        pass

    async def json(self):
        return self.data


class Session:
    def __init__(self, responses, posts=None):
        self.responses, self.posts = list(responses), list(posts or [Response(204)])
        self.get_calls, self.post_calls = [], []

    def get(self, *args, **kwargs):
        self.get_calls.append((args, kwargs))
        return self.responses.pop(0)

    def post(self, *args, **kwargs):
        self.post_calls.append((args, kwargs))
        return self.posts.pop(0)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass


def collector(**config):
    obj = Skoda()
    obj.configure("test", {"api_key": "secret", "vin": "TESTVIN", "database_url": "http://db", **config})
    return obj


def vehicle(state="CHARGING", plug="CONNECTED", capture="2026-10-11T10:00:00Z"):
    return {
        "odometer": {"mileageInKm": 0, "carCapturedTimestamp": "2026-10-11T09:00:00Z"},
        "charging": {
            "carCapturedTimestamp": capture,
            "status": {
                "state": state,
                "plugConnectionState": plug,
                "plugLockState": "UNLOCKED",
                "chargePowerInKw": 2.5,
                "remainingTimeToFullyChargedInMinutes": 0,
                "battery": {"stateOfChargeInPercent": 0, "remainingCruisingRangeInMeters": 12500},
            },
            "settings": {"targetStateOfChargeInPercent": 80, "chargingCareMode": "ACTIVATED"},
        },
    }


class MetricsTests(unittest.TestCase):
    def test_values_timestamps_and_types(self):
        output = collector().collect(vehicle(), 123)
        odo, charging = (timestamp(f"2026-10-11T{hour}:00:00Z") * 1000 for hour in ("09", "10"))
        for name, value, captured in [
            ("odometer_km", "0", odo),
            ("battery_percentage", "0", charging),
            ("range_km", "12.5", charging),
            ("charging_power_w", "2500.0", charging),
            ("charging_remaining_seconds", "0", charging),
            ("charging_target_percentage", "80", charging),
            ("charging_plug_locked", "0", charging),
            ("battery_care_enabled", "1", charging),
        ]:
            self.assertIn(f'{name} {{sensor="car"}} {value} {captured}', output)
        self.assertIn("# TYPE odometer_km counter", output)
        self.assertEqual(output.count("# TYPE charging_state gauge"), 1)
        self.assertEqual(output.count("# TYPE skoda_section_available gauge"), 1)
        self.assertIn('skoda_vehicle_captured_timestamp_seconds {sensor="car",section="charging"}', output)
        self.assertIn('skoda_last_successful_fetch_timestamp_seconds {sensor="car"} 123 123000', output)

    def test_partial_empty_failure_fallback(self):
        for data in ({}, {"charging": {}}, None):
            output = collector().collect(data, 123)
            self.assertNotIn("\nbattery_percentage ", output)
            self.assertNotIn("\ncharging_state ", output)
            self.assertIn('skoda_charging_state_available {sensor="car"} 0 123000', output)
            self.assertIn(f'skoda_fetch_success {{sensor="car"}} {int(data is not None)}', output)
            self.assertEqual("last_successful" in output, data is not None)
            self.assertIn(
                f'skoda_section_available {{sensor="car",section="charging"}} {int(data == {"charging": {}})}', output
            )
        data = vehicle(capture=None)
        data["charging"]["status"]["battery"].pop("remainingCruisingRangeInMeters")
        output = collector().collect(data, 123)
        self.assertIn('battery_percentage {sensor="car"} 0 123000', output)
        self.assertNotIn("\nrange_km ", output)
        self.assertNotIn('skoda_vehicle_captured_timestamp_seconds {sensor="car",section="charging"}', output)

    def test_states_restart_future_labels_and_enums(self):
        obj = collector()
        future = 'FUTURE"\\\nSTATE'
        output = obj.collect(vehicle(future, "FUTURE"), 123)
        self.assertIn('state="FUTURE\\"\\\\\\nSTATE"} 1 123000', output)
        self.assertNotIn("\ncharging_plug_connected ", output)
        for state in STATES:
            self.assertIn(f'state="{state}"}} 0 123000', output)
        self.assertIn('state="FUTURE\\"\\\\\\nSTATE"} 0 124000', obj.collect(vehicle("CONSERVING"), 124))
        for state in STATES:
            self.assertIn(
                f'state="{state}"}} {int(state == "CONSERVING")} 124000',
                collector().collect(vehicle("CONSERVING"), 124),
            )
        data = vehicle()
        data["charging"]["settings"]["chargingCareMode"] = "UNKNOWN"
        data["charging"]["status"]["plugLockState"] = "UNKNOWN"
        output = obj.collect(data, 125)
        self.assertNotIn("\nbattery_care_enabled ", output)
        self.assertNotIn("\ncharging_plug_locked ", output)

    def test_poll_table(self):
        cases = [
            ("CHARGING", "DISCONNECTED", 600),
            ("CONNECT_CABLE", "CONNECTED", 600),
            ("CHARGING", None, 600),
            (None, "DISCONNECTED", 7200),
            (None, "CONNECTED", 1800),
            ("CONNECT_CABLE", None, 7200),
            ("CONNECT_CABLE", "FUTURE", 7200),
            (None, None, 1800),
            ("FUTURE", "CONNECTED", 1800),
            ("FUTURE", "DISCONNECTED", 7200),
            ("CHARGING_INTERRUPTED", "CONNECTED", 1800),
            ("FUTURE", None, 1800),
        ]
        for state, plug, expected in cases:
            with self.subTest(state=state, plug=plug):
                self.assertEqual(collector().poll_interval(state, plug), expected)

    def test_followup(self):
        for defect in ("same", "absent", "battery", "range"):
            obj = collector()
            obj.observation_interval(vehicle())
            stopped = vehicle("CONSERVING", capture="2026-10-11T10:01:00Z")
            if defect == "same":
                stopped["charging"]["carCapturedTimestamp"] = "2026-10-11T10:00:00Z"
            elif defect == "absent":
                stopped["charging"].pop("carCapturedTimestamp")
            else:
                stopped["charging"]["status"]["battery"].pop(
                    "stateOfChargeInPercent" if defect == "battery" else "remainingCruisingRangeInMeters"
                )
            self.assertEqual(obj.observation_interval(stopped), 600)
            self.assertTrue(obj.followup_pending)
            obj.followup_pending = False
            self.assertEqual(obj.observation_interval(stopped, True), 1800)
            self.assertFalse(obj.followup_pending)
            self.assertEqual(obj.observation_interval(vehicle(), True), 600)
        obj = collector()
        obj.observation_interval(vehicle())
        self.assertEqual(obj.observation_interval(vehicle(None)), 1800)
        self.assertTrue(obj.was_charging)
        self.assertEqual(obj.observation_interval(vehicle(None, "DISCONNECTED")), 600)
        obj = collector()
        obj.observation_interval(vehicle())
        self.assertEqual(obj.observation_interval(vehicle("CONSERVING", capture="2026-10-11T10:01:00Z")), 1800)
        self.assertFalse(obj.followup_pending)

    def test_config_and_headers(self):
        for config in (
            {"poll-schedule": []},
            {"username": "old"},
            {"poll-period-charging": "0m"},
            {"poll-period-connected": "-1m"},
            {"api_key": ""},
        ):
            with self.assertRaises(ValueError):
                collector(**config)
        self.assertEqual(collector(**{"poll-period-charging": "1m"}).period_charging, 60)
        obj = collector()
        obj.server_deadlines(
            {"RateLimit-Limit": "77", "RateLimit-Remaining": "0", "RateLimit-Reset": "900", "Retry-After": "1200"},
            429,
            100,
            1000,
        )
        self.assertEqual(obj.next_deadline(), 1300)
        obj = collector()
        obj.server_deadlines({"Retry-After": "Thu, 01 Jan 1970 00:30:00 GMT"}, 503, 100, 1000)
        self.assertEqual(obj.retry_deadline, 900)
        for invalid in ("bad", "-5", "nan", "inf", None):
            obj = collector()
            obj.server_deadlines(
                {"RateLimit-Remaining": "0", "RateLimit-Reset": invalid, "Retry-After": invalid}, 503, 100, 1000
            )
            self.assertEqual(obj.next_deadline(), 160)


class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_request_partial_quota_and_deadlines(self):
        obj = collector()
        session = Session(
            [
                Response(
                    data={"vehicle": vehicle(), "errors": [{"type": "ODOMETER_UNAVAILABLE"}]},
                    headers={
                        "RateLimit-Remaining": "0",
                        "RateLimit-Reset": "3600",
                        "X-API-Key-Expires-At": "2027-01-01T00:00:00Z",
                    },
                )
            ]
        )
        with patch("homemetrics.skoda.time.monotonic", return_value=100):
            await obj.update_metrics(session)
            await obj.update_metrics(session)
        self.assertEqual(len(session.get_calls), 1)
        args, kwargs = session.get_calls[0]
        self.assertEqual(args[0], API_URL + "TESTVIN")
        self.assertEqual(kwargs["params"], {"include": "odometer,charging"})
        self.assertEqual(kwargs["headers"], {"X-API-Key": "secret"})
        self.assertEqual(kwargs["timeout"].total, 30)
        self.assertEqual(obj.next_deadline(), 3700)
        self.assertIn("skoda_api_key_expiry_timestamp_seconds", session.post_calls[0][1]["data"])

    async def test_backoff_reset_and_consumed_followup(self):
        obj = collector()
        obj.followup_pending = True
        responses = (
            [Response(429, headers={"RateLimit-Remaining": "0", "RateLimit-Reset": "100", "Retry-After": "120"})]
            + [Response(500) for _ in range(5)]
            + [Response(data={"vehicle": {}})]
        )
        session = Session(responses, [Response(204) for _ in responses])
        clock = 100
        for delay in (60, 120, 240, 480, 960, 1800):
            with patch("homemetrics.skoda.time.monotonic", return_value=clock):
                await obj.update_metrics(session)
            self.assertEqual(obj.backoff_deadline, clock + delay)
            self.assertFalse(obj.followup_pending)
            clock = obj.next_deadline()
        with patch("homemetrics.skoda.time.monotonic", return_value=clock):
            await obj.update_metrics(session)
        self.assertEqual(obj.failures, 0)
        self.assertEqual(obj.backoff_deadline, 0)
        self.assertEqual(obj.poll_deadline, clock + 1800)
        self.assertNotIn("last_successful", session.post_calls[0][1]["data"])

    async def test_followup_attempt_failure_and_resumed_charging(self):
        for next_response in (
            Response(500),
            Response(data={"vehicle": vehicle()}),
            Response(data={"vehicle": vehicle("CONSERVING")}),
        ):
            obj = collector()
            session = Session(
                [
                    Response(data={"vehicle": vehicle()}),
                    Response(data={"vehicle": vehicle("CONSERVING")}),
                    next_response,
                ],
                [Response(204), Response(204), Response(204)],
            )
            with patch("homemetrics.skoda.time.monotonic", return_value=100):
                await obj.update_metrics(session)
            with patch("homemetrics.skoda.time.monotonic", return_value=700):
                await obj.update_metrics(session)
            self.assertTrue(obj.followup_pending)
            self.assertEqual(obj.poll_deadline, 1300)
            with patch("homemetrics.skoda.time.monotonic", return_value=1300):
                await obj.update_metrics(session)
            self.assertFalse(obj.followup_pending)
            if next_response.status == 500:
                self.assertEqual(obj.backoff_deadline, 1360)
            else:
                self.assertEqual(obj.poll_deadline, 1300 + (600 if obj.was_charging else 1800))

    async def test_successful_database_retry_keeps_api_deadline(self):
        obj = collector()
        session = Session([Response(data={"vehicle": vehicle()})], [Response(500), Response(204)])
        clock = [100]

        async def sleep(delay):
            clock[0] += delay

        with patch("homemetrics.skoda.asyncio.sleep", side_effect=sleep), patch(
            "homemetrics.skoda.time.monotonic", side_effect=lambda: clock[0]
        ):
            await obj.update_metrics(session)
        self.assertEqual(clock[0], 105)
        self.assertEqual(obj.poll_deadline, 700)
        self.assertEqual(len(session.post_calls), 2)
        self.assertEqual(session.post_calls[0][1]["data"], session.post_calls[1][1]["data"])

    async def test_invalid_and_network(self):
        for response in (
            Response(data=[]),
            Response(data={}),
            Response(error=ClientError()),
            Response(error=asyncio.TimeoutError()),
        ):
            obj = collector()
            await obj.update_metrics(Session([response]))
            self.assertEqual(obj.failures, 1)

    async def test_delivery_discard_and_continued_polling(self):
        obj = collector()
        session = Session(
            [Response(data={"vehicle": vehicle()})], [Response(500), Response(error=ClientError()), Response(503)]
        )
        with patch("homemetrics.skoda.asyncio.sleep", new_callable=AsyncMock) as sleep, patch(
            "homemetrics.skoda.time.monotonic", return_value=100
        ):
            await obj.update_metrics(session)
            await obj.update_metrics(session)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 15])
        self.assertEqual(len(session.get_calls), 1)
        self.assertEqual(len(session.post_calls), 3)
        self.assertEqual(len({call[1]["data"] for call in session.post_calls}), 1)
        self.assertTrue(all(call[1]["timeout"].total <= 30 for call in session.post_calls))
        self.assertEqual(obj.poll_deadline, 700)
        session.responses.append(Response(data={"vehicle": {}}))
        session.posts.append(Response(204))
        with patch("homemetrics.skoda.time.monotonic", return_value=700):
            await obj.update_metrics(session)
        self.assertEqual(len(session.get_calls), 2)

    async def test_auth_other_tasks_cancellation(self):
        for status in (401, 403):
            obj = collector()
            session = Session([Response(status)])
            await obj.update_metrics(session)
            await obj.update_metrics(session)
            self.assertTrue(obj.suspended)
            self.assertEqual(len(session.get_calls), 1)
            running = asyncio.create_task(obj.start())
            other = AsyncMock()
            await other()
            await asyncio.sleep(0)
            self.assertFalse(running.done())
            running.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await running
            other.assert_awaited_once()

    async def test_restart_and_publish_cancellation(self):
        obj = collector()
        obj.poll_deadline = 1000
        session = Session([])
        with patch("homemetrics.skoda.ClientSession", return_value=session), patch(
            "homemetrics.skoda.time.monotonic", return_value=100
        ), patch("homemetrics.skoda.asyncio.sleep", side_effect=asyncio.CancelledError) as sleep:
            for _ in range(2):
                with self.assertRaises(asyncio.CancelledError):
                    await obj.start()
            self.assertEqual(sleep.call_args.args, (900,))
        self.assertEqual(session.get_calls, [])
        with self.assertRaises(asyncio.CancelledError):
            await obj.publish(Session([], [Response(error=asyncio.CancelledError())]), "payload")
