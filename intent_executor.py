# intent_executor.py - Dutch Auction Intent Executor
#
# Regime-aware intent execution with Dutch Auction presets.
# Routes trades through a solver network (1inch Fusion / CoW style)
# instead of direct AMM swaps when conditions favour off-chain execution.
#
# Presets:
#   SAFE_MODE   -> "fast"       : 30s auction, 98% minReturn  (panic shield)
#   AGGRESSIVE  -> "auction"    : 180s auction, 99.5% minReturn (moon mission)
#   NORMAL      -> "fair"       : 60s auction, 99% minReturn  (standard)
#   STALE_EXIT  -> "stale_exit" : 30s auction, 95% minReturn  (dead-on-arrival)
#
# Price Decay Curves:
#   "exponential" — front-loads the price drop; flushes solvers faster in
#                   high-volatility memecoin dumps (default for fast exits)
#   "linear"      — steady price descent; better for longer auctions where
#                   you want solvers to have time to discover fair price
#
# Decay formula (exponential):
#   price(t) = start_price - (start_price - min_return) * (1 - e^(-k*t)) / (1 - e^(-k*T))
#   where k = decay_rate, t = elapsed, T = total duration
#   Higher k = more aggressive front-loading

import asyncio
import math
import os
import time
from typing import Any, Dict, List, Optional

import aiohttp

from dynamic_tuner import MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
RESOLVER_URL = (os.getenv("INTENT_RESOLVER_URL") or "").strip()
ARB_PRIVATE_KEY = (os.getenv("ARB_PRIVATE_KEY") or "").strip()
INTENT_API_KEY = (os.getenv("INTENT_API_KEY") or "").strip()
BROADCAST_TIMEOUT = int(os.getenv("INTENT_BROADCAST_TIMEOUT", 10))

# ── Dutch Auction Presets ───────────────────────────────────────────────────
STALE_EXIT_PRESET = "stale_exit"  # Exported for use by stale_exit_monitor

# Decay rate constants (k) for exponential curve:
#   k=3.0  → ~95% of price drop happens in first 50% of auction (aggressive)
#   k=2.0  → ~87% of price drop in first 50% (moderate)
#   k=1.0  → ~73% in first 50% (gentle)
DEFAULT_EXPONENTIAL_DECAY_RATE = float(os.getenv("INTENT_EXPONENTIAL_DECAY_RATE", 3.0))

_PRESETS: Dict[str, Dict[str, Any]] = {
    MarketRegime.SAFE_MODE: {
        "preset": "fast",
        "auction_duration_s": 30,
        "min_return_pct": 98.0,
        "decay_type": "exponential",
        "decay_rate": 3.0,
        "label": "PANIC SELL/SHIELD",
    },
    MarketRegime.AGGRESSIVE: {
        "preset": "auction",
        "auction_duration_s": 180,
        "min_return_pct": 99.5,
        "decay_type": "linear",
        "decay_rate": 1.0,
        "label": "MOON MISSION",
    },
    MarketRegime.NORMAL: {
        "preset": "fair",
        "auction_duration_s": 60,
        "min_return_pct": 99.0,
        "decay_type": "linear",
        "decay_rate": 1.0,
        "label": "STANDARD",
    },
    STALE_EXIT_PRESET: {
        "preset": "stale_exit",
        "auction_duration_s": 30,
        "min_return_pct": 95.0,
        "decay_type": "exponential",
        "decay_rate": 3.0,
        "label": "STALE_EXIT FAST AUCTION",
    },
}


class IntentExecutor:
    """
    Builds and broadcasts Dutch-Auction intents to a resolver network.
    Parameters auto-adjust based on the current MarketRegime.
    """

    _instance: Optional["IntentExecutor"] = None

    def __init__(self) -> None:
        self._resolver_url = RESOLVER_URL
        self._broadcast_timeout = BROADCAST_TIMEOUT

    # ── Singleton accessor ──────────────────────────────────────────────
    @classmethod
    def get_instance(cls) -> "IntentExecutor":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Public API ──────────────────────────────────────────────────────
    def get_intent_params(self, regime: str) -> Dict[str, Any]:
        """Return Dutch Auction parameters for the given regime."""
        return dict(_PRESETS.get(regime, _PRESETS[MarketRegime.NORMAL]))

    def create_onchain_intent(
        self,
        token_ca: str,
        action: str,
        amount: float,
        expected_output: float,
        regime: str,
        signed_intent: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Build a fully-formed intent payload ready for solver broadcast.
        Merges Dutch Auction parameters with EIP-712 signed data.
        """
        params = self.get_intent_params(regime)
        min_return = expected_output * (params["min_return_pct"] / 100.0)
        now = time.time()
        duration = params["auction_duration_s"]
        deadline = int(now) + duration
        decay_type = params.get("decay_type", "linear")
        decay_rate = params.get("decay_rate", DEFAULT_EXPONENTIAL_DECAY_RATE)

        # Build price decay schedule (solver-readable waypoints)
        decay_schedule = self._build_decay_schedule(
            start_price=expected_output,
            min_return=min_return,
            duration_s=duration,
            decay_type=decay_type,
            decay_rate=decay_rate,
        )

        intent: Dict[str, Any] = {
            "token": token_ca,
            "action": action,
            "amount": amount,
            "min_return": min_return,
            "deadline": deadline,
            "auction_preset": params["preset"],
            "auction_duration_s": duration,
            "decay_type": decay_type,
            "decay_rate": decay_rate,
            "decay_schedule": decay_schedule,
            "regime": regime,
            "label": params["label"],
            "created_at": now,
        }

        if signed_intent and signed_intent.get("ok"):
            intent["eip712_signature"] = signed_intent.get("signature")
            intent["eip712_message"] = signed_intent.get("message")

        return intent

    # ── Price Decay Curve ───────────────────────────────────────────────

    @staticmethod
    def _build_decay_schedule(
        start_price: float,
        min_return: float,
        duration_s: int,
        decay_type: str,
        decay_rate: float,
        num_points: int = 10,
    ) -> List[Dict[str, float]]:
        """
        Build a time → price waypoint schedule for the solver.

        Exponential decay front-loads the price drop so solvers are
        incentivised to fill quickly — critical for high-vol memecoin exits.

        Linear decay provides a steady descent for longer auctions.
        """
        schedule: List[Dict[str, float]] = []
        price_range = start_price - min_return

        for i in range(num_points + 1):
            t_frac = i / num_points  # 0.0 → 1.0
            elapsed_s = round(t_frac * duration_s, 1)

            if decay_type == "exponential" and decay_rate > 0:
                # Exponential: price(t) drops fast early, slows near floor
                # Normalised so that at t_frac=1.0, decay_frac=1.0
                k = decay_rate
                denominator = 1.0 - math.exp(-k)
                if abs(denominator) < 1e-12:
                    decay_frac = t_frac  # Fallback to linear
                else:
                    decay_frac = (1.0 - math.exp(-k * t_frac)) / denominator
            else:
                # Linear: steady descent
                decay_frac = t_frac

            price_at_t = start_price - (price_range * decay_frac)
            schedule.append({
                "elapsed_s": elapsed_s,
                "price": round(max(min_return, price_at_t), 8),
            })

        return schedule

    @staticmethod
    def compute_price_at_time(
        start_price: float,
        min_return: float,
        duration_s: int,
        elapsed_s: float,
        decay_type: str = "exponential",
        decay_rate: float = 3.0,
    ) -> float:
        """Compute the exact auction price at a given elapsed time."""
        if elapsed_s <= 0:
            return start_price
        if elapsed_s >= duration_s:
            return min_return

        t_frac = elapsed_s / duration_s
        price_range = start_price - min_return

        if decay_type == "exponential" and decay_rate > 0:
            k = decay_rate
            denominator = 1.0 - math.exp(-k)
            if abs(denominator) < 1e-12:
                decay_frac = t_frac
            else:
                decay_frac = (1.0 - math.exp(-k * t_frac)) / denominator
        else:
            decay_frac = t_frac

        return max(min_return, start_price - price_range * decay_frac)

    async def broadcast_intent_to_resolver(
        self, signed_intent: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Submit the signed EIP-712 intent to the solver network
        (1inch Fusion / CoW Protocol on Arbitrum).
        Returns {"ok": True/False, "order_hash": ..., "error": ...}.
        """
        if not self._resolver_url:
            return {
                "ok": False,
                "error": "INTENT_RESOLVER_URL not configured",
                "intent": signed_intent,
            }

        url = f"{self._resolver_url}/submit"
        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": INTENT_API_KEY,
        }

        try:
            timeout = aiohttp.ClientTimeout(total=self._broadcast_timeout)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, json=signed_intent, headers=headers) as resp:
                    if resp.status in (200, 201):
                        result = await resp.json()
                        order_hash = result.get("orderHash", "")
                        print(
                            f"[INTENT] Intent Accepted: orderHash={order_hash}"
                        )
                        return {
                            "ok": True,
                            "order_hash": order_hash,
                            "data": result,
                        }
                    else:
                        error_text = await resp.text()
                        print(
                            f"[INTENT] Resolver Rejected: {resp.status} - {error_text}"
                        )
                        return {
                            "ok": False,
                            "error": f"HTTP {resp.status}: {error_text}",
                            "intent": signed_intent,
                        }
        except Exception as exc:
            err_msg = str(exc) or type(exc).__name__
            print(f"[INTENT] Broadcast Critical Failure: {err_msg}")
            return {"ok": False, "error": err_msg, "intent": signed_intent}

    def status(self) -> Dict[str, Any]:
        """Return executor configuration summary."""
        return {
            "resolver_url_set": bool(self._resolver_url),
            "broadcast_timeout": self._broadcast_timeout,
            "arb_key_configured": bool(ARB_PRIVATE_KEY),
            "presets": {k: v["label"] for k, v in _PRESETS.items()},
        }


# ── Module-level singleton ──────────────────────────────────────────────────
def get_executor() -> IntentExecutor:
    return IntentExecutor.get_instance()
