# market_correlator.py - Lead-Lag Altcoin Rotation Module
#
# Monitors "Lead" assets (BTC/ETH/SOL) to predict "Lag" moves in ecosystem alts.
# If a Lead asset moves >2% in <10 mins, increase conviction_score for related
# ecosystem tokens by 1.5x for the next 4 hours.

import os
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import requests

# ── Config ──────────────────────────────────────────────────────────────────
LEAD_MOVE_THRESHOLD_PCT = float(os.getenv("LEAD_MOVE_THRESHOLD_PCT", 2.0))
LEAD_WINDOW_SECONDS = int(os.getenv("LEAD_WINDOW_SECONDS", 600))  # 10 minutes
CONVICTION_BOOST_FACTOR = float(os.getenv("CONVICTION_BOOST_FACTOR", 1.5))
BOOST_DURATION_SECONDS = int(os.getenv("BOOST_DURATION_SECONDS", 14400))  # 4 hours
PRICE_POLL_INTERVAL_SECONDS = int(os.getenv("LEAD_LAG_POLL_SECONDS", 30))
API_TIMEOUT_SECONDS = float(os.getenv("API_TIMEOUT_SECONDS", 10))

# CoinGecko IDs → ecosystem mapping
LEAD_ASSETS: Dict[str, str] = {
    "bitcoin": "BTC",
    "ethereum": "ETH",
    "solana": "SOL",
}

# Which ecosystem tokens benefit from which lead asset moves
ECOSYSTEM_MAP: Dict[str, List[str]] = {
    "BTC": ["ordinals", "stx", "rune"],    # BTC ecosystem alts
    "ETH": ["arb", "op", "matic", "ldo"],   # ETH L2/DeFi ecosystem
    "SOL": ["jto", "jup", "orca", "raydium", "tensor", "marinade"],  # SOL ecosystem
}


class PriceSnapshot:
    __slots__ = ("price", "timestamp")

    def __init__(self, price: float, timestamp: float) -> None:
        self.price = price
        self.timestamp = timestamp


class ConvictionBoost:
    __slots__ = ("factor", "expires_at", "reason")

    def __init__(self, factor: float, expires_at: float, reason: str) -> None:
        self.factor = factor
        self.expires_at = expires_at
        self.reason = reason


class MarketCorrelator:
    """
    Tracks lead-asset price movements and emits conviction boosts for
    correlated ecosystem tokens.
    """

    def __init__(self) -> None:
        self._price_history: Dict[str, List[PriceSnapshot]] = {
            symbol: [] for symbol in LEAD_ASSETS.values()
        }
        self._active_boosts: Dict[str, ConvictionBoost] = {}  # ecosystem_key → boost
        self._lock = threading.Lock()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._rejection_log: List[Dict[str, Any]] = []

    # ── Public API ──────────────────────────────────────────────────────────

    def start(self) -> None:
        """Start background price polling thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._poll_loop, daemon=True, name="market-correlator")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def get_conviction_multiplier(self, token_symbol: str) -> Tuple[float, str]:
        """
        Returns (multiplier, reason) for a given token.
        If the token's ecosystem lead asset moved big recently, returns >1.0.
        """
        now = time.time()
        token_lower = token_symbol.lower().strip()

        with self._lock:
            for ecosystem_key, boost in list(self._active_boosts.items()):
                if now > boost.expires_at:
                    del self._active_boosts[ecosystem_key]
                    continue

                tokens = ECOSYSTEM_MAP.get(ecosystem_key, [])
                if token_lower in tokens:
                    return boost.factor, boost.reason

        return 1.0, "NO_LEAD_LAG_SIGNAL"

    def apply_conviction_boost(self, base_score: float, token_symbol: str) -> Tuple[float, str]:
        """
        Apply lead-lag conviction boost to a base score.
        Returns (boosted_score, reason).
        """
        multiplier, reason = self.get_conviction_multiplier(token_symbol)
        return base_score * multiplier, reason

    def get_active_boosts(self) -> Dict[str, Dict[str, Any]]:
        now = time.time()
        result = {}
        with self._lock:
            for key, boost in self._active_boosts.items():
                if now <= boost.expires_at:
                    result[key] = {
                        "factor": boost.factor,
                        "expires_in_seconds": round(boost.expires_at - now),
                        "reason": boost.reason,
                    }
        return result

    def get_lead_snapshots(self) -> Dict[str, Dict[str, Any]]:
        """Return latest price + move% for each lead asset."""
        now = time.time()
        result = {}
        with self._lock:
            for symbol, history in self._price_history.items():
                if not history:
                    result[symbol] = {"price": 0.0, "move_pct_10m": 0.0}
                    continue
                latest = history[-1]
                move_pct = self._calc_move_pct(history, now)
                result[symbol] = {
                    "price": latest.price,
                    "move_pct_10m": round(move_pct, 4),
                }
        return result

    # ── Price Fetching ──────────────────────────────────────────────────────

    def _fetch_prices(self) -> Dict[str, float]:
        """Fetch current USD prices for lead assets from CoinGecko."""
        ids_param = ",".join(LEAD_ASSETS.keys())
        try:
            resp = requests.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={"ids": ids_param, "vs_currencies": "usd"},
                timeout=API_TIMEOUT_SECONDS,
            )
            if resp.status_code != 200:
                return {}
            data = resp.json()
        except (requests.RequestException, ValueError):
            return {}

        prices: Dict[str, float] = {}
        for cg_id, symbol in LEAD_ASSETS.items():
            entry = data.get(cg_id)
            if isinstance(entry, dict):
                price = entry.get("usd", 0)
                if isinstance(price, (int, float)) and price > 0:
                    prices[symbol] = float(price)
        return prices

    def _record_prices(self, prices: Dict[str, float]) -> None:
        now = time.time()
        cutoff = now - LEAD_WINDOW_SECONDS * 3  # Keep 3x window for smoothing

        with self._lock:
            for symbol, price in prices.items():
                history = self._price_history.get(symbol)
                if history is None:
                    continue
                history.append(PriceSnapshot(price, now))
                # Trim old entries
                while history and history[0].timestamp < cutoff:
                    history.pop(0)

    def _calc_move_pct(self, history: List[PriceSnapshot], now: float) -> float:
        """Calculate % price move within the LEAD_WINDOW_SECONDS."""
        if len(history) < 2:
            return 0.0
        latest = history[-1]
        cutoff = now - LEAD_WINDOW_SECONDS
        # Find oldest price within window
        oldest_in_window = None
        for snap in history:
            if snap.timestamp >= cutoff:
                oldest_in_window = snap
                break
        if oldest_in_window is None or oldest_in_window.price <= 0:
            return 0.0
        return ((latest.price - oldest_in_window.price) / oldest_in_window.price) * 100.0

    # ── Detection Logic ─────────────────────────────────────────────────────

    def _check_for_lead_moves(self) -> None:
        now = time.time()
        with self._lock:
            for symbol, history in self._price_history.items():
                move_pct = self._calc_move_pct(history, now)
                abs_move = abs(move_pct)

                if abs_move >= LEAD_MOVE_THRESHOLD_PCT:
                    direction = "UP" if move_pct > 0 else "DOWN"
                    existing = self._active_boosts.get(symbol)

                    # Don't re-trigger if already boosted for same direction
                    if existing and now < existing.expires_at:
                        continue

                    reason = (
                        f"LEAD_LAG: {symbol} moved {move_pct:+.2f}% in {LEAD_WINDOW_SECONDS}s "
                        f"({direction}) — boosting ecosystem tokens {CONVICTION_BOOST_FACTOR}x "
                        f"for {BOOST_DURATION_SECONDS // 3600}h"
                    )
                    self._active_boosts[symbol] = ConvictionBoost(
                        factor=CONVICTION_BOOST_FACTOR,
                        expires_at=now + BOOST_DURATION_SECONDS,
                        reason=reason,
                    )
                    print(f"[CORRELATOR] {reason}")

    # ── Background Loop ─────────────────────────────────────────────────────

    def _poll_loop(self) -> None:
        while self._running:
            try:
                prices = self._fetch_prices()
                if prices:
                    self._record_prices(prices)
                    self._check_for_lead_moves()
            except Exception as exc:
                print(f"[CORRELATOR] Poll error: {exc}")
            time.sleep(PRICE_POLL_INTERVAL_SECONDS)


# Module-level singleton
_correlator: Optional[MarketCorrelator] = None


def get_correlator() -> MarketCorrelator:
    global _correlator
    if _correlator is None:
        _correlator = MarketCorrelator()
    return _correlator
