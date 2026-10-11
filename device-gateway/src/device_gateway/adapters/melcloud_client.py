"""MELCloud account session, authentication, serialization and server backoff.

Shared by all adapters using the same account; it does not know device settings.
"""
import asyncio
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

from .base import Rejected
from .http import checked

BASE = "https://app.melcloud.com/Mitsubishi.Wifi.Client"


class MelCloudClient:
    """Shared session and account-wide scheduling/backoff, including writes."""
    def __init__(self, credentials, timeout, client=None):
        self.credentials = credentials
        self.client = client or httpx.AsyncClient(base_url=BASE + "/", timeout=timeout)
        self.key = None
        self.lock = asyncio.Lock()
        self.retry_at = 0
        self.fahrenheit = False
        self.login_rejected = False

    async def login(self):
        username, password = self.credentials.credentials()
        if self.login_rejected:
            raise Rejected("login_rejected; restart after fixing credentials")
        response = await self.client.post("Login/ClientLogin", json={
            "AppVersion": "1.30.5.0", "Email": username, "Password": password,
            "Language": 0, "Persist": True,
        })
        try:
            data = checked(response)
        except Rejected:
            self.login_rejected = True
            raise
        login = data.get("LoginData")
        if not login or not login.get("ContextKey"):
            self.login_rejected = True
            raise Rejected("login_rejected")
        self.key = login["ContextKey"]
        self.fahrenheit = bool(login.get("UseFahrenheit", False))

    async def request(self, method, path, expires_at=None, **kwargs):
        async with self.lock:
            delay = self.retry_at - time.monotonic()
            if delay > 0:
                # Do not block a device worker for server backoff; next scheduled read retries.
                raise Rejected("account_backoff")
            if self.key is None:
                await self.login()
            for attempt in range(2):
                if expires_at and datetime.now(timezone.utc) >= expires_at:
                    raise Rejected("expired")
                response = await self.client.request(method, path, headers={"X-MitsContextKey": self.key}, **kwargs)
                if response.status_code in (401, 403) and attempt == 0:
                    self.key = None
                    await self.login()
                    continue
                if response.status_code in (429, 503):
                    retry = response.headers.get("Retry-After", "60")
                    try:
                        seconds = float(retry)
                    except ValueError:
                        seconds = (parsedate_to_datetime(retry) - datetime.now(timezone.utc)).total_seconds()
                    self.retry_at = time.monotonic() + max(1, seconds)
                return checked(response)
            raise Rejected("session_rejected")

    async def close(self):
        await self.client.aclose()
