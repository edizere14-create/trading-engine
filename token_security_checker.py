# token_security_checker.py - Pre-flight Security Scan for Token Contracts
#
# Multi-layer contract security verification before any BUY execution:
#   1. GoPlus API — contract-level red flags (buy/sell tax >10%, honeypot, owner manipulation)
#   2. Honeypot.is API — simulation-based sell block detection
#
# Rejection events are broadcast to the dashboard via StateManager.
# Graceful degradation: if APIs are unreachable, returns WARN (configurable fail-open/fail-closed).

import asyncio
import os
import time
from typing import Any, Dict, Optional, Tuple

import aiohttp
from pydantic import BaseModel, Field

# ── Config ──────────────────────────────────────────────────────────────────
GOPLUS_BASE_URL = os.getenv("GOPLUS_BASE_URL", "https://api.gopluslabs.io/api/v1")
HONEYPOT_IS_BASE_URL = os.getenv("HONEYPOT_IS_BASE_URL", "https://api.honeypot.is/v2")
CHAIN_ID_ARB = os.getenv("SECURITY_CHAIN_ID", "42161")  # Arbitrum One
MAX_BUY_TAX_PCT = float(os.getenv("MAX_BUY_TAX_PCT", 10.0))
MAX_SELL_TAX_PCT = float(os.getenv("MAX_SELL_TAX_PCT", 10.0))
API_TIMEOUT_SECONDS = float(os.getenv("SECURITY_API_TIMEOUT", 8))
FAIL_OPEN = os.getenv("SECURITY_FAIL_OPEN", "false").lower() == "true"


# ── Pydantic Models ─────────────────────────────────────────────────────────

class GoPlusResult(BaseModel):
    """Parsed result from GoPlus token_security endpoint."""
    is_honeypot: bool = False
    buy_tax_pct: float = 0.0
    sell_tax_pct: float = 0.0
    is_open_source: bool = True
    is_proxy: bool = False
    can_take_back_ownership: bool = False
    owner_change_balance: bool = False
    hidden_owner: bool = False
    selfdestruct: bool = False
    external_call: bool = False
    raw: Dict[str, Any] = Field(default_factory=dict)


class HoneypotResult(BaseModel):
    """Parsed result from Honeypot.is simulation."""
    is_honeypot: bool = False
    simulate_success: bool = True
    buy_tax_pct: float = 0.0
    sell_tax_pct: float = 0.0
    reason: str = ""
    raw: Dict[str, Any] = Field(default_factory=dict)


class SecurityVerdict(BaseModel):
    """Final security verdict for a token address."""
    token_address: str
    passed: bool
    risk_level: str = "LOW"  # LOW, MEDIUM, HIGH, CRITICAL
    rejection_reasons: list = Field(default_factory=list)
    goplus: Optional[GoPlusResult] = None
    honeypot: Optional[HoneypotResult] = None
    checked_at: float = Field(default_factory=time.time)
    duration_ms: float = 0.0


# ── Security Checker ────────────────────────────────────────────────────────

class TokenSecurityChecker:
    """
    Pre-flight security scanner for token contracts.
    Queries GoPlus + Honeypot.is before allowing BUY execution.
    """

    _instance: Optional["TokenSecurityChecker"] = None

    def __init__(self) -> None:
        self._cache: Dict[str, SecurityVerdict] = {}
        self._cache_ttl = int(os.getenv("SECURITY_CACHE_TTL", 300))  # 5 min

    @classmethod
    def get_instance(cls) -> "TokenSecurityChecker":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Public API ──────────────────────────────────────────────────────

    async def scan_token(self, token_address: str) -> SecurityVerdict:
        """
        Run full security scan on a token address.
        Returns SecurityVerdict with pass/fail and risk level.
        """
        start = time.time()

        # Check cache
        cached = self._cache.get(token_address)
        if cached and (time.time() - cached.checked_at) < self._cache_ttl:
            return cached

        reasons: list = []
        risk_level = "LOW"

        # Run GoPlus and Honeypot.is checks in parallel
        goplus_result, honeypot_result = await asyncio.gather(
            self._check_goplus(token_address),
            self._check_honeypot_is(token_address),
            return_exceptions=True,
        )

        # Handle GoPlus failures
        if isinstance(goplus_result, Exception):
            print(f"[SECURITY] GoPlus API error: {goplus_result}")
            goplus_result = None
            if not FAIL_OPEN:
                reasons.append(f"goplus_api_unreachable: {goplus_result}")
                risk_level = "HIGH"

        # Handle Honeypot.is failures
        if isinstance(honeypot_result, Exception):
            print(f"[SECURITY] Honeypot.is API error: {honeypot_result}")
            honeypot_result = None
            if not FAIL_OPEN:
                reasons.append(f"honeypot_api_unreachable: {honeypot_result}")
                risk_level = "HIGH"

        # ── Evaluate GoPlus ──
        if isinstance(goplus_result, GoPlusResult):
            if goplus_result.is_honeypot:
                reasons.append("goplus_honeypot_detected")
                risk_level = "CRITICAL"

            if goplus_result.buy_tax_pct > MAX_BUY_TAX_PCT:
                reasons.append(f"buy_tax={goplus_result.buy_tax_pct:.1f}%>{MAX_BUY_TAX_PCT}%")
                risk_level = max(risk_level, "HIGH", key=_risk_ord)

            if goplus_result.sell_tax_pct > MAX_SELL_TAX_PCT:
                reasons.append(f"sell_tax={goplus_result.sell_tax_pct:.1f}%>{MAX_SELL_TAX_PCT}%")
                risk_level = max(risk_level, "HIGH", key=_risk_ord)

            if goplus_result.can_take_back_ownership:
                reasons.append("owner_can_reclaim_ownership")
                risk_level = max(risk_level, "HIGH", key=_risk_ord)

            if goplus_result.owner_change_balance:
                reasons.append("owner_can_modify_balances")
                risk_level = max(risk_level, "CRITICAL", key=_risk_ord)

            if goplus_result.hidden_owner:
                reasons.append("hidden_owner_detected")
                risk_level = max(risk_level, "MEDIUM", key=_risk_ord)

            if goplus_result.selfdestruct:
                reasons.append("selfdestruct_capability")
                risk_level = max(risk_level, "CRITICAL", key=_risk_ord)

            if goplus_result.external_call:
                reasons.append("external_call_risk")
                risk_level = max(risk_level, "MEDIUM", key=_risk_ord)

        # ── Evaluate Honeypot.is ──
        if isinstance(honeypot_result, HoneypotResult):
            if honeypot_result.is_honeypot:
                reasons.append(f"honeypot_is_confirmed: {honeypot_result.reason}")
                risk_level = "CRITICAL"

            if not honeypot_result.simulate_success:
                reasons.append("honeypot_simulation_failed")
                risk_level = max(risk_level, "HIGH", key=_risk_ord)

            if honeypot_result.sell_tax_pct > MAX_SELL_TAX_PCT:
                reasons.append(
                    f"honeypot_sell_tax={honeypot_result.sell_tax_pct:.1f}%>{MAX_SELL_TAX_PCT}%"
                )
                risk_level = max(risk_level, "HIGH", key=_risk_ord)

        # ── Build Verdict ──
        passed = len(reasons) == 0
        duration_ms = (time.time() - start) * 1000

        verdict = SecurityVerdict(
            token_address=token_address,
            passed=passed,
            risk_level=risk_level,
            rejection_reasons=reasons,
            goplus=goplus_result if isinstance(goplus_result, GoPlusResult) else None,
            honeypot=honeypot_result if isinstance(honeypot_result, HoneypotResult) else None,
            checked_at=time.time(),
            duration_ms=round(duration_ms, 2),
        )

        # Cache the result
        self._cache[token_address] = verdict

        if not passed:
            print(
                f"[SECURITY] REJECTED {token_address}: "
                f"risk={risk_level} reasons={reasons} ({duration_ms:.0f}ms)"
            )
        else:
            print(
                f"[SECURITY] PASSED {token_address}: "
                f"risk={risk_level} ({duration_ms:.0f}ms)"
            )

        return verdict

    def clear_cache(self) -> None:
        self._cache.clear()

    # ── GoPlus API ──────────────────────────────────────────────────────

    async def _check_goplus(self, token_address: str) -> GoPlusResult:
        """Query GoPlus token_security endpoint for contract red flags."""
        url = f"{GOPLUS_BASE_URL}/token_security/{CHAIN_ID_ARB}"
        params = {"contract_addresses": token_address}

        timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, params=params) as resp:
                resp.raise_for_status()
                data = await resp.json()

        result_data = data.get("result", {}).get(token_address.lower(), {})

        return GoPlusResult(
            is_honeypot=result_data.get("is_honeypot") == "1",
            buy_tax_pct=_safe_pct(result_data.get("buy_tax", "0")),
            sell_tax_pct=_safe_pct(result_data.get("sell_tax", "0")),
            is_open_source=result_data.get("is_open_source") == "1",
            is_proxy=result_data.get("is_proxy") == "1",
            can_take_back_ownership=result_data.get("can_take_back_ownership") == "1",
            owner_change_balance=result_data.get("owner_change_balance") == "1",
            hidden_owner=result_data.get("hidden_owner") == "1",
            selfdestruct=result_data.get("selfdestruct") == "1",
            external_call=result_data.get("external_call") == "1",
            raw=result_data,
        )

    # ── Honeypot.is API ─────────────────────────────────────────────────

    async def _check_honeypot_is(self, token_address: str) -> HoneypotResult:
        """Query Honeypot.is simulation endpoint for sell block detection."""
        url = f"{HONEYPOT_IS_BASE_URL}/IsHoneypot"
        params = {"address": token_address, "chainID": CHAIN_ID_ARB}

        timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, params=params) as resp:
                resp.raise_for_status()
                data = await resp.json()

        honeypot_data = data.get("honeypotResult", {})
        simulation = data.get("simulationResult", {})

        return HoneypotResult(
            is_honeypot=honeypot_data.get("isHoneypot", False),
            simulate_success=data.get("simulationSuccess", True),
            buy_tax_pct=_safe_pct(simulation.get("buyTax", 0)),
            sell_tax_pct=_safe_pct(simulation.get("sellTax", 0)),
            reason=honeypot_data.get("honeypotReason", ""),
            raw=data,
        )


# ── Helpers ─────────────────────────────────────────────────────────────────

_RISK_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}


def _risk_ord(level: str) -> int:
    return _RISK_ORDER.get(level, 0)


def _safe_pct(value: Any) -> float:
    """Convert a GoPlus/Honeypot tax value (string or float, 0-1 or 0-100) to percentage."""
    try:
        v = float(value)
        # GoPlus returns tax as 0.0-1.0 decimal, Honeypot.is returns 0-100
        if 0 < v <= 1:
            return round(v * 100, 2)
        return round(v, 2)
    except (TypeError, ValueError):
        return 0.0


# ── Singleton ───────────────────────────────────────────────────────────────

def get_security_checker() -> TokenSecurityChecker:
    return TokenSecurityChecker.get_instance()
