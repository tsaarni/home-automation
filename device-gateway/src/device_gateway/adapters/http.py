"""Response validation shared by the HTTP adapters."""
import math

import httpx

from .base import Rejected


def checked(response):
    try:
        response.raise_for_status()
    except httpx.HTTPStatusError as exc:
        if response.status_code < 500:
            raise Rejected("http_rejection") from exc
        raise
    data = response.json()
    if isinstance(data, dict) and (data.get("error") or data.get("ErrorId") or data.get("ErrorMessage")):
        raise Rejected("device_api_error")
    return data


def finite_number(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
