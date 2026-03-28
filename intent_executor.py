# intent_executor.py - Dutch Auction Intent Executor
#
# Regime-aware intent execution with Dutch Auction presets.
# Routes trades through a solver network (1inch Fusion / CoW style)
# instead of direct AMM swaps when conditions favour off-chain execution.
#
# Presets:
#   SAFE_MODE  -> "fast"    : 30s auction, 98% minReturn  (panic shield)
#   AGGRESSIVE -> "auction" : 180s auction, 99.5% minReturn (moon mission)
#   NORMAL     -> "fair"    : 60s auction, 99% minReturn  (standard)

import asyncio
import os
import time
from typing import Any, Dict, Optional

import aiohttp

from dynamic_tuner import MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
RESOLVER_URL = (os.getenv("INTENT_RESOLVER_URL") or "").strip()
ARB_PRIVATE_KEY = (os.getenv("ARB_PRIVATE_KEY") or "").strip()
INTENT_API_KEY = (os.getenv("INTENT_API_KEY") or "").strip()
BROADCAST_TIMEOUT = int(os.getenv("INTENT_BROADCAST_TIMEOUT", 10))

# ── Dutch Auction Presets ───────────────────────────────────────────────────
STALE_EXIT_PRESET = "stale_exit"  # Exported for use by stale_exit_monitor

_PRESETS: Dict[str, Dict[str, Any]] = {
    MarketRegime.SAFE_MODE: {
        "preset": "fast",
        "auction_duration_s": 30,
        "min_return_pct": 98.0,
        "label": "PANIC SELL/SHIELD",
    },
    MarketRegime.AGGRESSIVE: {
        "preset": "auction",
        "auction_duration_s": 180,
        "min_return_pct": 99.5,
        "label": "MOON MISSION",
    },
    MarketRegime.NORMAL: {
        "preset": "fair",
        "auction_duration_s": 60,
        "min_return_pct": 99.0,
        "label": "STANDARD",
    },
    STALE_EXIT_PRESET: {
        "preset": "stale_exit",
        "auction_duration_s": 30,
        "min_return_pct": 95.0,
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
        deadline = int(time.time()) + params["auction_duration_s"]

        intent: Dict[str, Any] = {
            "token": token_ca,
            "action": action,
            "amount": amount,
            "min_return": min_return,
            "deadline": deadline,
            "auction_preset": params["preset"],
            "auction_duration_s": params["auction_duration_s"],
            "regime": regime,
            "label": params["label"],
            "created_at": time.time(),
        }

        if signed_intent and signed_intent.get("ok"):
            intent["eip712_signature"] = signed_intent.get("signature")
            intent["eip712_message"] = signed_intent.get("message")

        return intent

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
