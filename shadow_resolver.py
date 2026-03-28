# shadow_resolver.py - Shadow Resolver for Backtesting / Replay Simulator
#
# Ingests historical 1-minute OHLCV data and simulates intent fills:
#   - If an intent was signed at T0 with minReturn X, the Shadow Resolver
#     "fills" the trade if the high/low of the next 60 seconds of historical
#     data satisfies the intent's price constraints.
#   - Logs simulated fills to the "backtest_results" Redis key via StateManager.
#
# All results are regime-aware and broadcast to the dashboard.

import asyncio
import os
import time
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

# ── Config ──────────────────────────────────────────────────────────────────
SHADOW_WINDOW_SECONDS = int(os.getenv("SHADOW_WINDOW_SECONDS", 60))
BACKTEST_REDIS_KEY = "backtest_results"


# ── Pydantic Models ─────────────────────────────────────────────────────────

class OHLCVBar(BaseModel):
    timestamp: float  # epoch seconds
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


class SimulatedIntent(BaseModel):
    token_ca: str
    action: str  # BUY or SELL
    amount: float
    min_return: float
    signed_at: float  # T0 epoch
    regime: str
    auction_duration_s: int = 60
    order_hash: Optional[str] = None


class BacktestResult(BaseModel):
    intent: SimulatedIntent
    filled: bool
    fill_price: Optional[float] = None
    fill_timestamp: Optional[float] = None
    bars_checked: int = 0
    best_price: Optional[float] = None
    worst_price: Optional[float] = None
    delta_bps: Optional[float] = None  # vs arrival (minReturn proxy)
    regime: str = "NORMAL"
    evaluated_at: float = Field(default_factory=time.time)


# ── Shadow Resolver ─────────────────────────────────────────────────────────

class ShadowResolver:
    """
    Replay Simulator that evaluates whether historical OHLCV data
    would have filled intents signed at specific timestamps.
    """

    _instance: Optional["ShadowResolver"] = None

    def __init__(self) -> None:
        self._results: List[BacktestResult] = []
        self._ohlcv_cache: Dict[str, List[OHLCVBar]] = {}  # token -> bars

    @classmethod
    def get_instance(cls) -> "ShadowResolver":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── OHLCV Ingestion ─────────────────────────────────────────────────

    def ingest_ohlcv(self, token_ca: str, bars: List[Dict[str, Any]]) -> int:
        """
        Ingest historical 1-minute OHLCV bars for a token.
        Bars should be dicts with: timestamp, open, high, low, close, volume.
        Returns count of bars ingested.
        """
        parsed = []
        for bar in bars:
            try:
                parsed.append(OHLCVBar(**bar))
            except Exception:
                continue
        # Sort by timestamp
        parsed.sort(key=lambda b: b.timestamp)
        self._ohlcv_cache[token_ca] = parsed
        print(
            f"[SHADOW] Ingested {len(parsed)} OHLCV bars for {token_ca}"
        )
        return len(parsed)

    # ── Core Simulation Logic ───────────────────────────────────────────

    def evaluate_intent(self, intent: SimulatedIntent) -> BacktestResult:
        """
        Evaluate whether an intent would have been filled based on
        historical OHLCV data.

        Logic:
          - BUY: intent fills if the LOW of any bar in the window is <= minReturn
                 (solver finds a price at or below the intent's acceptable price)
          - SELL: intent fills if the HIGH of any bar in the window >= minReturn
                  (solver finds a buyer at or above the intent's target)
        """
        bars = self._ohlcv_cache.get(intent.token_ca, [])
        if not bars:
            result = BacktestResult(
                intent=intent,
                filled=False,
                bars_checked=0,
                regime=intent.regime,
            )
            self._results.append(result)
            return result

        # Find bars within the auction window after T0
        t0 = intent.signed_at
        window_end = t0 + intent.auction_duration_s
        window_bars = [b for b in bars if t0 <= b.timestamp <= window_end]

        if not window_bars:
            result = BacktestResult(
                intent=intent,
                filled=False,
                bars_checked=0,
                regime=intent.regime,
            )
            self._results.append(result)
            return result

        best_price = None
        worst_price = None
        fill_price = None
        fill_timestamp = None
        filled = False

        for bar in window_bars:
            if intent.action == "BUY":
                # For BUY: we want the lowest price available
                candidate = bar.low
                if best_price is None or candidate < best_price:
                    best_price = candidate
                if worst_price is None or bar.high > worst_price:
                    worst_price = bar.high

                # Fill condition: low price satisfies minReturn constraint
                # minReturn represents the minimum acceptable output tokens
                # If the bar's low price (cost to buy) is such that we get >= minReturn
                if candidate <= intent.min_return and not filled:
                    fill_price = candidate
                    fill_timestamp = bar.timestamp
                    filled = True

            elif intent.action == "SELL":
                # For SELL: we want the highest price available
                candidate = bar.high
                if best_price is None or candidate > best_price:
                    best_price = candidate
                if worst_price is None or bar.low < worst_price:
                    worst_price = bar.low

                # Fill condition: high price satisfies minReturn constraint
                if candidate >= intent.min_return and not filled:
                    fill_price = candidate
                    fill_timestamp = bar.timestamp
                    filled = True

        # Compute delta vs arrival price (minReturn as proxy)
        delta_bps = None
        if filled and fill_price and intent.min_return > 0:
            delta_bps = round(
                ((fill_price - intent.min_return) / intent.min_return) * 10_000,
                2,
            )

        result = BacktestResult(
            intent=intent,
            filled=filled,
            fill_price=fill_price,
            fill_timestamp=fill_timestamp,
            bars_checked=len(window_bars),
            best_price=best_price,
            worst_price=worst_price,
            delta_bps=delta_bps,
            regime=intent.regime,
        )

        self._results.append(result)
        status = "FILLED" if filled else "MISSED"
        print(
            f"[SHADOW] {status}: {intent.action} {intent.token_ca} "
            f"minReturn={intent.min_return:.8f} "
            f"fill_price={fill_price or 'N/A'} "
            f"bars={len(window_bars)} "
            f"delta={delta_bps or 'N/A'}bps "
            f"regime={intent.regime}"
        )

        return result

    # ── Batch Evaluation ────────────────────────────────────────────────

    def run_backtest(
        self,
        intents: List[SimulatedIntent],
    ) -> List[BacktestResult]:
        """Evaluate a batch of intents against historical data."""
        results = []
        for intent in intents:
            result = self.evaluate_intent(intent)
            results.append(result)
        return results

    # ── Redis Storage ───────────────────────────────────────────────────

    async def store_results_to_redis(
        self, results: Optional[List[BacktestResult]] = None
    ) -> int:
        """
        Push backtest results to the 'backtest_results' Redis key
        via StateManager.
        """
        try:
            from state_manager import get_state_manager
            sm = get_state_manager()
            items = results or self._results
            stored = 0
            for r in items:
                ok = await sm.store_backtest_result(r.model_dump())
                if ok:
                    stored += 1
            print(f"[SHADOW] Stored {stored}/{len(items)} results to Redis")
            return stored
        except Exception as exc:
            print(f"[SHADOW] Redis store failed: {exc}")
            return 0

    async def broadcast_summary(self) -> None:
        """Broadcast backtest summary to dashboard."""
        summary = self.get_summary()
        try:
            from state_manager import get_state_manager
            sm = get_state_manager()
            regime = summary.get("regime_breakdown", {})
            current_regime = "NORMAL"
            try:
                from dynamic_tuner import get_tuner
                current_regime = get_tuner().get_regime()
            except Exception:
                pass
            await sm.broadcast_event(
                event_type="backtest_summary",
                data=summary,
                regime=current_regime,
            )
        except Exception as exc:
            print(f"[SHADOW] Broadcast failed: {exc}")

    # ── Stats ───────────────────────────────────────────────────────────

    def get_summary(self) -> Dict[str, Any]:
        """Aggregate backtest statistics."""
        if not self._results:
            return {"total": 0, "filled": 0, "missed": 0, "fill_rate_pct": 0.0}

        fills = [r for r in self._results if r.filled]
        misses = [r for r in self._results if not r.filled]
        deltas = [r.delta_bps for r in fills if r.delta_bps is not None]

        # Per-regime breakdown
        regime_stats: Dict[str, Dict[str, int]] = {}
        for r in self._results:
            reg = r.regime
            if reg not in regime_stats:
                regime_stats[reg] = {"total": 0, "filled": 0}
            regime_stats[reg]["total"] += 1
            if r.filled:
                regime_stats[reg]["filled"] += 1

        return {
            "total": len(self._results),
            "filled": len(fills),
            "missed": len(misses),
            "fill_rate_pct": round(len(fills) / len(self._results) * 100, 1),
            "avg_delta_bps": round(sum(deltas) / len(deltas), 2) if deltas else 0.0,
            "max_delta_bps": round(max(deltas), 2) if deltas else 0.0,
            "min_delta_bps": round(min(deltas), 2) if deltas else 0.0,
            "regime_breakdown": regime_stats,
        }

    def get_results(self, limit: int = 100) -> List[Dict[str, Any]]:
        return [r.model_dump() for r in self._results[-limit:]]

    def clear(self) -> None:
        self._results.clear()
        print("[SHADOW] Results cleared")

    def status(self) -> Dict[str, Any]:
        return {
            "cached_tokens": list(self._ohlcv_cache.keys()),
            "total_bars": sum(len(b) for b in self._ohlcv_cache.values()),
            "total_results": len(self._results),
            "window_seconds": SHADOW_WINDOW_SECONDS,
        }


# ── Module-level singleton ──────────────────────────────────────────────────
def get_shadow_resolver() -> ShadowResolver:
    return ShadowResolver.get_instance()
