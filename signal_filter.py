# signal_filter.py - The Anti-Rekt Module
#
# Eight gates:
#   1. LIQUIDITY        — reject pools below min SOL
#   2. CONVICTION       — reject "pocket change" swaps
#   3. STALE_DATA       — reject old signals
#   4. BUY_TAX          — reject tokens with >1% buy tax
#   5. MIGRATION        — bonding-curve graduation fast-path
#   6. SIGNAL_SCORE     — reject low-conviction signals (min 6.5)
#   7. TOKEN_FRESHNESS  — reject tokens older than 180s
#   8. VOLUME_VELOCITY  — reject stagnant pools (need 15% volume/liquidity)
#
# All thresholds are dynamically overridden by DynamicTuner when available.
# Gates 6-8 relax only in SUPER_BULL regime ("Sniper Mode" otherwise).

import os
import time
from typing import Any, Dict, List, Optional, Tuple

# ── Static Defaults (overridden at runtime by DynamicTuner) ─────────────────
MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL", 25.0))
MIN_SMART_WALLET_SIZE = float(os.getenv("MIN_SMART_WALLET_SIZE", 1.5))
MAX_LATENCY_MS = int(os.getenv("MAX_SIGNAL_LATENCY_MS", 800))
MAX_BUY_TAX_PCT = float(os.getenv("MAX_BUY_TAX_PCT", 1.0))

# ── High-Conviction "Sniper Mode" Gates ────────────────────────────────────
MIN_SIGNAL_SCORE = float(os.getenv("MIN_SIGNAL_SCORE", 6.5))
MIN_SIGNAL_SCORE_SUPER_BULL = float(os.getenv("MIN_SIGNAL_SCORE_SUPER_BULL", 4.5))
MAX_TOKEN_AGE_SECONDS = int(os.getenv("MAX_TOKEN_AGE_SECONDS", 180))
MAX_TOKEN_AGE_SUPER_BULL = int(os.getenv("MAX_TOKEN_AGE_SUPER_BULL", 600))
MIN_VOLUME_VELOCITY_PCT = float(os.getenv("MIN_VOLUME_VELOCITY_PCT", 15.0))
MIN_VOLUME_VELOCITY_SUPER_BULL = float(os.getenv("MIN_VOLUME_VELOCITY_SUPER_BULL", 5.0))

# Migration detection — tokens graduating from bonding curves get a fast-path
MIGRATION_LATENCY_BYPASS_MS = int(os.getenv("MIGRATION_LATENCY_BYPASS_MS", 5000))

# ── Rejection Log (consumed by DynamicTuner) ────────────────────────────────
_rejection_log: List[Dict[str, Any]] = []
MAX_REJECTION_LOG = 1000


def get_rejection_log() -> List[Dict[str, Any]]:
    return list(_rejection_log)


def clear_rejection_log() -> None:
    _rejection_log.clear()


def _log_rejection(gate: str, token_ca: str, details: str, regime: str) -> None:
    entry = {
        "timestamp": time.time(),
        "gate": gate,
        "token_ca": token_ca,
        "details": details,
        "regime": regime,
    }
    _rejection_log.append(entry)
    if len(_rejection_log) > MAX_REJECTION_LOG:
        del _rejection_log[: len(_rejection_log) - MAX_REJECTION_LOG]
    print(f"[SIGNAL_FILTER][{regime}] REJECTED @ {gate}: {details}")


def _get_tuned_params() -> Optional[Any]:
    """Lazy import to avoid circular deps. Returns TunedParameters or None."""
    try:
        from dynamic_tuner import get_tuner
        return get_tuner().get_params()
    except Exception:
        return None


def _get_current_regime() -> str:
    try:
        from dynamic_tuner import get_tuner
        return get_tuner().get_regime()
    except Exception:
        return "NORMAL"


def _record_tuner_rejection(gate: str, token_ca: str, details: str) -> None:
    """Forward rejection to DynamicTuner if available."""
    try:
        from dynamic_tuner import get_tuner
        get_tuner().record_rejection(gate, token_ca, details)
    except Exception:
        pass


# ── Migration Monitor ───────────────────────────────────────────────────────

_recent_migrations: Dict[str, float] = {}  # token_ca → detection_timestamp
MIGRATION_WINDOW_SECONDS = 60


def register_migration_event(token_ca: str) -> None:
    """
    Called when an InitialLiquidityProvision event is detected — a bonding-curve
    token graduating to a main DEX (Raydium/Uniswap).
    """
    _recent_migrations[token_ca] = time.time()
    # Prune old entries
    cutoff = time.time() - MIGRATION_WINDOW_SECONDS * 2
    stale = [k for k, v in _recent_migrations.items() if v < cutoff]
    for k in stale:
        del _recent_migrations[k]
    print(f"[SIGNAL_FILTER] Migration registered: {token_ca} (bonding curve graduation)")


def is_migration_token(token_ca: str) -> bool:
    """Check if token recently graduated from a bonding curve."""
    ts = _recent_migrations.get(token_ca)
    if ts is None:
        return False
    return (time.time() - ts) < MIGRATION_WINDOW_SECONDS


# ── Core Validation ─────────────────────────────────────────────────────────

def validate_signal(signal_data: dict) -> tuple:
    """
    Returns (True, "VALID_ALPHA") if trade is viable,
    else (False, "GATE:Reason") to prevent 0.70x losses.

    Every rejection is logged with the specific Gate and Market Regime.
    """
    token_ca = signal_data.get("tokenCA", "unknown")
    regime = _get_current_regime()

    # Load dynamically tuned params (falls back to env defaults)
    tuned = _get_tuned_params()
    min_liq = tuned.min_liquidity_sol if tuned else MIN_LIQUIDITY_SOL
    min_conv = tuned.min_conviction_sol if tuned else MIN_SMART_WALLET_SIZE
    max_lat = tuned.max_latency_ms if tuned else MAX_LATENCY_MS

    # ── Gate 5: MIGRATION — bonding-curve graduation fast-path ──────────
    is_migration = signal_data.get("is_migration", False) or is_migration_token(token_ca)
    if is_migration:
        # Still enforce liquidity, but skip stale-data check for speed
        liq = signal_data.get("liqSOL", 0)
        if liq < min_liq:
            reason = f"INSUFFICIENT_LIQUIDITY: {liq} SOL (min {min_liq}) [MIGRATION]"
            _log_rejection("LIQUIDITY", token_ca, reason, regime)
            _record_tuner_rejection("LIQUIDITY", token_ca, reason)
            return False, reason
        # Bypass latency check entirely for migration tokens
        return True, "VALID_ALPHA:MIGRATION_FASTPATH"

    # ── Gate 1: LIQUIDITY FILTER ────────────────────────────────────────
    liq = signal_data.get("liqSOL", 0)
    if liq < min_liq:
        reason = f"INSUFFICIENT_LIQUIDITY: {liq} SOL (min {min_liq})"
        _log_rejection("LIQUIDITY", token_ca, reason, regime)
        _record_tuner_rejection("LIQUIDITY", token_ca, reason)
        return False, reason

    # ── Gate 2: CONVICTION FILTER ───────────────────────────────────────
    amount = signal_data.get("amountSOL", 0)
    if amount < min_conv:
        reason = f"LOW_CONVICTION_SWAP: {amount} SOL (min {min_conv})"
        _log_rejection("CONVICTION", token_ca, reason, regime)
        _record_tuner_rejection("CONVICTION", token_ca, reason)
        return False, reason

    # ── Gate 3: STALE DATA FILTER ───────────────────────────────────────
    latency = signal_data.get("latency_ms", 0)
    if latency > max_lat:
        reason = f"STALE_SIGNAL_LATENCY: {latency}ms (max {max_lat}ms)"
        _log_rejection("STALE_DATA", token_ca, reason, regime)
        _record_tuner_rejection("STALE_DATA", token_ca, reason)
        return False, reason

    # ── Gate 4: BUY TAX FILTER ──────────────────────────────────────────
    buy_tax_pct = signal_data.get("buyTaxPct", 0.0)
    if buy_tax_pct > MAX_BUY_TAX_PCT:
        reason = f"HIGH_BUY_TAX: {buy_tax_pct:.2f}% (max {MAX_BUY_TAX_PCT}%)"
        _log_rejection("BUY_TAX", token_ca, reason, regime)
        _record_tuner_rejection("BUY_TAX", token_ca, reason)
        return False, reason

    # ── Sniper Mode: regime-aware threshold selection ───────────────────
    is_super_bull = regime == "SUPER_BULL"

    # ── Gate 6: SIGNAL SCORE FILTER (High-Conviction Gate) ──────────────
    signal_score = float(signal_data.get("signal_score", 0))
    score_threshold = MIN_SIGNAL_SCORE_SUPER_BULL if is_super_bull else MIN_SIGNAL_SCORE
    if signal_score < score_threshold:
        reason = (
            f"LOW_SIGNAL_SCORE: {signal_score:.2f} "
            f"(min {score_threshold:.1f}, regime={regime})"
        )
        _log_rejection("SIGNAL_SCORE", token_ca, reason, regime)
        _record_tuner_rejection("SIGNAL_SCORE", token_ca, reason)
        return False, reason

    # ── Gate 7: TOKEN FRESHNESS FILTER (First-Mover Gate) ──────────────
    token_created_at = signal_data.get("token_created_at", 0)
    if token_created_at > 0:
        token_age_seconds = time.time() - float(token_created_at)
        age_threshold = MAX_TOKEN_AGE_SUPER_BULL if is_super_bull else MAX_TOKEN_AGE_SECONDS
        if token_age_seconds > age_threshold:
            reason = (
                f"STALE_TOKEN: age={token_age_seconds:.0f}s "
                f"(max {age_threshold}s, regime={regime}) — refusing to be exit liquidity"
            )
            _log_rejection("TOKEN_FRESHNESS", token_ca, reason, regime)
            _record_tuner_rejection("TOKEN_FRESHNESS", token_ca, reason)
            return False, reason

    # ── Gate 8: VOLUME VELOCITY FILTER (Buy Momentum Gate) ─────────────
    volume_60s = float(signal_data.get("volume_60s", 0))
    if liq > 0 and volume_60s > 0:
        velocity_pct = (volume_60s / liq) * 100.0
        velocity_threshold = MIN_VOLUME_VELOCITY_SUPER_BULL if is_super_bull else MIN_VOLUME_VELOCITY_PCT
        if velocity_pct < velocity_threshold:
            reason = (
                f"LOW_VOLUME_VELOCITY: {velocity_pct:.2f}% of pool liq "
                f"(min {velocity_threshold:.1f}%, regime={regime}) — stagnant candle"
            )
            _log_rejection("VOLUME_VELOCITY", token_ca, reason, regime)
            _record_tuner_rejection("VOLUME_VELOCITY", token_ca, reason)
            return False, reason
    elif liq > 0 and volume_60s == 0:
        # No volume data available — reject unless SUPER_BULL
        if not is_super_bull:
            reason = f"NO_VOLUME_DATA: volume_60s missing (regime={regime})"
            _log_rejection("VOLUME_VELOCITY", token_ca, reason, regime)
            _record_tuner_rejection("VOLUME_VELOCITY", token_ca, reason)
            return False, reason

    return True, "VALID_ALPHA"
