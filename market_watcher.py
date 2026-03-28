# market_watcher.py - RegimeWatcher + Market Kill-Switch
#
# Monitors BTC/ETH prices to detect Black Swan events and adjust the
# DynamicTuner regime accordingly.
#
# Global Risk-Off: BTC or ETH drops >3% in 60 minutes → SAFE_MODE
#   - Doubles MIN_LIQUIDITY_SOL, triples MIN_CONVICTION
# Global Risk-On: BTC/ETH stable and volume increasing → AGGRESSIVE
#   - Lowers filters by 20%
# Neutral: Neither condition → NORMAL

import os
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import requests

from dynamic_tuner import get_tuner, MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
WATCHER_POLL_SECONDS = int(os.getenv("REGIME_POLL_SECONDS", 60))
RISK_OFF_DROP_PCT = float(os.getenv("RISK_OFF_DROP_PCT", 3.0))
RISK_OFF_WINDOW_SECONDS = int(os.getenv("RISK_OFF_WINDOW_SECONDS", 3600))  # 60 minutes
RISK_ON_STABILITY_PCT = float(os.getenv("RISK_ON_STABILITY_PCT", 1.0))  # Max move for "stable"
RISK_ON_VOLUME_INCREASE_PCT = float(os.getenv("RISK_ON_VOLUME_INCREASE_PCT", 20.0))
API_TIMEOUT_SECONDS = float(os.getenv("API_TIMEOUT_SECONDS", 10))
SAFE_MODE_COOLDOWN_SECONDS = int(os.getenv("SAFE_MODE_COOLDOWN_SECONDS", 1800))  # 30 min min hold

# Assets to watch for regime changes
REGIME_ASSETS = {
    "bitcoin": "BTC",
    "ethereum": "ETH",
}


class PricePoint:
    __slots__ = ("price", "timestamp")

    def __init__(self, price: float, timestamp: float) -> None:
        self.price = price
        self.timestamp = timestamp


class RegimeWatcher:
    """
    Background watcher that polls BTC/ETH prices and triggers regime changes
    on the DynamicTuner.

    - >3% drop in 60min on BTC or ETH → SAFE_MODE
    - Stable (< ±1%) and volume rising → AGGRESSIVE
    - Otherwise → NORMAL
    """

    def __init__(self) -> None:
        self._price_history: Dict[str, List[PricePoint]] = {
            symbol: [] for symbol in REGIME_ASSETS.values()
        }
        self._volume_history: Dict[str, List[Tuple[float, float]]] = {
            symbol: [] for symbol in REGIME_ASSETS.values()
        }  # (timestamp, volume_24h)
        self._last_regime: str = MarketRegime.NORMAL
        self._safe_mode_entered_at: float = 0.0
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    # ── Public API ──────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._poll_loop, daemon=True, name="regime-watcher"
        )
        self._thread.start()
        print("[REGIME_WATCHER] Started monitoring BTC/ETH for regime changes")

    def stop(self) -> None:
        self._running = False

    def get_status(self) -> Dict[str, Any]:
        now = time.time()
        with self._lock:
            status: Dict[str, Any] = {"regime": self._last_regime, "assets": {}}
            for symbol, history in self._price_history.items():
                if not history:
                    status["assets"][symbol] = {"price": 0, "move_pct_1h": 0}
                    continue
                latest = history[-1]
                move_pct = self._calc_move(history, now, RISK_OFF_WINDOW_SECONDS)
                status["assets"][symbol] = {
                    "price": latest.price,
                    "move_pct_1h": round(move_pct, 4),
                }
        return status

    def force_regime(self, regime: str) -> None:
        """Manual override for testing."""
        if regime in MarketRegime.ALL:
            self._last_regime = regime
            get_tuner().set_regime(regime)
            print(f"[REGIME_WATCHER] Manual override -> {regime}")

    # ── Price Fetching ──────────────────────────────────────────────────────

    def _fetch_market_data(self) -> Dict[str, Dict[str, Any]]:
        """Fetch price + volume from CoinGecko for regime assets."""
        ids_param = ",".join(REGIME_ASSETS.keys())
        try:
            resp = requests.get(
                "https://api.coingecko.com/api/v3/simple/price",
                params={
                    "ids": ids_param,
                    "vs_currencies": "usd",
                    "include_24hr_vol": "true",
                },
                timeout=API_TIMEOUT_SECONDS,
            )
            if resp.status_code != 200:
                return {}
            return resp.json()
        except (requests.RequestException, ValueError):
            return {}

    def _record_data(self, data: Dict[str, Dict[str, Any]]) -> None:
        now = time.time()
        cutoff = now - RISK_OFF_WINDOW_SECONDS * 3

        with self._lock:
            for cg_id, symbol in REGIME_ASSETS.items():
                entry = data.get(cg_id)
                if not isinstance(entry, dict):
                    continue

                price = entry.get("usd", 0)
                vol = entry.get("usd_24h_vol", 0)

                if isinstance(price, (int, float)) and price > 0:
                    history = self._price_history[symbol]
                    history.append(PricePoint(float(price), now))
                    while history and history[0].timestamp < cutoff:
                        history.pop(0)

                if isinstance(vol, (int, float)) and vol > 0:
                    vol_history = self._volume_history[symbol]
                    vol_history.append((now, float(vol)))
                    while vol_history and vol_history[0][0] < cutoff:
                        vol_history.pop(0)

    # ── Calculations ────────────────────────────────────────────────────────

    def _calc_move(
        self, history: List[PricePoint], now: float, window_seconds: int
    ) -> float:
        if len(history) < 2:
            return 0.0
        latest = history[-1]
        cutoff = now - window_seconds
        oldest_in_window = None
        for p in history:
            if p.timestamp >= cutoff:
                oldest_in_window = p
                break
        if oldest_in_window is None or oldest_in_window.price <= 0:
            return 0.0
        return ((latest.price - oldest_in_window.price) / oldest_in_window.price) * 100.0

    def _is_volume_increasing(self) -> bool:
        """Check if 24h volume for any regime asset is increasing."""
        for symbol, vol_history in self._volume_history.items():
            if len(vol_history) < 3:
                continue
            recent = vol_history[-1][1]
            older = vol_history[0][1]
            if older > 0:
                change_pct = ((recent - older) / older) * 100.0
                if change_pct > RISK_ON_VOLUME_INCREASE_PCT:
                    return True
        return False

    # ── Regime Decision ─────────────────────────────────────────────────────

    def _evaluate_regime(self) -> str:
        now = time.time()

        # If we're in SAFE_MODE, enforce minimum cooldown
        if (
            self._last_regime == MarketRegime.SAFE_MODE
            and (now - self._safe_mode_entered_at) < SAFE_MODE_COOLDOWN_SECONDS
        ):
            return MarketRegime.SAFE_MODE

        with self._lock:
            # Check for Risk-Off: any asset dropped >3% in 60min
            for symbol, history in self._price_history.items():
                move = self._calc_move(history, now, RISK_OFF_WINDOW_SECONDS)
                if move < -RISK_OFF_DROP_PCT:
                    print(
                        f"[REGIME_WATCHER] BLACK SWAN: {symbol} dropped {move:.2f}% "
                        f"in {RISK_OFF_WINDOW_SECONDS // 60}min -> SAFE_MODE"
                    )
                    return MarketRegime.SAFE_MODE

            # Check for Risk-On: all assets stable AND volume increasing
            all_stable = True
            for symbol, history in self._price_history.items():
                move = abs(self._calc_move(history, now, RISK_OFF_WINDOW_SECONDS))
                if move > RISK_ON_STABILITY_PCT:
                    all_stable = False
                    break

        if all_stable and self._is_volume_increasing():
            return MarketRegime.AGGRESSIVE

        # Check for SUPER_BULL: all assets rising >3% in 60min AND volume increasing
        with self._lock:
            all_rising = True
            for symbol, history in self._price_history.items():
                move = self._calc_move(history, now, RISK_OFF_WINDOW_SECONDS)
                if move < RISK_OFF_DROP_PCT:  # Using same threshold but positive
                    all_rising = False
                    break

        if all_rising and self._is_volume_increasing():
            return MarketRegime.SUPER_BULL

        return MarketRegime.NORMAL

    def _apply_regime(self, new_regime: str) -> None:
        old = self._last_regime
        if new_regime == old:
            return

        self._last_regime = new_regime
        if new_regime == MarketRegime.SAFE_MODE:
            self._safe_mode_entered_at = time.time()

        get_tuner().set_regime(new_regime)
        print(f"[REGIME_WATCHER] Regime transition: {old} -> {new_regime}")

    # ── Background Loop ─────────────────────────────────────────────────────

    def _poll_loop(self) -> None:
        while self._running:
            try:
                data = self._fetch_market_data()
                if data:
                    self._record_data(data)
                    regime = self._evaluate_regime()
                    self._apply_regime(regime)
            except Exception as exc:
                print(f"[REGIME_WATCHER] Error: {exc}")
            time.sleep(WATCHER_POLL_SECONDS)


# Module-level singleton
_watcher: Optional[RegimeWatcher] = None


def get_watcher() -> RegimeWatcher:
    global _watcher
    if _watcher is None:
        _watcher = RegimeWatcher()
    return _watcher
