# state_manager.py - Redis Distributed Locking (Redlock) + Event Broadcasting
#
# Provides:
#   - StateManager class using redis.asyncio
#   - acquire_trade_lock(token_symbol) via SETNX + 10s TTL (prevents double-trading)
#   - broadcast_event(event_type, data) pushes JSON to Redis Pub/Sub channel "eddyi_live_feed"
#   - Regime-aware: every broadcast includes the current MarketRegime

import asyncio
import json
import os
import time
from typing import Any, Dict, Optional

from pydantic import BaseModel, Field

# ── Config ──────────────────────────────────────────────────────────────────
REDIS_URL = (os.getenv("REDIS_URL") or "redis://localhost:6379/0").strip()
REDIS_CHANNEL = os.getenv("REDIS_CHANNEL", "eddyi_live_feed")
TRADE_LOCK_TTL_SECONDS = int(os.getenv("TRADE_LOCK_TTL_SECONDS", 10))
LOCK_KEY_PREFIX = "eddyi:lock:trade:"


# ── Pydantic Models ─────────────────────────────────────────────────────────

class EventPayload(BaseModel):
    event_type: str
    timestamp: float = Field(default_factory=time.time)
    regime: str = "NORMAL"
    data: Dict[str, Any] = Field(default_factory=dict)


class LockResult(BaseModel):
    acquired: bool
    token_symbol: str
    lock_key: str
    ttl_seconds: int = TRADE_LOCK_TTL_SECONDS
    error: Optional[str] = None


# ── StateManager ────────────────────────────────────────────────────────────

class StateManager:
    """
    Redis-backed distributed state manager.
    Handles trade locking (Redlock-style SETNX) and event broadcasting via Pub/Sub.
    """

    _instance: Optional["StateManager"] = None

    def __init__(self, redis_url: Optional[str] = None) -> None:
        self._redis_url = redis_url or REDIS_URL
        self._redis = None  # lazy connection
        self._connected = False

    @classmethod
    def get_instance(cls) -> "StateManager":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def _ensure_connection(self):
        """Lazy-connect to Redis on first use."""
        if self._redis is not None and self._connected:
            return
        try:
            import redis.asyncio as aioredis
            self._redis = aioredis.from_url(
                self._redis_url,
                decode_responses=True,
                socket_connect_timeout=5,
            )
            await self._redis.ping()
            self._connected = True
            print(f"[STATE_MANAGER] Connected to Redis: {self._redis_url}")
        except Exception as exc:
            self._connected = False
            print(f"[STATE_MANAGER] Redis connection failed: {exc}")
            raise

    # ── Distributed Locking ─────────────────────────────────────────────

    async def acquire_trade_lock(self, token_symbol: str) -> LockResult:
        """
        Acquire a distributed lock for a token using SETNX + TTL.
        Prevents multiple bot instances from double-trading the same signal.
        """
        lock_key = f"{LOCK_KEY_PREFIX}{token_symbol}"
        try:
            await self._ensure_connection()
            # SETNX with EX (TTL) — atomic set-if-not-exists
            acquired = await self._redis.set(
                lock_key,
                json.dumps({
                    "locked_at": time.time(),
                    "token": token_symbol,
                    "pid": os.getpid(),
                }),
                nx=True,
                ex=TRADE_LOCK_TTL_SECONDS,
            )
            result = LockResult(
                acquired=bool(acquired),
                token_symbol=token_symbol,
                lock_key=lock_key,
                ttl_seconds=TRADE_LOCK_TTL_SECONDS,
            )
            if acquired:
                print(f"[STATE_MANAGER] Lock acquired: {lock_key} (TTL={TRADE_LOCK_TTL_SECONDS}s)")
            else:
                print(f"[STATE_MANAGER] Lock denied (already held): {lock_key}")
            return result
        except Exception as exc:
            err_msg = str(exc) or type(exc).__name__
            print(f"[STATE_MANAGER] Lock error for {token_symbol}: {err_msg}")
            return LockResult(
                acquired=False,
                token_symbol=token_symbol,
                lock_key=lock_key,
                error=err_msg,
            )

    async def release_trade_lock(self, token_symbol: str) -> bool:
        """Explicitly release a trade lock (normally expires via TTL)."""
        lock_key = f"{LOCK_KEY_PREFIX}{token_symbol}"
        try:
            await self._ensure_connection()
            deleted = await self._redis.delete(lock_key)
            if deleted:
                print(f"[STATE_MANAGER] Lock released: {lock_key}")
            return bool(deleted)
        except Exception as exc:
            print(f"[STATE_MANAGER] Release error for {token_symbol}: {exc}")
            return False

    # ── Event Broadcasting (Pub/Sub) ────────────────────────────────────

    async def broadcast_event(
        self,
        event_type: str,
        data: Dict[str, Any],
        regime: Optional[str] = None,
    ) -> bool:
        """
        Publish a JSON event to the Redis Pub/Sub channel.
        Every event includes the current MarketRegime.
        """
        if regime is None:
            try:
                from dynamic_tuner import get_tuner
                regime = get_tuner().get_regime()
            except Exception:
                regime = "NORMAL"

        payload = EventPayload(
            event_type=event_type,
            timestamp=time.time(),
            regime=regime,
            data=data,
        )

        try:
            await self._ensure_connection()
            message = payload.model_dump_json()
            subscribers = await self._redis.publish(REDIS_CHANNEL, message)
            print(
                f"[STATE_MANAGER] Broadcast: {event_type} "
                f"regime={regime} subscribers={subscribers}"
            )
            return True
        except Exception as exc:
            err_msg = str(exc) or type(exc).__name__
            print(f"[STATE_MANAGER] Broadcast failed: {err_msg}")
            return False

    # ── Utility ─────────────────────────────────────────────────────────

    async def store_backtest_result(self, result: Dict[str, Any]) -> bool:
        """Push a backtest result to the backtest_results Redis list."""
        try:
            await self._ensure_connection()
            await self._redis.rpush(
                "backtest_results",
                json.dumps(result),
            )
            return True
        except Exception as exc:
            print(f"[STATE_MANAGER] Backtest store failed: {exc}")
            return False

    async def get_backtest_results(self, limit: int = 100) -> list:
        """Retrieve recent backtest results."""
        try:
            await self._ensure_connection()
            raw = await self._redis.lrange("backtest_results", -limit, -1)
            return [json.loads(r) for r in raw]
        except Exception as exc:
            print(f"[STATE_MANAGER] Backtest fetch failed: {exc}")
            return []

    def status(self) -> Dict[str, Any]:
        return {
            "redis_url_set": bool(self._redis_url),
            "connected": self._connected,
            "channel": REDIS_CHANNEL,
            "lock_ttl_seconds": TRADE_LOCK_TTL_SECONDS,
        }

    async def close(self):
        """Close Redis connection."""
        if self._redis:
            await self._redis.close()
            self._connected = False


# ── Module-level singleton ──────────────────────────────────────────────────
def get_state_manager() -> StateManager:
    return StateManager.get_instance()
