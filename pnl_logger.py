# pnl_logger.py - Execution Quality (PnL) Logger
#
# Captures Arrival Price (standard AMM quote) before intent signing,
# then computes the Execution Welfare delta on fill:
#   delta_bps = ((Fill Price - Arrival Price) / Arrival Price) * 10000
#
# Positive delta = intent fill beat the AMM (Intent Value-Add).
# Negative delta = intent fill was worse than direct AMM swap.
#
# Broadcasts delta to dashboard via StateManager (Redis Pub/Sub).
# All entries are regime-aware.

import asyncio
import os
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ── Config ──────────────────────────────────────────────────────────────────
MAX_LOG_SIZE = int(os.getenv("PNL_LOG_MAX_SIZE", 1000))


# ── Pydantic Models ─────────────────────────────────────────────────────────

class ArrivalSnapshot(BaseModel):
    token_ca: str
    action: str
    arrival_price: float  # AMM quote price before signing
    amount: float
    regime: str
    captured_at: float = Field(default_factory=time.time)
    order_hash: Optional[str] = None


class FillRecord(BaseModel):
    token_ca: str
    action: str
    arrival_price: float
    fill_price: float
    delta_bps: float  # (Fill - Arrival) / Arrival * 10000
    amount: float
    regime: str
    order_hash: Optional[str] = None
    captured_at: float  # when arrival was captured
    filled_at: float = Field(default_factory=time.time)
    intent_value_add: bool = False  # True if delta > 0 (beat AMM)


# ── PnL Logger ──────────────────────────────────────────────────────────────

class PnLLogger:
    """
    Tracks arrival prices before intent signing and computes
    execution quality (delta in basis points) on fill confirmation.
    """

    _instance: Optional["PnLLogger"] = None

    def __init__(self) -> None:
        self._pending: Dict[str, ArrivalSnapshot] = {}  # order_hash -> snapshot
        self._fills: List[FillRecord] = []

    @classmethod
    def get_instance(cls) -> "PnLLogger":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Capture Arrival Price ───────────────────────────────────────────

    def capture_arrival(
        self,
        token_ca: str,
        action: str,
        arrival_price: float,
        amount: float,
        regime: str,
        order_hash: Optional[str] = None,
    ) -> ArrivalSnapshot:
        """
        Record the AMM quote price immediately before intent signing.
        Called by IntentExecutor before broadcasting to solver.
        """
        snapshot = ArrivalSnapshot(
            token_ca=token_ca,
            action=action,
            arrival_price=arrival_price,
            amount=amount,
            regime=regime,
            order_hash=order_hash,
        )

        key = order_hash or f"{token_ca}:{action}:{time.time()}"
        self._pending[key] = snapshot
        print(
            f"[PNL] Arrival captured: {action} {token_ca} "
            f"price={arrival_price:.8f} regime={regime}"
        )
        return snapshot

    # ── Record Fill ─────────────────────────────────────────────────────

    def record_fill(
        self,
        order_hash: str,
        fill_price: float,
        token_ca: Optional[str] = None,
        action: Optional[str] = None,
    ) -> Optional[FillRecord]:
        """
        On fill confirmation, compute the execution quality delta.
        Returns FillRecord or None if no matching arrival snapshot.
        """
        snapshot = self._pending.pop(order_hash, None)

        # Fallback: search by token_ca + action if order_hash not found
        if snapshot is None and token_ca and action:
            for key, s in list(self._pending.items()):
                if s.token_ca == token_ca and s.action == action:
                    snapshot = self._pending.pop(key)
                    break

        if snapshot is None:
            print(f"[PNL] No arrival snapshot for order_hash={order_hash}")
            return None

        if snapshot.arrival_price <= 0:
            print(f"[PNL] Invalid arrival price for {order_hash}")
            return None

        delta_bps = ((fill_price - snapshot.arrival_price) / snapshot.arrival_price) * 10_000

        record = FillRecord(
            token_ca=snapshot.token_ca,
            action=snapshot.action,
            arrival_price=snapshot.arrival_price,
            fill_price=fill_price,
            delta_bps=round(delta_bps, 2),
            amount=snapshot.amount,
            regime=snapshot.regime,
            order_hash=order_hash,
            captured_at=snapshot.captured_at,
            intent_value_add=delta_bps > 0,
        )

        self._fills.append(record)
        if len(self._fills) > MAX_LOG_SIZE:
            self._fills = self._fills[-MAX_LOG_SIZE:]

        direction = "BETTER" if record.intent_value_add else "WORSE"
        print(
            f"[PNL] Fill recorded: {snapshot.action} {snapshot.token_ca} "
            f"arrival={snapshot.arrival_price:.8f} fill={fill_price:.8f} "
            f"delta={record.delta_bps:+.2f}bps ({direction} than AMM) "
            f"regime={snapshot.regime}"
        )

        # Broadcast to dashboard via StateManager
        self._broadcast_fill(record)
        return record

    def _broadcast_fill(self, record: FillRecord) -> None:
        """Async broadcast of fill data to Redis/WebSocket dashboard."""
        try:
            from state_manager import get_state_manager
            sm = get_state_manager()
            asyncio.get_event_loop().create_task(
                sm.broadcast_event(
                    event_type="pnl_fill",
                    data=record.model_dump(),
                    regime=record.regime,
                )
            )
        except RuntimeError:
            # No running event loop — fire and forget via new loop
            try:
                from state_manager import get_state_manager
                sm = get_state_manager()
                asyncio.run(
                    sm.broadcast_event(
                        event_type="pnl_fill",
                        data=record.model_dump(),
                        regime=record.regime,
                    )
                )
            except Exception as exc:
                print(f"[PNL] Broadcast failed (no loop): {exc}")
        except Exception as exc:
            print(f"[PNL] Broadcast failed: {exc}")

    # ── Stats / Query ───────────────────────────────────────────────────

    def get_recent_fills(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Return recent fill records as dicts."""
        return [f.model_dump() for f in self._fills[-limit:]]

    def get_summary(self) -> Dict[str, Any]:
        """Aggregate execution quality stats."""
        if not self._fills:
            return {
                "total_fills": 0,
                "avg_delta_bps": 0.0,
                "intent_value_adds": 0,
                "intent_worse": 0,
                "pending_arrivals": len(self._pending),
            }

        deltas = [f.delta_bps for f in self._fills]
        value_adds = sum(1 for d in deltas if d > 0)
        return {
            "total_fills": len(self._fills),
            "avg_delta_bps": round(sum(deltas) / len(deltas), 2),
            "max_delta_bps": round(max(deltas), 2),
            "min_delta_bps": round(min(deltas), 2),
            "intent_value_adds": value_adds,
            "intent_worse": len(deltas) - value_adds,
            "win_rate_pct": round(value_adds / len(deltas) * 100, 1),
            "pending_arrivals": len(self._pending),
        }

    def get_pending_count(self) -> int:
        return len(self._pending)

    def status(self) -> Dict[str, Any]:
        return {
            "total_fills": len(self._fills),
            "pending_arrivals": len(self._pending),
            "max_log_size": MAX_LOG_SIZE,
        }


# ── Module-level singleton ──────────────────────────────────────────────────
def get_pnl_logger() -> PnLLogger:
    return PnLLogger.get_instance()
