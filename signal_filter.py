# signal_filter.py - The Anti-Rekt Module
#
# Five gates:
#   1. LIQUIDITY        — reject pools below min SOL
#   2. CONVICTION       — reject "pocket change" swaps
#   3. STALE_DATA       — reject old signals
#   4. BUY_TAX          — reject tokens with >1% buy tax
#   5. MIGRATION        — bonding-curve graduation fast-path
#
# All thresholds are dynamically overridden by DynamicTuner when available.

import os
import time
from typing import Any, Dict, List, Optional, Tuple

# ── Static Defaults (overridden at runtime by DynamicTuner) ─────────────────
MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL", 25.0))
MIN_SMART_WALLET_SIZE = float(os.getenv("MIN_SMART_WALLET_SIZE", 1.5))
MAX_LATENCY_MS = int(os.getenv("MAX_SIGNAL_LATENCY_MS", 800))
MAX_BUY_TAX_PCT = float(os.getenv("MAX_BUY_TAX_PCT", 1.0))

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

    return True, "VALID_ALPHA"
