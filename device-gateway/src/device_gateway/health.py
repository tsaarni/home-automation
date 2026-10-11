"""Process health and broker readiness endpoint."""
import asyncio
from collections.abc import Callable


async def respond(reader, writer, ready: Callable[[], bool]):
    try:
        line = await asyncio.wait_for(reader.readline(), timeout=2)
        status = 503 if b"/readyz " in line and not ready() else 200
        writer.write(f"HTTP/1.1 {status} OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK".encode())
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()
