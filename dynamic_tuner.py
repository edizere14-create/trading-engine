# dynamic_tuner.py - Adaptive Parameter Tuning + Market Regime Detection
#
# Modifies signal_filter.py constants (MIN_LIQUIDITY_SOL, MIN_SMART_WALLET_SIZE,
# MAX_LATENCY_MS) based on rejection_history, performance_history (PnL), and
# the current market regime from the RegimeWatcher.

import os
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

# ── Config ──────────────────────────────────────────────────────────────────
TUNER_CYCLE_SECONDS = int(os.getenv("TUNER_CYCLE_SECONDS", 300))  # 5 min
MAX_HISTORY_SIZE = int(os.getenv("TUNER_MAX_HISTORY", 500))

# Base values — these are the "normal" settings
BASE_MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL", 25.0))
BASE_MIN_CONVICTION_SOL = float(os.getenv("MIN_SMART_WALLET_SIZE", 1.5))
BASE_MAX_LATENCY_MS = int(os.getenv("MAX_SIGNAL_LATENCY_MS", 800))


class MarketRegime:
    SAFE_MODE = "SAFE_MODE"          # Risk-off: doubled liquidity, tripled conviction
    NORMAL = "NORMAL"                # Default parameters
    AGGRESSIVE = "AGGRESSIVE"        # Risk-on: filters lowered 20%
    SUPER_BULL = "SUPER_BULL"        # Extreme risk-on: filters relaxed significantly

    ALL = (SAFE_MODE, NORMAL, AGGRESSIVE, SUPER_BULL)


class RejectionRecord:
    __slots__ = ("timestamp", "gate", "token_ca", "details", "regime")

    def __init__(
        self, timestamp: float, gate: str, token_ca: str, details: str, regime: str
    ) -> None:
        self.timestamp = timestamp
        self.gate = gate
        self.token_ca = token_ca
        self.details = details
        self.regime = regime


class PerformanceRecord:
    __slots__ = ("timestamp", "token_ca", "pnl_sol", "pnl_usd", "hold_time_seconds", "regime")

    def __init__(
        self,
        timestamp: float,
        token_ca: str,
        pnl_sol: float,
        pnl_usd: float,
        hold_time_seconds: float,
        regime: str,
    ) -> None:
        self.timestamp = timestamp
        self.token_ca = token_ca
        self.pnl_sol = pnl_sol
        self.pnl_usd = pnl_usd
        self.hold_time_seconds = hold_time_seconds
        self.regime = regime


class TunedParameters:
    """Immutable snapshot of the current tuned filter values."""

    __slots__ = (
        "min_liquidity_sol",
        "min_conviction_sol",
        "max_latency_ms",
        "regime",
        "tuned_at",
        "reason",
    )

    def __init__(
        self,
        min_liquidity_sol: float,
        min_conviction_sol: float,
        max_latency_ms: int,
        regime: str,
        reason: str,
    ) -> None:
        self.min_liquidity_sol = min_liquidity_sol
        self.min_conviction_sol = min_conviction_sol
        self.max_latency_ms = max_latency_ms
        self.regime = regime
        self.tuned_at = time.time()
        self.reason = reason

    def to_dict(self) -> Dict[str, Any]:
        return {
            "min_liquidity_sol": self.min_liquidity_sol,
            "min_conviction_sol": self.min_conviction_sol,
            "max_latency_ms": self.max_latency_ms,
            "regime": self.regime,
            "tuned_at": self.tuned_at,
            "reason": self.reason,
        }


class DynamicTuner:
    """
    Adapts signal filter thresholds based on:
    1. Market regime (from RegimeWatcher → SAFE / NORMAL / AGGRESSIVE)
    2. Rejection history (if too many good signals rejected, loosen filters)
    3. Performance history (if winning trades cluster at certain params, tune toward them)
    """

    def __init__(self) -> None:
        self._regime: str = MarketRegime.NORMAL
        self._rejection_history: List[RejectionRecord] = []
        self._performance_history: List[PerformanceRecord] = []
        self._lock = threading.RLock()
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._current_params: TunedParameters = self._compute_params()

    # ── Regime Control ──────────────────────────────────────────────────────

    def set_regime(self, regime: str) -> None:
        if regime not in MarketRegime.ALL:
            return
        with self._lock:
            old = self._regime
            self._regime = regime
            if old != regime:
                self._current_params = self._compute_params()
                print(f"[TUNER] Regime changed: {old} -> {regime} | {self._current_params.reason}")

    def get_regime(self) -> str:
        return self._regime

    # ── Data Recording ──────────────────────────────────────────────────────

    def record_rejection(self, gate: str, token_ca: str, details: str) -> None:
        record = RejectionRecord(
            timestamp=time.time(),
            gate=gate,
            token_ca=token_ca,
            details=details,
            regime=self._regime,
        )
        with self._lock:
            self._rejection_history.append(record)
            if len(self._rejection_history) > MAX_HISTORY_SIZE:
                self._rejection_history = self._rejection_history[-MAX_HISTORY_SIZE:]

    def record_performance(
        self, token_ca: str, pnl_sol: float, pnl_usd: float, hold_time_seconds: float
    ) -> None:
        record = PerformanceRecord(
            timestamp=time.time(),
            token_ca=token_ca,
            pnl_sol=pnl_sol,
            pnl_usd=pnl_usd,
            hold_time_seconds=hold_time_seconds,
            regime=self._regime,
        )
        with self._lock:
            self._performance_history.append(record)
            if len(self._performance_history) > MAX_HISTORY_SIZE:
                self._performance_history = self._performance_history[-MAX_HISTORY_SIZE:]

    # ── Parameter Access ────────────────────────────────────────────────────

    def get_params(self) -> TunedParameters:
        return self._current_params

    def get_params_dict(self) -> Dict[str, Any]:
        return self._current_params.to_dict()

    # ── Stats ───────────────────────────────────────────────────────────────

    def get_rejection_stats(self, window_seconds: int = 3600) -> Dict[str, int]:
        """Count rejections per gate in the last window."""
        cutoff = time.time() - window_seconds
        counts: Dict[str, int] = {}
        with self._lock:
            for r in self._rejection_history:
                if r.timestamp >= cutoff:
                    counts[r.gate] = counts.get(r.gate, 0) + 1
        return counts

    def get_performance_stats(self, window_seconds: int = 86400) -> Dict[str, Any]:
        """Aggregate PnL stats in the last window."""
        cutoff = time.time() - window_seconds
        total_pnl_sol = 0.0
        total_pnl_usd = 0.0
        count = 0
        winners = 0
        with self._lock:
            for p in self._performance_history:
                if p.timestamp >= cutoff:
                    total_pnl_sol += p.pnl_sol
                    total_pnl_usd += p.pnl_usd
                    count += 1
                    if p.pnl_sol > 0:
                        winners += 1
        return {
            "trades": count,
            "winners": winners,
            "win_rate": (winners / count) if count > 0 else 0.0,
            "total_pnl_sol": total_pnl_sol,
            "total_pnl_usd": total_pnl_usd,
        }

    # ── Background Auto-Tune Loop ──────────────────────────────────────────

    def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._tune_loop, daemon=True, name="dynamic-tuner")
        self._thread.start()

    def stop(self) -> None:
        self._running = False

    def _tune_loop(self) -> None:
        while self._running:
            try:
                self._auto_tune()
            except Exception as exc:
                print(f"[TUNER] Auto-tune error: {exc}")
            time.sleep(TUNER_CYCLE_SECONDS)

    def _auto_tune(self) -> None:
        """
        Re-evaluate parameters based on recent rejection and performance data.
        Regime overrides come first, then PnL-based micro-adjustments.
        """
        with self._lock:
            self._current_params = self._compute_params()

    # ── Core Parameter Computation ──────────────────────────────────────────

    def _compute_params(self) -> TunedParameters:
        regime = self._regime

        # Start from regime-based values
        if regime == MarketRegime.SAFE_MODE:
            liq = BASE_MIN_LIQUIDITY_SOL * 2.0
            conv = BASE_MIN_CONVICTION_SOL * 3.0
            lat = int(BASE_MAX_LATENCY_MS * 0.5)  # Tighter latency in safe mode
            reason = "SAFE_MODE: doubled liquidity, tripled conviction, halved latency"
        elif regime == MarketRegime.SUPER_BULL:
            liq = BASE_MIN_LIQUIDITY_SOL * 0.6
            conv = BASE_MIN_CONVICTION_SOL * 0.6
            lat = int(BASE_MAX_LATENCY_MS * 1.5)  # Most tolerant
            reason = "SUPER_BULL: filters relaxed 40%, sniper gates loosened"
        elif regime == MarketRegime.AGGRESSIVE:
            liq = BASE_MIN_LIQUIDITY_SOL * 0.8
            conv = BASE_MIN_CONVICTION_SOL * 0.8
            lat = int(BASE_MAX_LATENCY_MS * 1.2)  # Slightly more tolerant
            reason = "AGGRESSIVE: filters lowered 20%"
        else:
            liq = BASE_MIN_LIQUIDITY_SOL
            conv = BASE_MIN_CONVICTION_SOL
            lat = BASE_MAX_LATENCY_MS
            reason = "NORMAL: base parameters"

        # PnL-based micro-adjustment
        perf = self._get_recent_pnl_adjustment()
        if perf != 0.0:
            factor = 1.0 + perf
            liq *= factor
            conv *= factor
            reason += f" | PnL adj: {perf:+.2f}"

        # Rejection rate adjustment — if >80% rejection in last hour, loosen by 10%
        rej_adj = self._get_rejection_adjustment()
        if rej_adj != 0.0:
            liq *= (1.0 + rej_adj)
            conv *= (1.0 + rej_adj)
            reason += f" | Rej adj: {rej_adj:+.2f}"

        return TunedParameters(
            min_liquidity_sol=max(5.0, round(liq, 2)),
            min_conviction_sol=max(0.1, round(conv, 4)),
            max_latency_ms=max(100, lat),
            regime=regime,
            reason=reason,
        )

    def _get_recent_pnl_adjustment(self) -> float:
        """
        If recent trades are consistently losing, tighten filters (+).
        If winning streak, slightly loosen (-).
        Returns adjustment factor: -0.1 to +0.15.
        """
        if len(self._performance_history) < 5:
            return 0.0

        recent = self._performance_history[-20:]
        winners = sum(1 for p in recent if p.pnl_sol > 0)
        win_rate = winners / len(recent)

        if win_rate < 0.3:
            return 0.15   # Losing badly → tighten 15%
        elif win_rate < 0.4:
            return 0.05   # Below average → tighten 5%
        elif win_rate > 0.65:
            return -0.10  # Strong run → loosen 10%
        return 0.0

    def _get_rejection_adjustment(self) -> float:
        """
        If rejection rate is extremely high, slightly loosen to avoid
        missing all alpha. Returns negative factor for loosening.
        """
        hour_ago = time.time() - 3600
        total = 0
        with self._lock:
            for r in self._rejection_history:
                if r.timestamp >= hour_ago:
                    total += 1

        if total > 50:
            return -0.10  # Very high rejection → loosen 10%
        return 0.0


# Module-level singleton
_tuner: Optional[DynamicTuner] = None


def get_tuner() -> DynamicTuner:
    global _tuner
    if _tuner is None:
        _tuner = DynamicTuner()
    return _tuner
