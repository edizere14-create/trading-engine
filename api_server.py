# api_server.py - FastAPI WebSocket Gateway + Redis Pub/Sub Subscriber
#
# Standalone server that runs alongside the trading bot.
# Subscribes to Redis "eddyi_live_feed" channel and pushes every message
# to all connected WebSocket clients at /ws/dashboard.
#
# Usage:
#   python api_server.py              (default port 8000)
#   uvicorn api_server:app --port 8000

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

# ── Config ──────────────────────────────────────────────────────────────────
REDIS_URL = (os.getenv("REDIS_URL") or "redis://localhost:6379/0").strip()
REDIS_CHANNEL = os.getenv("REDIS_CHANNEL", "eddyi_live_feed")
API_PORT = int(os.getenv("API_SERVER_PORT", 8000))


# ── Pydantic Models ─────────────────────────────────────────────────────────

class DashboardEvent(BaseModel):
    event_type: str
    timestamp: float = Field(default_factory=time.time)
    regime: str = "NORMAL"
    data: Dict[str, Any] = Field(default_factory=dict)


# ── Connection Manager ──────────────────────────────────────────────────────

class ConnectionManager:
    """
    Manages WebSocket connections. Handles connect/disconnect gracefully
    to prevent memory leaks.
    """

    def __init__(self) -> None:
        self._active: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._active.add(ws)
        print(f"[WS] Client connected. Total: {len(self._active)}")

    def disconnect(self, ws: WebSocket) -> None:
        self._active.discard(ws)
        print(f"[WS] Client disconnected. Total: {len(self._active)}")

    async def broadcast(self, message: str) -> None:
        """Send message to all connected clients, removing dead connections."""
        dead: List[WebSocket] = []
        for ws in self._active:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._active.discard(ws)

    @property
    def count(self) -> int:
        return len(self._active)


manager = ConnectionManager()


# ── Redis Subscriber Background Task ────────────────────────────────────────

async def _redis_subscriber():
    """
    Subscribe to Redis Pub/Sub and push every message to WebSocket clients.
    Reconnects on failure with exponential backoff.
    """
    backoff = 1
    while True:
        try:
            import redis.asyncio as aioredis
            r = aioredis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=5)
            pubsub = r.pubsub()
            await pubsub.subscribe(REDIS_CHANNEL)
            print(f"[REDIS_SUB] Subscribed to '{REDIS_CHANNEL}'")
            backoff = 1  # reset on successful connect

            async for message in pubsub.listen():
                if message["type"] == "message":
                    await manager.broadcast(message["data"])
        except Exception as exc:
            err_msg = str(exc) or type(exc).__name__
            print(f"[REDIS_SUB] Error: {err_msg}. Reconnecting in {backoff}s...")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


# ── FastAPI Lifespan ────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start Redis subscriber on startup, clean up on shutdown."""
    task = asyncio.create_task(_redis_subscriber())
    print(f"[API] EDDYI WebSocket Gateway starting on port {API_PORT}")
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    print("[API] Gateway shut down")


# ── FastAPI App ─────────────────────────────────────────────────────────────

app = FastAPI(
    title="EDDYI Trading Engine - WebSocket Gateway",
    version="2.0.0",
    lifespan=lifespan,
)


@app.websocket("/ws/dashboard")
async def dashboard_websocket(ws: WebSocket):
    """
    WebSocket endpoint for the dashboard.
    Clients connect here to receive real-time trading events.
    """
    await manager.connect(ws)
    try:
        # Send welcome message with current regime
        regime = "NORMAL"
        try:
            from dynamic_tuner import get_tuner
            regime = get_tuner().get_regime()
        except Exception:
            pass

        welcome = DashboardEvent(
            event_type="connected",
            regime=regime,
            data={"message": "EDDYI Live Feed", "clients": manager.count},
        )
        await ws.send_text(welcome.model_dump_json())

        # Keep connection alive, listen for client pings
        while True:
            data = await ws.receive_text()
            # Echo heartbeat pongs
            if data == "ping":
                await ws.send_text(json.dumps({"type": "pong", "ts": time.time()}))
    except WebSocketDisconnect:
        manager.disconnect(ws)
    except Exception:
        manager.disconnect(ws)


@app.get("/health")
async def health():
    """Health check endpoint."""
    regime = "NORMAL"
    try:
        from dynamic_tuner import get_tuner
        regime = get_tuner().get_regime()
    except Exception:
        pass
    return {
        "status": "ok",
        "ws_clients": manager.count,
        "regime": regime,
        "redis_channel": REDIS_CHANNEL,
        "timestamp": time.time(),
    }


@app.get("/status")
async def status():
    """Detailed engine status."""
    regime = "NORMAL"
    try:
        from dynamic_tuner import get_tuner
        regime = get_tuner().get_regime()
    except Exception:
        pass
    return {
        "engine": "EDDYI Trading Engine",
        "version": "2.0.0",
        "regime": regime,
        "ws_clients": manager.count,
        "redis_url_set": bool(REDIS_URL),
        "redis_channel": REDIS_CHANNEL,
    }


# ── Entrypoint ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=API_PORT)
