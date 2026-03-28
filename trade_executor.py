import argparse
import asyncio
import base64
import json
import math
import os
import time
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests
from dotenv import load_dotenv
from signal_filter import validate_signal, register_migration_event
from dynamic_tuner import get_tuner, MarketRegime
from market_correlator import get_correlator
from intent_signer import get_signer
from intent_executor import get_executor

load_dotenv()

SOL_MINT = "So11111111111111111111111111111111111111112"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
LAMPORTS_PER_SOL = 1_000_000_000
USDC_BASE_UNITS = 1_000_000


# Config
MIN_LIQUIDITY_SOL = float(os.getenv("MIN_LIQUIDITY_SOL", 50))
MAX_TRADES_PER_DAY = int(os.getenv("MAX_TRADES_PER_DAY", 2))
MAX_CONCURRENT_POSITIONS = int(os.getenv("MAX_CONCURRENT_POSITIONS", 3))
MAX_DAILY_LOSS_PCT = float(os.getenv("MAX_DAILY_LOSS_PCT", 20))
INITIAL_CAPITAL_USD = float(os.getenv("INITIAL_CAPITAL_USD", 100))
PAPER_MODE = os.getenv("PAPER_MODE", "true").lower() == "true"
STATE_FILE = Path(os.getenv("STATE_FILE", "trade_state.json"))
TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TELEGRAM_CHAT_ID = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
HELIUS_API_KEY = (os.getenv("HELIUS_API_KEY") or "").strip()
PRIMARY_RPC = (os.getenv("PRIMARY_RPC") or "").strip()
JUPITER_QUOTE_URL = (
    os.getenv("JUPITER_QUOTE_URL", "https://lite-api.jup.ag/swap/v1/quote") or ""
).strip()
JUPITER_SWAP_URL = (
    os.getenv("JUPITER_SWAP_URL", "https://lite-api.jup.ag/swap/v1/swap") or ""
).strip()
LIQUIDITY_MAX_PRICE_IMPACT_PCT = float(os.getenv("LIQUIDITY_MAX_PRICE_IMPACT_PCT", 2.0))
SOL_USD_FALLBACK = float(os.getenv("SOL_USD_FALLBACK", 150.0))
SOL_USD_TTL_SECONDS = int(os.getenv("SOL_USD_TTL_SECONDS", 60))
API_TIMEOUT_SECONDS = float(os.getenv("API_TIMEOUT_SECONDS", 10))
JUPITER_SLIPPAGE_BPS = int(os.getenv("JUPITER_SLIPPAGE_BPS", 50))
API_MAX_RETRIES = max(1, int(os.getenv("API_MAX_RETRIES", 3)))
API_RETRY_BASE_DELAY_SECONDS = max(0.0, float(os.getenv("API_RETRY_BASE_DELAY_SECONDS", 0.3)))
CIRCUIT_BREAKER_FAILURE_THRESHOLD = max(1, int(os.getenv("CIRCUIT_BREAKER_FAILURE_THRESHOLD", 3)))
CIRCUIT_BREAKER_COOLDOWN_SECONDS = max(1.0, float(os.getenv("CIRCUIT_BREAKER_COOLDOWN_SECONDS", 30.0)))
KILL_SWITCH_MODE = (os.getenv("KILL_SWITCH_MODE", "OFF") or "OFF").strip().upper()
MAX_NOTIONAL_USD_PER_TRADE = max(0.0, float(os.getenv("MAX_NOTIONAL_USD_PER_TRADE", 100.0)))
MAX_NOTIONAL_USD_PER_DAY = max(0.0, float(os.getenv("MAX_NOTIONAL_USD_PER_DAY", 300.0)))
NOTIONAL_LIMIT_APPLIES_TO_SELLS = (
    os.getenv("NOTIONAL_LIMIT_APPLIES_TO_SELLS", "false").strip().lower() == "true"
)
REQUIRE_QUOTE_FOR_EXECUTION = (
    os.getenv("REQUIRE_QUOTE_FOR_EXECUTION", "true").strip().lower() == "true"
)
MAX_FILL_SLIPPAGE_BPS = max(0.0, float(os.getenv("MAX_FILL_SLIPPAGE_BPS", 150.0)))
MAX_EXECUTION_PRICE_IMPACT_PCT = max(
    0.0, float(os.getenv("MAX_EXECUTION_PRICE_IMPACT_PCT", 3.0))
)
PRIVATE_KEY = (os.getenv("PRIVATE_KEY") or "").strip()
LIVE_TX_SEND_RETRIES = max(1, int(os.getenv("LIVE_TX_SEND_RETRIES", 2)))
LIVE_TX_CONFIRM_TIMEOUT_SECONDS = max(
    5.0, float(os.getenv("LIVE_TX_CONFIRM_TIMEOUT_SECONDS", 45.0))
)
LIVE_TX_CONFIRM_POLL_SECONDS = max(
    0.2, float(os.getenv("LIVE_TX_CONFIRM_POLL_SECONDS", 1.0))
)
LIVE_PRIORITY_FEE_LAMPORTS = max(0, int(os.getenv("LIVE_PRIORITY_FEE_LAMPORTS", 0)))
LIVE_SKIP_PREFLIGHT = os.getenv("LIVE_SKIP_PREFLIGHT", "false").strip().lower() == "true"

# ── MEV Shield / Private RPC Config ─────────────────────────────────────────
PRIVATE_RPC_URL = (os.getenv("PRIVATE_RPC_URL") or "").strip()  # Jito/Flashbots
JITO_BUNDLE_URL = (
    os.getenv("JITO_BUNDLE_URL")
    or "https://mainnet.block-engine.jito.wtf/api/v1/bundles"
).strip()
JITO_TIP_LAMPORTS = max(0, int(os.getenv("JITO_TIP_LAMPORTS", 1_000_000)))
MEV_PROTECTION_ENABLED = os.getenv("MEV_PROTECTION_ENABLED", "true").strip().lower() == "true"
INTENT_MAX_BUY_TAX_PCT = float(os.getenv("INTENT_MAX_BUY_TAX_PCT", 1.0))
INTENT_MIN_LIQUIDITY_SOL = float(os.getenv("INTENT_MIN_LIQUIDITY_SOL", 25.0))
DYNAMIC_SLIPPAGE_ENABLED = os.getenv("DYNAMIC_SLIPPAGE_ENABLED", "true").strip().lower() == "true"
DYNAMIC_SLIPPAGE_FLOOR_BPS = max(1, int(os.getenv("DYNAMIC_SLIPPAGE_FLOOR_BPS", 30)))
DYNAMIC_SLIPPAGE_CEILING_BPS = max(1, int(os.getenv("DYNAMIC_SLIPPAGE_CEILING_BPS", 300)))

def _parse_probe_sizes(raw_value: str) -> Tuple[float, ...]:
    parsed: List[float] = []
    for chunk in raw_value.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            size = float(chunk)
        except ValueError:
            continue
        if size > 0:
            parsed.append(size)
    if not parsed:
        parsed = [0.25, 0.5, 1.0]
    return tuple(sorted(set(parsed)))


LIQUIDITY_PROBE_SIZES_SOL = _parse_probe_sizes(
    os.getenv("LIQUIDITY_PROBE_SIZES_SOL") or "0.25,0.5,1,2,5,10,20,50"
)

if PRIMARY_RPC:
    HELIUS_RPC_URL = PRIMARY_RPC
elif HELIUS_API_KEY:
    HELIUS_RPC_URL = f"https://mainnet.helius-rpc.com/?api-key={HELIUS_API_KEY}"
else:
    HELIUS_RPC_URL = ""

_PLACEHOLDER_VALUES = {
    "",
    "your_bot_token_here",
    "your_chat_id_here",
    "changeme",
    "none",
    "null",
}

_telegram_warning_printed = False
_sol_usd_cache: Dict[str, float] = {
    "price": SOL_USD_FALLBACK,
    "expires_at": 0.0,
}
_api_circuit_state: Dict[str, Dict[str, float]] = {
    "helius": {"failures": 0.0, "open_until": 0.0},
    "jupiter": {"failures": 0.0, "open_until": 0.0},
    "rpc": {"failures": 0.0, "open_until": 0.0},
}
_runtime_kill_switch_reason = ""
_live_wallet_cache: Optional[Dict[str, Any]] = None


def _validate_telegram_config() -> Tuple[bool, str]:
    token = TELEGRAM_BOT_TOKEN.lower()
    chat_id = TELEGRAM_CHAT_ID.lower()

    if token in _PLACEHOLDER_VALUES:
        return False, "TELEGRAM_BOT_TOKEN is not configured."
    if any(ch.isspace() for ch in TELEGRAM_BOT_TOKEN):
        return False, "TELEGRAM_BOT_TOKEN contains whitespace."
    if ":" not in TELEGRAM_BOT_TOKEN:
        return False, "TELEGRAM_BOT_TOKEN format looks invalid."
    if chat_id in _PLACEHOLDER_VALUES:
        return False, "TELEGRAM_CHAT_ID is not configured."

    return True, ""


TELEGRAM_ENABLED, TELEGRAM_DISABLED_REASON = _validate_telegram_config()


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _default_state() -> Dict[str, Any]:
    return {
        "last_reset_date": date.today().isoformat(),
        "trades_today": 0,
        "daily_pnl_sol": 0.0,
        "daily_pnl_usd": 0.0,
        "daily_notional_usd": 0.0,
        "open_positions": {},
    }


def _normalize_position(raw_position: Dict[str, Any]) -> Dict[str, Any]:
    token_amount = _safe_float(raw_position.get("token_amount"), 0.0)
    cost_basis_sol = _safe_float(raw_position.get("cost_basis_sol"), 0.0)
    cost_basis_usd = _safe_float(
        raw_position.get("cost_basis_usd"),
        cost_basis_sol * SOL_USD_FALLBACK,
    )

    avg_entry_sol = 0.0
    avg_entry_usd = 0.0
    if token_amount > 0:
        avg_entry_sol = cost_basis_sol / token_amount
        avg_entry_usd = cost_basis_usd / token_amount

    return {
        "token_amount": token_amount,
        "cost_basis_sol": cost_basis_sol,
        "cost_basis_usd": cost_basis_usd,
        "avg_entry_sol": avg_entry_sol,
        "avg_entry_usd": avg_entry_usd,
        "buy_count": max(1, _safe_int(raw_position.get("buy_count"), 1)),
    }


def load_state() -> Dict[str, Any]:
    if not STATE_FILE.exists():
        return _default_state()

    try:
        with STATE_FILE.open("r", encoding="utf-8") as file_handle:
            data = json.load(file_handle)
    except (OSError, json.JSONDecodeError):
        return _default_state()

    loaded = _default_state()
    loaded.update(data)
    loaded["trades_today"] = _safe_int(loaded.get("trades_today"), 0)
    loaded["daily_pnl_sol"] = _safe_float(loaded.get("daily_pnl_sol"), 0.0)
    loaded["daily_pnl_usd"] = _safe_float(
        loaded.get("daily_pnl_usd"), loaded["daily_pnl_sol"] * SOL_USD_FALLBACK
    )
    loaded["daily_notional_usd"] = _safe_float(loaded.get("daily_notional_usd"), 0.0)

    normalized_positions: Dict[str, Dict[str, Any]] = {}
    for token_ca, position in (loaded.get("open_positions", {}) or {}).items():
        normalized = _normalize_position(position)
        if normalized["token_amount"] > 0:
            normalized_positions[token_ca] = normalized

    loaded["open_positions"] = normalized_positions
    return loaded


def save_state() -> None:
    state_dir = STATE_FILE.parent
    state_dir.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(state, indent=2)

    # Windows can briefly lock files during scans/sync; retry writes a few times.
    for attempt in range(10):
        try:
            with STATE_FILE.open("w", encoding="utf-8") as file_handle:
                file_handle.write(payload)
                file_handle.flush()
                os.fsync(file_handle.fileno())
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.1 * (attempt + 1))


state = load_state()


def reset_daily_state_if_needed() -> None:
    today = date.today().isoformat()
    if state.get("last_reset_date") != today:
        state["last_reset_date"] = today
        state["trades_today"] = 0
        state["daily_pnl_sol"] = 0.0
        state["daily_pnl_usd"] = 0.0
        state["daily_notional_usd"] = 0.0
        save_state()


def _circuit_state_for(service_name: str) -> Dict[str, float]:
    return _api_circuit_state.setdefault(service_name, {"failures": 0.0, "open_until": 0.0})


def _is_circuit_open(service_name: str) -> bool:
    circuit = _circuit_state_for(service_name)
    return time.time() < circuit["open_until"]


def _record_circuit_success(service_name: str) -> None:
    circuit = _circuit_state_for(service_name)
    circuit["failures"] = 0.0
    circuit["open_until"] = 0.0


def _record_circuit_failure(service_name: str) -> None:
    circuit = _circuit_state_for(service_name)
    circuit["failures"] += 1.0
    if circuit["failures"] >= float(CIRCUIT_BREAKER_FAILURE_THRESHOLD):
        circuit["open_until"] = time.time() + CIRCUIT_BREAKER_COOLDOWN_SECONDS
        circuit["failures"] = 0.0


def _request_json(service_name: str, method: str, url: str, **kwargs: Any) -> Optional[Dict[str, Any]]:
    if _is_circuit_open(service_name):
        return None

    for attempt in range(API_MAX_RETRIES):
        try:
            response = requests.request(method, url, timeout=API_TIMEOUT_SECONDS, **kwargs)
        except requests.RequestException:
            _record_circuit_failure(service_name)
            if attempt + 1 < API_MAX_RETRIES:
                time.sleep(API_RETRY_BASE_DELAY_SECONDS * (2**attempt))
            continue

        if response.status_code != 200:
            _record_circuit_failure(service_name)
            if attempt + 1 < API_MAX_RETRIES:
                time.sleep(API_RETRY_BASE_DELAY_SECONDS * (2**attempt))
            continue

        try:
            payload = response.json()
        except ValueError:
            _record_circuit_failure(service_name)
            if attempt + 1 < API_MAX_RETRIES:
                time.sleep(API_RETRY_BASE_DELAY_SECONDS * (2**attempt))
            continue

        if isinstance(payload, dict):
            _record_circuit_success(service_name)
            return payload

        _record_circuit_failure(service_name)
        if attempt + 1 < API_MAX_RETRIES:
            time.sleep(API_RETRY_BASE_DELAY_SECONDS * (2**attempt))

    return None


def _fetch_helius_asset(token_ca: str) -> Dict[str, Any]:
    if not HELIUS_RPC_URL:
        return {}

    payload = {
        "jsonrpc": "2.0",
        "id": "trade-executor",
        "method": "getAsset",
        "params": {"id": token_ca},
    }
    response = _request_json("helius", "POST", HELIUS_RPC_URL, json=payload)
    if not response:
        return {}

    result = response.get("result")
    if not isinstance(result, dict):
        return {}
    return result


def _fetch_jupiter_quote(input_mint: str, output_mint: str, amount_raw: int) -> Optional[Dict[str, Any]]:
    if not JUPITER_QUOTE_URL:
        return None

    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount_raw),
        "slippageBps": str(JUPITER_SLIPPAGE_BPS),
        "swapMode": "ExactIn",
    }
    payload = _request_json("jupiter", "GET", JUPITER_QUOTE_URL, params=params)
    if not payload:
        return None
    if not payload.get("outAmount"):
        return None
    return payload


def _extract_route_label(quote: Dict[str, Any]) -> str:
    route_plan = quote.get("routePlan")
    if not isinstance(route_plan, list) or not route_plan:
        return ""

    first_leg = route_plan[0] if isinstance(route_plan[0], dict) else {}
    swap_info = first_leg.get("swapInfo") if isinstance(first_leg, dict) else {}
    if not isinstance(swap_info, dict):
        return ""

    label = swap_info.get("label")
    if not isinstance(label, str):
        return ""
    return label


def _extract_helius_symbol(asset: Dict[str, Any]) -> str:
    content = asset.get("content") if isinstance(asset, dict) else {}
    metadata = content.get("metadata") if isinstance(content, dict) else {}
    token_info = asset.get("token_info") if isinstance(asset, dict) else {}

    symbol = ""
    if isinstance(metadata, dict):
        symbol = str(metadata.get("symbol") or "")
    if not symbol and isinstance(token_info, dict):
        symbol = str(token_info.get("symbol") or "")

    return symbol.strip()


def _extract_helius_decimals(asset: Dict[str, Any]) -> Optional[int]:
    token_info = asset.get("token_info") if isinstance(asset, dict) else {}
    if isinstance(token_info, dict):
        decimals = token_info.get("decimals")
        if decimals is not None:
            parsed = _safe_int(decimals, -1)
            if parsed >= 0:
                return parsed
    return None


def _extract_quote_price_impact_pct(quote: Dict[str, Any]) -> float:
    return max(0.0, _safe_float(quote.get("priceImpactPct"), 0.0))


def _slippage_bps(expected_out: float, actual_out: float) -> float:
    if expected_out <= 0:
        return 0.0
    if actual_out >= expected_out:
        return 0.0
    return ((expected_out - actual_out) / expected_out) * 10_000.0


def _is_notional_limited_action(action: str) -> bool:
    return action == "BUY" or NOTIONAL_LIMIT_APPLIES_TO_SELLS


def _kill_switch_reason(action: str) -> str:
    if _runtime_kill_switch_reason:
        return _runtime_kill_switch_reason
    if KILL_SWITCH_MODE == "BLOCK_ALL":
        return "Global kill-switch active (BLOCK_ALL)"
    if KILL_SWITCH_MODE == "BLOCK_BUYS" and action == "BUY":
        return "Global kill-switch active (BLOCK_BUYS)"
    return ""


def _activate_runtime_kill_switch(reason: str) -> None:
    global _runtime_kill_switch_reason
    if _runtime_kill_switch_reason:
        return
    _runtime_kill_switch_reason = f"Runtime kill-switch active: {reason}"


def get_sol_usd_price(force_refresh: bool = False) -> float:
    now = time.time()
    cached_price = _safe_float(_sol_usd_cache.get("price"), SOL_USD_FALLBACK)
    expires_at = _safe_float(_sol_usd_cache.get("expires_at"), 0.0)

    if not force_refresh and now < expires_at:
        return cached_price

    quote = _fetch_jupiter_quote(SOL_MINT, USDC_MINT, LAMPORTS_PER_SOL)
    if quote:
        out_amount_raw = _safe_int(quote.get("outAmount"), 0)
        if out_amount_raw > 0:
            price = out_amount_raw / USDC_BASE_UNITS
            _sol_usd_cache["price"] = price
            _sol_usd_cache["expires_at"] = now + max(1, SOL_USD_TTL_SECONDS)
            return price

    _sol_usd_cache["price"] = cached_price if cached_price > 0 else SOL_USD_FALLBACK
    _sol_usd_cache["expires_at"] = now + max(1, SOL_USD_TTL_SECONDS)
    return _safe_float(_sol_usd_cache["price"], SOL_USD_FALLBACK)


def _estimate_liquidity_sol(token_ca: str) -> Tuple[float, float, str]:
    probe_results: List[Tuple[float, float, str]] = []

    for size_sol in LIQUIDITY_PROBE_SIZES_SOL:
        if size_sol <= 0:
            continue

        amount_raw = max(1, int(size_sol * LAMPORTS_PER_SOL))
        quote = _fetch_jupiter_quote(SOL_MINT, token_ca, amount_raw)
        if not quote:
            continue

        out_amount_raw = _safe_int(quote.get("outAmount"), 0)
        if out_amount_raw <= 0:
            continue

        effective_rate = out_amount_raw / amount_raw
        probe_results.append((size_sol, effective_rate, _extract_route_label(quote)))

    if not probe_results:
        return 0.0, 0.0, ""

    baseline_rate = probe_results[0][1]
    if baseline_rate <= 0:
        return 0.0, 0.0, ""

    best_size = 0.0
    best_impact = 0.0
    best_route = ""

    for size_sol, rate, route_label in probe_results:
        impact_pct = max(0.0, ((baseline_rate - rate) / baseline_rate) * 100.0)
        if impact_pct <= LIQUIDITY_MAX_PRICE_IMPACT_PCT and size_sol > best_size:
            best_size = size_sol
            best_impact = impact_pct
            best_route = route_label

    return best_size, best_impact, best_route


def send_telegram(message: str) -> None:
    global _telegram_warning_printed

    if not TELEGRAM_ENABLED:
        if not _telegram_warning_printed:
            print(f"Telegram disabled: {TELEGRAM_DISABLED_REASON}")
            _telegram_warning_printed = True
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
    }

    try:
        resp = requests.post(url, json=payload, timeout=API_TIMEOUT_SECONDS)
        if resp.status_code != 200:
            if resp.status_code == 404:
                print("Telegram error 404: invalid TELEGRAM_BOT_TOKEN.")
            elif resp.status_code == 401:
                print("Telegram error 401: TELEGRAM_BOT_TOKEN is unauthorized.")
            elif resp.status_code == 400:
                print(f"Telegram error 400: check TELEGRAM_CHAT_ID. Response: {resp.text}")
            else:
                print(f"Telegram error {resp.status_code}: {resp.text}")
    except requests.RequestException as exc:
        print(f"Telegram send failed: {exc}")


def get_pool_info(token_ca: str) -> Dict[str, Any]:
    asset = _fetch_helius_asset(token_ca)
    symbol = _extract_helius_symbol(asset)
    decimals = _extract_helius_decimals(asset)
    liq_sol, impact_pct, route_label = _estimate_liquidity_sol(token_ca)

    return {
        "tokenCA": token_ca,
        "symbol": symbol,
        "decimals": decimals,
        "liqSOL": liq_sol,
        "impactPct": impact_pct,
        "impactThresholdPct": LIQUIDITY_MAX_PRICE_IMPACT_PCT,
        "routeLabel": route_label,
        "source": "helius+jupiter",
    }


def get_open_positions() -> Dict[str, Dict[str, Any]]:
    return state["open_positions"]


def get_position(token_ca: str) -> Optional[Dict[str, Any]]:
    return get_open_positions().get(token_ca)


def count_open_positions() -> int:
    return len(get_open_positions())


def _state_for_today_snapshot(source_state: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = {
        "last_reset_date": source_state.get("last_reset_date"),
        "trades_today": _safe_int(source_state.get("trades_today"), 0),
        "daily_pnl_sol": _safe_float(source_state.get("daily_pnl_sol"), 0.0),
        "daily_pnl_usd": _safe_float(source_state.get("daily_pnl_usd"), 0.0),
        "daily_notional_usd": _safe_float(source_state.get("daily_notional_usd"), 0.0),
        "open_positions": {
            token_ca: _normalize_position(position)
            for token_ca, position in (source_state.get("open_positions", {}) or {}).items()
            if isinstance(position, dict)
        },
    }

    today = date.today().isoformat()
    if snapshot.get("last_reset_date") != today:
        snapshot["last_reset_date"] = today
        snapshot["trades_today"] = 0
        snapshot["daily_pnl_sol"] = 0.0
        snapshot["daily_pnl_usd"] = 0.0
        snapshot["daily_notional_usd"] = 0.0
    return snapshot


def _check_risk_limits_on_state(
    state_view: Dict[str, Any],
    token_ca: str,
    action: str,
    trade_notional_usd: float,
) -> Tuple[bool, str]:
    kill_switch_reason = _kill_switch_reason(action)
    if kill_switch_reason:
        return False, kill_switch_reason

    if action == "BUY" and state_view["trades_today"] >= MAX_TRADES_PER_DAY:
        return False, "Max daily trades reached"

    is_new_position = action == "BUY" and token_ca not in state_view["open_positions"]
    if is_new_position and len(state_view["open_positions"]) >= MAX_CONCURRENT_POSITIONS:
        return False, "Max concurrent positions reached"

    max_loss_usd = INITIAL_CAPITAL_USD * (MAX_DAILY_LOSS_PCT / 100)
    if state_view["daily_pnl_usd"] <= -max_loss_usd:
        return False, "Max daily loss reached"

    if _is_notional_limited_action(action):
        if trade_notional_usd > MAX_NOTIONAL_USD_PER_TRADE:
            return False, "Max notional per trade exceeded"

        projected_notional = state_view["daily_notional_usd"] + trade_notional_usd
        if projected_notional > MAX_NOTIONAL_USD_PER_DAY:
            return False, "Max daily notional exceeded"

    return True, ""


def check_risk_limits(token_ca: str, action: str, trade_notional_usd: float) -> Tuple[bool, str]:
    reset_daily_state_if_needed()
    return _check_risk_limits_on_state(state, token_ca, action, trade_notional_usd)


def format_position(token_ca: str) -> str:
    position = get_position(token_ca)
    if not position:
        return f"{token_ca}: no open position"

    return (
        f"{token_ca} | token_amount={position['token_amount']:.8f} | "
        f"cost_basis_sol={position['cost_basis_sol']:.8f} | "
        f"cost_basis_usd={position['cost_basis_usd']:.4f} | "
        f"avg_entry_sol={position['avg_entry_sol']:.8f} | "
        f"avg_entry_usd={position['avg_entry_usd']:.8f}"
    )


def _build_buy_quote_context(token_ca: str, amount_sol: float, decimals: Optional[int]) -> Dict[str, Any]:
    amount_raw = max(1, int(amount_sol * LAMPORTS_PER_SOL))
    quote = _fetch_jupiter_quote(SOL_MINT, token_ca, amount_raw)
    if not quote:
        return {"quote": None, "expected_token_amount": None, "impact_pct": 0.0, "route_label": ""}

    out_raw = _safe_int(quote.get("outAmount"), 0)
    expected_token_amount = None
    if decimals is not None and out_raw > 0:
        expected_token_amount = out_raw / (10**decimals)

    return {
        "quote": quote,
        "expected_token_amount": expected_token_amount,
        "impact_pct": _extract_quote_price_impact_pct(quote),
        "route_label": _extract_route_label(quote),
    }


def _build_sell_quote_context(
    token_ca: str, token_amount: float, decimals: Optional[int]
) -> Dict[str, Any]:
    if decimals is None:
        return {"quote": None, "expected_sol_out": None, "impact_pct": 0.0, "route_label": ""}

    amount_raw = max(1, int(token_amount * (10**decimals)))
    quote = _fetch_jupiter_quote(token_ca, SOL_MINT, amount_raw)
    if not quote:
        return {"quote": None, "expected_sol_out": None, "impact_pct": 0.0, "route_label": ""}

    out_raw = _safe_int(quote.get("outAmount"), 0)
    expected_sol_out = out_raw / LAMPORTS_PER_SOL if out_raw > 0 else None
    return {
        "quote": quote,
        "expected_sol_out": expected_sol_out,
        "impact_pct": _extract_quote_price_impact_pct(quote),
        "route_label": _extract_route_label(quote),
    }


# ── Intent Bundle System ────────────────────────────────────────────────────

def prepare_intent_bundle(
    token_ca: str,
    action: str,
    amount_sol: float,
    pool_info: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Wrap a trade into an Intent Bundle with on-chain conditions.
    Returns a bundle dict that can be submitted through Jito or used
    as pre-flight conditions before execution.

    Conditions enforced:
      - Pool liquidity >= INTENT_MIN_LIQUIDITY_SOL
      - Buy tax <= INTENT_MAX_BUY_TAX_PCT
      - Dynamic slippage based on PoolLiquidity / TradeSize ratio
    """
    liq_sol = pool_info.get("liqSOL", 0)
    buy_tax_pct = pool_info.get("buyTaxPct", 0.0)
    slippage_bps = _compute_dynamic_slippage_bps(liq_sol, amount_sol)

    conditions = [
        {
            "type": "MIN_LIQUIDITY",
            "required": INTENT_MIN_LIQUIDITY_SOL,
            "actual": liq_sol,
            "met": liq_sol >= INTENT_MIN_LIQUIDITY_SOL,
        },
        {
            "type": "MAX_BUY_TAX",
            "required_max_pct": INTENT_MAX_BUY_TAX_PCT,
            "actual_pct": buy_tax_pct,
            "met": buy_tax_pct <= INTENT_MAX_BUY_TAX_PCT,
        },
    ]

    all_met = all(c["met"] for c in conditions)
    regime = get_tuner().get_regime()

    # EIP-712 Intent Signing (Arbitrum layer)
    signer = get_signer()
    intent_sig = None
    if signer.is_ready and all_met and action == "BUY":
        intent_sig = signer.sign_swap_intent(
            token_in=pool_info.get("tokenIn", ""),
            token_out=token_ca,
            amount=int(amount_sol * 1e18),
            expected_output=int(pool_info.get("expectedOutput", 0)),
            regime=regime,
        )

    bundle = {
        "token_ca": token_ca,
        "action": action,
        "amount_sol": amount_sol,
        "slippage_bps": slippage_bps,
        "conditions": conditions,
        "all_conditions_met": all_met,
        "use_private_rpc": MEV_PROTECTION_ENABLED and bool(PRIVATE_RPC_URL or JITO_BUNDLE_URL),
        "jito_tip_lamports": JITO_TIP_LAMPORTS if MEV_PROTECTION_ENABLED else 0,
        "regime": regime,
        "created_at": time.time(),
        "intent_signature": intent_sig.get("signature") if intent_sig and intent_sig.get("ok") else None,
        "intent_message": intent_sig.get("message") if intent_sig and intent_sig.get("ok") else None,
    }

    if not all_met:
        failed = [c["type"] for c in conditions if not c["met"]]
        print(
            f"[INTENT] Bundle conditions NOT met for {token_ca}: {failed} "
            f"regime={regime}"
        )
    else:
        print(
            f"[INTENT] Bundle ready: {action} {amount_sol:.4f} SOL of {token_ca} "
            f"slippage={slippage_bps}bps private_rpc={bundle['use_private_rpc']} "
            f"regime={regime}"
        )

    return bundle


def _compute_dynamic_slippage_bps(pool_liquidity_sol: float, trade_size_sol: float) -> int:
    """
    Dynamic slippage buffer based on PoolLiquidity / TradeSize ratio.

    High ratio (deep pool, small trade) → low slippage.
    Low ratio (thin pool, large trade) → high slippage.
    """
    if not DYNAMIC_SLIPPAGE_ENABLED:
        return JUPITER_SLIPPAGE_BPS

    if pool_liquidity_sol <= 0 or trade_size_sol <= 0:
        return DYNAMIC_SLIPPAGE_CEILING_BPS

    ratio = pool_liquidity_sol / trade_size_sol

    # ratio >= 100 → floor (very safe, deep pool)
    # ratio <= 2   → ceiling (very thin, risky)
    # In between   → logarithmic interpolation
    if ratio >= 100:
        return DYNAMIC_SLIPPAGE_FLOOR_BPS
    if ratio <= 2:
        return DYNAMIC_SLIPPAGE_CEILING_BPS

    # log interpolation: map ratio 2..100 → ceiling..floor
    log_min = math.log(2)
    log_max = math.log(100)
    t = (math.log(ratio) - log_min) / (log_max - log_min)  # 0..1
    bps = DYNAMIC_SLIPPAGE_CEILING_BPS - t * (DYNAMIC_SLIPPAGE_CEILING_BPS - DYNAMIC_SLIPPAGE_FLOOR_BPS)
    return max(DYNAMIC_SLIPPAGE_FLOOR_BPS, min(DYNAMIC_SLIPPAGE_CEILING_BPS, int(bps)))


def _get_send_rpc_url() -> str:
    """
    Returns the RPC endpoint for sending transactions.
    If MEV protection is enabled and a private RPC is configured, use it.
    Otherwise fall back to the standard HELIUS_RPC_URL.
    """
    if MEV_PROTECTION_ENABLED and PRIVATE_RPC_URL:
        return PRIVATE_RPC_URL
    return HELIUS_RPC_URL


def _rpc_call(method: str, params: List[Any]) -> Tuple[Optional[Any], str]:
    if not HELIUS_RPC_URL:
        return None, "PRIMARY_RPC/HELIUS_RPC_URL is not configured."

    payload = {
        "jsonrpc": "2.0",
        "id": "trade-executor",
        "method": method,
        "params": params,
    }
    response = _request_json("rpc", "POST", HELIUS_RPC_URL, json=payload)
    if not response:
        return None, "RPC request failed."

    error = response.get("error")
    if error:
        return None, str(error)
    return response.get("result"), ""


def _load_live_wallet_context() -> Tuple[Optional[Dict[str, Any]], str]:
    global _live_wallet_cache
    if _live_wallet_cache:
        return _live_wallet_cache, ""

    if not PRIVATE_KEY:
        return None, "PRIVATE_KEY is not configured."

    try:
        from solders.keypair import Keypair
    except Exception:
        return None, "solders is not installed. Run: python -m pip install solders base58"

    cleaned_key = PRIVATE_KEY.strip()
    keypair = None
    try:
        if cleaned_key.startswith("["):
            keypair = Keypair.from_json(cleaned_key)
        else:
            keypair = Keypair.from_base58_string(cleaned_key)
    except Exception as exc:
        return None, f"Failed to parse PRIVATE_KEY: {exc}"

    context = {"keypair": keypair, "pubkey": str(keypair.pubkey())}
    _live_wallet_cache = context
    return context, ""


def _build_jupiter_swap_transaction(quote: Dict[str, Any], user_pubkey: str) -> Tuple[Optional[str], str]:
    if not JUPITER_SWAP_URL:
        return None, "Jupiter swap URL is not configured."

    payload: Dict[str, Any] = {
        "quoteResponse": quote,
        "userPublicKey": user_pubkey,
        "wrapAndUnwrapSol": True,
        "dynamicComputeUnitLimit": True,
    }
    if LIVE_PRIORITY_FEE_LAMPORTS > 0:
        payload["prioritizationFeeLamports"] = LIVE_PRIORITY_FEE_LAMPORTS

    response = _request_json("jupiter", "POST", JUPITER_SWAP_URL, json=payload)
    if not response:
        return None, "Jupiter swap build failed."

    swap_tx = response.get("swapTransaction")
    if not isinstance(swap_tx, str) or not swap_tx:
        return None, "Jupiter swapTransaction is missing."

    return swap_tx, ""


def _sign_versioned_transaction(swap_tx_b64: str, wallet_context: Dict[str, Any]) -> Tuple[Optional[str], str, str]:
    try:
        from solders.message import to_bytes_versioned
        from solders.transaction import VersionedTransaction
    except Exception:
        return None, "", "solders is not installed. Run: python -m pip install solders base58"

    keypair = wallet_context["keypair"]
    try:
        unsigned_tx = VersionedTransaction.from_bytes(base64.b64decode(swap_tx_b64))
        signature = keypair.sign_message(to_bytes_versioned(unsigned_tx.message))
        signed_tx = VersionedTransaction.populate(unsigned_tx.message, [signature])
    except Exception as exc:
        return None, "", f"Failed to sign swap transaction: {exc}"

    signed_b64 = base64.b64encode(bytes(signed_tx)).decode("ascii")
    return signed_b64, str(signature), ""


def _wait_for_signature(signature: str) -> Tuple[bool, str]:
    deadline = time.time() + LIVE_TX_CONFIRM_TIMEOUT_SECONDS
    while time.time() < deadline:
        result, error = _rpc_call(
            "getSignatureStatuses",
            [[signature], {"searchTransactionHistory": True}],
        )
        if error:
            time.sleep(LIVE_TX_CONFIRM_POLL_SECONDS)
            continue

        statuses = result.get("value") if isinstance(result, dict) else None
        status = statuses[0] if isinstance(statuses, list) and statuses else None
        if not status:
            time.sleep(LIVE_TX_CONFIRM_POLL_SECONDS)
            continue

        if status.get("err"):
            return False, f"Transaction failed on-chain: {status.get('err')}"

        confirmation = status.get("confirmationStatus")
        if confirmation in {"confirmed", "finalized"}:
            return True, ""

        time.sleep(LIVE_TX_CONFIRM_POLL_SECONDS)

    return False, "Timed out waiting for transaction confirmation."


def _account_keys_from_transaction(tx_result: Dict[str, Any]) -> List[str]:
    tx = tx_result.get("transaction") if isinstance(tx_result, dict) else {}
    message = tx.get("message") if isinstance(tx, dict) else {}
    keys = message.get("accountKeys") if isinstance(message, dict) else []
    parsed_keys: List[str] = []
    if isinstance(keys, list):
        for item in keys:
            if isinstance(item, str):
                parsed_keys.append(item)
            elif isinstance(item, dict) and isinstance(item.get("pubkey"), str):
                parsed_keys.append(item["pubkey"])
    return parsed_keys


def _token_ui_amount(balance_entry: Dict[str, Any]) -> float:
    ui_token = balance_entry.get("uiTokenAmount") if isinstance(balance_entry, dict) else {}
    if not isinstance(ui_token, dict):
        return 0.0
    text_amount = ui_token.get("uiAmountString")
    if text_amount is not None:
        return _safe_float(text_amount, 0.0)
    return _safe_float(ui_token.get("uiAmount"), 0.0)


def _owner_token_balance(entries: Any, owner: str, mint: str) -> float:
    total = 0.0
    if not isinstance(entries, list):
        return total
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if entry.get("owner") != owner:
            continue
        if entry.get("mint") != mint:
            continue
        total += _token_ui_amount(entry)
    return total


def _reconcile_fill_from_signature(
    signature: str,
    wallet_pubkey: str,
    token_ca: str,
    action: str,
) -> Tuple[Optional[Dict[str, Any]], str]:
    result, error = _rpc_call(
        "getTransaction",
        [
            signature,
            {
                "encoding": "jsonParsed",
                "commitment": "confirmed",
                "maxSupportedTransactionVersion": 0,
            },
        ],
    )
    if error:
        return None, f"Failed to fetch transaction for reconciliation: {error}"
    if not isinstance(result, dict):
        return None, "Transaction details missing for reconciliation."

    meta = result.get("meta")
    if not isinstance(meta, dict):
        return None, "Transaction meta missing for reconciliation."
    if meta.get("err"):
        return None, f"Transaction has on-chain error: {meta.get('err')}"

    account_keys = _account_keys_from_transaction(result)
    if wallet_pubkey not in account_keys:
        return None, "Wallet pubkey not found in transaction account keys."

    wallet_index = account_keys.index(wallet_pubkey)
    pre_balances = meta.get("preBalances") if isinstance(meta.get("preBalances"), list) else []
    post_balances = meta.get("postBalances") if isinstance(meta.get("postBalances"), list) else []
    if wallet_index >= len(pre_balances) or wallet_index >= len(post_balances):
        return None, "Wallet balance indexes are missing in transaction meta."

    sol_delta = (_safe_float(post_balances[wallet_index]) - _safe_float(pre_balances[wallet_index])) / LAMPORTS_PER_SOL

    pre_token = _owner_token_balance(meta.get("preTokenBalances"), wallet_pubkey, token_ca)
    post_token = _owner_token_balance(meta.get("postTokenBalances"), wallet_pubkey, token_ca)
    token_delta = post_token - pre_token

    fee_sol = _safe_float(meta.get("fee"), 0.0) / LAMPORTS_PER_SOL

    if action == "BUY":
        actual_token_amount = max(0.0, token_delta)
        actual_sol_amount = max(0.0, -sol_delta)
    else:
        actual_token_amount = max(0.0, -token_delta)
        actual_sol_amount = max(0.0, sol_delta)

    if actual_token_amount <= 0:
        return None, "Unable to reconcile token fill amount from transaction."
    if actual_sol_amount <= 0:
        return None, "Unable to reconcile SOL fill amount from transaction."

    return {
        "signature": signature,
        "actual_token_amount": actual_token_amount,
        "actual_sol_amount": actual_sol_amount,
        "fee_sol": fee_sol,
        "slot": _safe_int(result.get("slot"), 0),
    }, ""


def _execute_live_swap(
    action: str,
    token_ca: str,
    quote: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], str]:
    wallet_context, wallet_error = _load_live_wallet_context()
    if wallet_error:
        return None, wallet_error
    if not wallet_context:
        return None, "Live wallet context is unavailable."

    swap_tx_b64, swap_error = _build_jupiter_swap_transaction(quote, wallet_context["pubkey"])
    if swap_error:
        return None, swap_error
    if not swap_tx_b64:
        return None, "Swap transaction payload is empty."

    signed_b64, local_signature, sign_error = _sign_versioned_transaction(swap_tx_b64, wallet_context)
    if sign_error:
        return None, sign_error
    if not signed_b64 or not local_signature:
        return None, "Signed transaction is empty."

    # MEV Shield: route through private RPC if available
    send_url = _get_send_rpc_url()
    if send_url != HELIUS_RPC_URL:
        print(f"[MEV_SHIELD] Routing transaction through private RPC")

    final_send_error = ""
    for _ in range(LIVE_TX_SEND_RETRIES):
        send_payload = {
            "jsonrpc": "2.0",
            "id": "trade-executor-send",
            "method": "sendTransaction",
            "params": [
                signed_b64,
                {
                    "encoding": "base64",
                    "skipPreflight": LIVE_SKIP_PREFLIGHT,
                    "preflightCommitment": "confirmed",
                    "maxRetries": 0,
                },
            ],
        }
        response = _request_json("rpc", "POST", send_url, json=send_payload)
        if not response or response.get("error"):
            final_send_error = (
                str(response.get("error")) if response else "Private RPC send failed"
            )
        else:
            final_send_error = ""

        confirmed, confirm_error = _wait_for_signature(local_signature)
        if confirmed:
            break
        final_send_error = confirm_error
    else:
        _activate_runtime_kill_switch(f"live transaction confirmation failed: {final_send_error}")
        return None, f"Failed to confirm transaction: {final_send_error}"

    reconciliation, reconcile_error = _reconcile_fill_from_signature(
        local_signature,
        wallet_context["pubkey"],
        token_ca,
        action,
    )
    if reconcile_error:
        _activate_runtime_kill_switch(f"fill reconciliation failed: {reconcile_error}")
        return None, reconcile_error
    return reconciliation, ""


def execute_trade(token_ca: str, action: str, amount_sol: float, token_amount: Optional[float] = None) -> None:
    reset_daily_state_if_needed()

    action = action.upper().strip()
    if action not in {"BUY", "SELL"}:
        print(f"Invalid action: {action}")
        return

    if amount_sol <= 0:
        print(f"Invalid amount_sol: {amount_sol}")
        return

    sol_usd_price = get_sol_usd_price()
    trade_notional_usd = amount_sol * sol_usd_price
    allowed, reason = check_risk_limits(token_ca, action, trade_notional_usd)
    if not allowed:
        msg = (
            f"[BLOCKED] Trade blocked ({reason}): {action} {amount_sol:.8f} SOL "
            f"(${trade_notional_usd:.2f}) of {token_ca}"
        )
        print(msg)
        send_telegram(msg)
        return

    pool = get_pool_info(token_ca)
    regime = get_tuner().get_regime()

    # Profit Shield — pre-flight signal validation (all 5 gates)
    if action == "BUY":
        sig_valid, sig_reason = validate_signal({
            "tokenCA": token_ca,
            "liqSOL": pool["liqSOL"],
            "amountSOL": amount_sol,
            "latency_ms": pool.get("latency_ms", 0),
            "buyTaxPct": pool.get("buyTaxPct", 0.0),
        })
        if not sig_valid:
            msg = (
                f"[BLOCKED][{regime}] Signal filter rejected: {sig_reason}\n"
                f"token={token_ca} liqSOL={pool['liqSOL']:.2f} amountSOL={amount_sol:.4f}"
            )
            print(msg)
            send_telegram(msg)
            return

        # Intent Bundle — validate on-chain conditions before execution
        bundle = prepare_intent_bundle(token_ca, action, amount_sol, pool)
        if not bundle["all_conditions_met"]:
            failed = [c["type"] for c in bundle["conditions"] if not c["met"]]
            msg = (
                f"[BLOCKED][{regime}] Intent bundle conditions failed: {failed}\n"
                f"token={token_ca}"
            )
            print(msg)
            send_telegram(msg)
            return

        # Intent Executor routing — Dutch Auction via solver network
        if os.getenv("ARB_PRIVATE_KEY") and regime == MarketRegime.SAFE_MODE:
            executor = get_executor()
            intent_params = executor.get_intent_params(regime)
            signer = get_signer()
            signed = None
            if signer.is_ready:
                signed = signer.sign_swap_intent(
                    token_in=pool.get("tokenIn", ""),
                    token_out=token_ca,
                    amount=int(amount_sol * 1e18),
                    expected_output=int(pool.get("expectedOutput", 0)),
                    regime=regime,
                )
            intent = executor.create_onchain_intent(
                token_ca=token_ca,
                action=action,
                amount=amount_sol,
                expected_output=pool.get("expectedOutput", 0),
                regime=regime,
                signed_intent=signed,
            )
            result = asyncio.run(executor.broadcast_intent_to_resolver(intent))
            if result["ok"]:
                msg = (
                    f"[INTENT][{regime}] Dutch Auction dispatched -> "
                    f"preset={intent_params['preset']} "
                    f"minReturn={intent_params['min_return_pct']}% "
                    f"auction={intent_params['auction_duration_s']}s "
                    f"label={intent_params['label']} "
                    f"order_hash={result.get('order_hash')} "
                    f"token={token_ca}"
                )
                print(msg)
                send_telegram(msg)
                return
            else:
                print(
                    f"[INTENT][{regime}] Solver broadcast failed: {result.get('error')}. "
                    f"Falling through to standard execution for {token_ca}"
                )

    # Block low-liquidity entries only
    if action == "BUY" and pool["liqSOL"] < MIN_LIQUIDITY_SOL:
        msg = (
            f"[BLOCKED][{regime}] Trade blocked: Pool {token_ca}\n"
            f"liqSOL: {pool['liqSOL']:.2f} (min: {MIN_LIQUIDITY_SOL})\n"
            f"impactPct@liq: {pool['impactPct']:.2f}% (threshold: {pool['impactThresholdPct']:.2f}%)\n"
            f"route: {pool.get('routeLabel') or 'n/a'}"
        )
        print(msg)
        send_telegram(msg)
        return

    positions = get_open_positions()
    mode = "[PAPER]" if PAPER_MODE else "[LIVE]"

    if action == "BUY":
        buy_quote = _build_buy_quote_context(token_ca, amount_sol, pool.get("decimals"))
        if REQUIRE_QUOTE_FOR_EXECUTION and not buy_quote["quote"]:
            msg = (
                f"[BLOCKED] BUY blocked: no Jupiter quote available for {token_ca}. "
                "Execution quote required."
            )
            print(msg)
            send_telegram(msg)
            return

        quote_impact_pct = buy_quote["impact_pct"]
        if quote_impact_pct > MAX_EXECUTION_PRICE_IMPACT_PCT:
            msg = (
                f"[BLOCKED] BUY blocked: quote price impact {quote_impact_pct:.2f}% "
                f"exceeds max {MAX_EXECUTION_PRICE_IMPACT_PCT:.2f}% for {token_ca}"
            )
            print(msg)
            send_telegram(msg)
            return

        expected_token_amount = buy_quote["expected_token_amount"]
        tx_signature = ""
        fee_sol = 0.0

        if PAPER_MODE:
            if token_amount is None:
                token_amount = expected_token_amount if expected_token_amount else amount_sol

            if token_amount <= 0:
                print(f"Invalid token_amount: {token_amount}")
                return

            fill_slippage_bps: Optional[float] = None
            if expected_token_amount and expected_token_amount > 0:
                fill_slippage_bps = _slippage_bps(expected_token_amount, token_amount)
                if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
                    msg = (
                        f"[BLOCKED] BUY blocked: fill slippage {fill_slippage_bps:.2f} bps "
                        f"exceeds max {MAX_FILL_SLIPPAGE_BPS:.2f} bps for {token_ca}"
                    )
                    print(msg)
                    send_telegram(msg)
                    return
        else:
            if not buy_quote["quote"]:
                msg = f"[BLOCKED] BUY blocked: quote payload missing for live execution ({token_ca})."
                print(msg)
                send_telegram(msg)
                return

            live_fill, live_error = _execute_live_swap("BUY", token_ca, buy_quote["quote"])
            if live_error or not live_fill:
                msg = f"[BLOCKED] BUY blocked: live execution failed for {token_ca}. reason={live_error}"
                print(msg)
                send_telegram(msg)
                return

            tx_signature = str(live_fill.get("signature") or "")
            fee_sol = _safe_float(live_fill.get("fee_sol"), 0.0)
            token_amount = _safe_float(live_fill.get("actual_token_amount"), 0.0)
            amount_sol = _safe_float(live_fill.get("actual_sol_amount"), amount_sol)
            if token_amount <= 0 or amount_sol <= 0:
                _activate_runtime_kill_switch("live BUY reconciliation returned non-positive fill values")
                msg = f"[BLOCKED] BUY blocked: invalid live fill values for {token_ca}"
                print(msg)
                send_telegram(msg)
                return

            fill_slippage_bps = None
            if expected_token_amount and expected_token_amount > 0:
                fill_slippage_bps = _slippage_bps(expected_token_amount, token_amount)
                if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
                    _activate_runtime_kill_switch(
                        f"BUY fill slippage {fill_slippage_bps:.2f} bps exceeded {MAX_FILL_SLIPPAGE_BPS:.2f} bps"
                    )
                    alert_msg = (
                        f"[ALERT] BUY fill slippage breach for {token_ca}: "
                        f"{fill_slippage_bps:.2f} bps > {MAX_FILL_SLIPPAGE_BPS:.2f} bps. "
                        "Runtime kill-switch activated."
                    )
                    print(alert_msg)
                    send_telegram(alert_msg)

            trade_notional_usd = amount_sol * sol_usd_price

        spend_usd = trade_notional_usd

        existing = positions.get(token_ca)
        if existing:
            new_token_amount = existing["token_amount"] + token_amount
            new_cost_basis_sol = existing["cost_basis_sol"] + amount_sol
            new_cost_basis_usd = existing["cost_basis_usd"] + spend_usd

            existing["token_amount"] = new_token_amount
            existing["cost_basis_sol"] = new_cost_basis_sol
            existing["cost_basis_usd"] = new_cost_basis_usd
            existing["avg_entry_sol"] = new_cost_basis_sol / new_token_amount
            existing["avg_entry_usd"] = new_cost_basis_usd / new_token_amount
            existing["buy_count"] += 1
        else:
            positions[token_ca] = {
                "token_amount": token_amount,
                "cost_basis_sol": amount_sol,
                "cost_basis_usd": spend_usd,
                "avg_entry_sol": amount_sol / token_amount,
                "avg_entry_usd": spend_usd / token_amount,
                "buy_count": 1,
            }

        state["trades_today"] += 1
        if _is_notional_limited_action(action):
            state["daily_notional_usd"] += trade_notional_usd
        save_state()

        position = positions[token_ca]
        route_label = buy_quote["route_label"] or pool.get("routeLabel") or "n/a"
        slippage_text = "n/a" if fill_slippage_bps is None else f"{fill_slippage_bps:.2f} bps"
        msg = (
            f"{mode} BUY executed\n"
            f"Token: {token_ca}\n"
            f"Spend: {amount_sol:.8f} SOL (${spend_usd:.2f})\n"
            f"Token amount: {token_amount:.8f}\n"
            f"SOL/USD: {sol_usd_price:.2f}\n"
            f"Pool liqSOL: {pool['liqSOL']:.2f}\n"
            f"Route: {route_label}\n"
            f"Quote impact: {quote_impact_pct:.2f}%\n"
            f"Fill slippage: {slippage_text}\n"
            f"Tx signature: {tx_signature or 'n/a'}\n"
            f"Network fee: {fee_sol:.8f} SOL\n"
            f"Avg entry SOL/token: {position['avg_entry_sol']:.8f}\n"
            f"Avg entry USD/token: {position['avg_entry_usd']:.8f}\n"
            f"Position cost basis: {position['cost_basis_sol']:.8f} SOL (${position['cost_basis_usd']:.2f})\n"
            f"Trades today: {state['trades_today']}/{MAX_TRADES_PER_DAY}\n"
            f"Open positions: {count_open_positions()}/{MAX_CONCURRENT_POSITIONS}\n"
            f"Daily notional: ${state['daily_notional_usd']:.2f}/${MAX_NOTIONAL_USD_PER_DAY:.2f}\n"
            f"Daily PnL: {state['daily_pnl_sol']:.8f} SOL (${state['daily_pnl_usd']:.2f})"
        )
        print(msg)
        send_telegram(msg)
        return

    position = positions.get(token_ca)
    if not position:
        msg = f"[BLOCKED] SELL ignored: no open position for {token_ca}"
        print(msg)
        send_telegram(msg)
        return

    if token_amount is None:
        token_amount = position["token_amount"]

    if token_amount <= 0:
        print(f"Invalid token_amount: {token_amount}")
        return

    if token_amount > position["token_amount"]:
        msg = (
            f"[BLOCKED] SELL ignored: requested token_amount {token_amount:.8f} "
            f"exceeds position size {position['token_amount']:.8f} for {token_ca}"
        )
        print(msg)
        send_telegram(msg)
        return

    sell_quote = _build_sell_quote_context(token_ca, token_amount, pool.get("decimals"))
    if REQUIRE_QUOTE_FOR_EXECUTION and not sell_quote["quote"]:
        msg = (
            f"[BLOCKED] SELL blocked: no Jupiter quote available for {token_ca}. "
            "Execution quote required."
        )
        print(msg)
        send_telegram(msg)
        return

    quote_impact_pct = sell_quote["impact_pct"]
    if quote_impact_pct > MAX_EXECUTION_PRICE_IMPACT_PCT:
        msg = (
            f"[BLOCKED] SELL blocked: quote price impact {quote_impact_pct:.2f}% "
            f"exceeds max {MAX_EXECUTION_PRICE_IMPACT_PCT:.2f}% for {token_ca}"
        )
        print(msg)
        send_telegram(msg)
        return

    expected_sol_out = sell_quote["expected_sol_out"]
    tx_signature = ""
    fee_sol = 0.0
    fill_slippage_bps: Optional[float] = None
    if PAPER_MODE:
        if expected_sol_out and expected_sol_out > 0:
            fill_slippage_bps = _slippage_bps(expected_sol_out, amount_sol)
            if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
                msg = (
                    f"[BLOCKED] SELL blocked: fill slippage {fill_slippage_bps:.2f} bps "
                    f"exceeds max {MAX_FILL_SLIPPAGE_BPS:.2f} bps for {token_ca}"
                )
                print(msg)
                send_telegram(msg)
                return
    else:
        if not sell_quote["quote"]:
            msg = f"[BLOCKED] SELL blocked: quote payload missing for live execution ({token_ca})."
            print(msg)
            send_telegram(msg)
            return

        live_fill, live_error = _execute_live_swap("SELL", token_ca, sell_quote["quote"])
        if live_error or not live_fill:
            msg = f"[BLOCKED] SELL blocked: live execution failed for {token_ca}. reason={live_error}"
            print(msg)
            send_telegram(msg)
            return

        tx_signature = str(live_fill.get("signature") or "")
        fee_sol = _safe_float(live_fill.get("fee_sol"), 0.0)
        reconciled_token_amount = _safe_float(live_fill.get("actual_token_amount"), 0.0)
        reconciled_amount_sol = _safe_float(live_fill.get("actual_sol_amount"), 0.0)
        if reconciled_token_amount <= 0 or reconciled_amount_sol <= 0:
            _activate_runtime_kill_switch("live SELL reconciliation returned non-positive fill values")
            msg = f"[BLOCKED] SELL blocked: invalid live fill values for {token_ca}"
            print(msg)
            send_telegram(msg)
            return

        if reconciled_token_amount > position["token_amount"]:
            reconciled_token_amount = position["token_amount"]
        token_amount = reconciled_token_amount
        amount_sol = reconciled_amount_sol
        trade_notional_usd = amount_sol * sol_usd_price

        if expected_sol_out and expected_sol_out > 0:
            fill_slippage_bps = _slippage_bps(expected_sol_out, amount_sol)
            if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
                _activate_runtime_kill_switch(
                    f"SELL fill slippage {fill_slippage_bps:.2f} bps exceeded {MAX_FILL_SLIPPAGE_BPS:.2f} bps"
                )
                alert_msg = (
                    f"[ALERT] SELL fill slippage breach for {token_ca}: "
                    f"{fill_slippage_bps:.2f} bps > {MAX_FILL_SLIPPAGE_BPS:.2f} bps. "
                    "Runtime kill-switch activated."
                )
                print(alert_msg)
                send_telegram(alert_msg)

    avg_entry_sol = position["avg_entry_sol"]
    avg_entry_usd = position["avg_entry_usd"]
    realized_cost_basis_sol = avg_entry_sol * token_amount
    realized_cost_basis_usd = avg_entry_usd * token_amount

    proceeds_usd = amount_sol * sol_usd_price
    realized_pnl_sol = amount_sol - realized_cost_basis_sol
    realized_pnl_usd = proceeds_usd - realized_cost_basis_usd

    remaining_token_amount = position["token_amount"] - token_amount
    remaining_cost_basis_sol = position["cost_basis_sol"] - realized_cost_basis_sol
    remaining_cost_basis_usd = position["cost_basis_usd"] - realized_cost_basis_usd

    if remaining_token_amount <= 1e-12:
        positions.pop(token_ca, None)
    else:
        position["token_amount"] = remaining_token_amount
        position["cost_basis_sol"] = max(0.0, remaining_cost_basis_sol)
        position["cost_basis_usd"] = max(0.0, remaining_cost_basis_usd)
        position["avg_entry_sol"] = position["cost_basis_sol"] / position["token_amount"]
        position["avg_entry_usd"] = position["cost_basis_usd"] / position["token_amount"]

    state["trades_today"] += 1
    state["daily_pnl_sol"] += realized_pnl_sol
    state["daily_pnl_usd"] += realized_pnl_usd
    if _is_notional_limited_action(action):
        state["daily_notional_usd"] += trade_notional_usd
    save_state()

    remaining = positions.get(token_ca)
    remaining_text = (
        "closed"
        if not remaining
        else (
            f"token_amount={remaining['token_amount']:.8f}, "
            f"cost_basis_sol={remaining['cost_basis_sol']:.8f}, "
            f"cost_basis_usd={remaining['cost_basis_usd']:.2f}, "
            f"avg_entry_sol={remaining['avg_entry_sol']:.8f}, "
            f"avg_entry_usd={remaining['avg_entry_usd']:.8f}"
        )
    )

    route_label = sell_quote["route_label"] or pool.get("routeLabel") or "n/a"
    slippage_text = "n/a" if fill_slippage_bps is None else f"{fill_slippage_bps:.2f} bps"
    msg = (
        f"{mode} SELL executed\n"
        f"Token: {token_ca}\n"
        f"Receive: {amount_sol:.8f} SOL (${proceeds_usd:.2f})\n"
        f"Token amount sold: {token_amount:.8f}\n"
        f"SOL/USD: {sol_usd_price:.2f}\n"
        f"Pool liqSOL: {pool['liqSOL']:.2f}\n"
        f"Route: {route_label}\n"
        f"Quote impact: {quote_impact_pct:.2f}%\n"
        f"Fill slippage: {slippage_text}\n"
        f"Tx signature: {tx_signature or 'n/a'}\n"
        f"Network fee: {fee_sol:.8f} SOL\n"
        f"Realized PnL: {realized_pnl_sol:.8f} SOL (${realized_pnl_usd:.2f})\n"
        f"Remaining position: {remaining_text}\n"
        f"Trades today: {state['trades_today']}/{MAX_TRADES_PER_DAY}\n"
        f"Open positions: {count_open_positions()}/{MAX_CONCURRENT_POSITIONS}\n"
        f"Daily notional: ${state['daily_notional_usd']:.2f}/${MAX_NOTIONAL_USD_PER_DAY:.2f}\n"
        f"Daily PnL: {state['daily_pnl_sol']:.8f} SOL (${state['daily_pnl_usd']:.2f})"
    )
    print(msg)
    send_telegram(msg)


def preview_trade(token_ca: str, action: str, amount_sol: float, token_amount: Optional[float] = None) -> bool:
    action = action.upper().strip()
    if action not in {"BUY", "SELL"}:
        print(f"[DRY-RUN] Invalid action: {action}")
        return False

    if amount_sol <= 0:
        print(f"[DRY-RUN] Invalid amount_sol: {amount_sol}")
        return False

    simulated_state = _state_for_today_snapshot(state)
    sol_usd_price = get_sol_usd_price()
    trade_notional_usd = amount_sol * sol_usd_price
    allowed, reason = _check_risk_limits_on_state(
        simulated_state, token_ca, action, trade_notional_usd
    )
    pool = get_pool_info(token_ca)

    if not allowed:
        print(
            f"[DRY-RUN][BLOCKED] {reason} | token={token_ca} amount_sol={amount_sol:.8f} "
            f"notional=${trade_notional_usd:.2f} "
            f"trades_today={simulated_state['trades_today']}/{MAX_TRADES_PER_DAY}"
        )
        return False

    regime = get_tuner().get_regime()

    # Profit Shield — pre-flight signal validation (all 5 gates)
    if action == "BUY":
        sig_valid, sig_reason = validate_signal({
            "tokenCA": token_ca,
            "liqSOL": pool["liqSOL"],
            "amountSOL": amount_sol,
            "latency_ms": pool.get("latency_ms", 0),
            "buyTaxPct": pool.get("buyTaxPct", 0.0),
        })
        if not sig_valid:
            print(
                f"[DRY-RUN][BLOCKED][{regime}] signal filter: {sig_reason} | "
                f"token={token_ca} liqSOL={pool['liqSOL']:.2f} amountSOL={amount_sol:.4f}"
            )
            return False

        # Intent Bundle — validate on-chain conditions
        bundle = prepare_intent_bundle(token_ca, action, amount_sol, pool)
        if not bundle["all_conditions_met"]:
            failed = [c["type"] for c in bundle["conditions"] if not c["met"]]
            print(
                f"[DRY-RUN][BLOCKED][{regime}] intent bundle conditions failed: {failed} | "
                f"token={token_ca}"
            )
            return False

    if action == "BUY" and pool["liqSOL"] < MIN_LIQUIDITY_SOL:
        print(
            f"[DRY-RUN][BLOCKED] low liquidity | token={token_ca} "
            f"liqSOL={pool['liqSOL']:.2f} min={MIN_LIQUIDITY_SOL:.2f} "
            f"impactPct={pool['impactPct']:.2f}% route={pool.get('routeLabel') or 'n/a'}"
        )
        return False

    positions = simulated_state["open_positions"]

    if action == "BUY":
        buy_quote = _build_buy_quote_context(token_ca, amount_sol, pool.get("decimals"))
        if REQUIRE_QUOTE_FOR_EXECUTION and not buy_quote["quote"]:
            print(
                f"[DRY-RUN][BLOCKED] no Jupiter quote available for {token_ca}; "
                "execution quote required."
            )
            return False

        quote_impact_pct = buy_quote["impact_pct"]
        if quote_impact_pct > MAX_EXECUTION_PRICE_IMPACT_PCT:
            print(
                f"[DRY-RUN][BLOCKED] quote impact {quote_impact_pct:.2f}% exceeds "
                f"max {MAX_EXECUTION_PRICE_IMPACT_PCT:.2f}%."
            )
            return False

        expected_token_amount = buy_quote["expected_token_amount"]
        if token_amount is None:
            token_amount = expected_token_amount if expected_token_amount else amount_sol
        if token_amount <= 0:
            print(f"[DRY-RUN] Invalid token_amount: {token_amount}")
            return False

        spend_usd = amount_sol * sol_usd_price
        fill_slippage_bps: Optional[float] = None
        if expected_token_amount and expected_token_amount > 0:
            fill_slippage_bps = _slippage_bps(expected_token_amount, token_amount)
            if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
                print(
                    f"[DRY-RUN][BLOCKED] fill slippage {fill_slippage_bps:.2f} bps exceeds "
                    f"max {MAX_FILL_SLIPPAGE_BPS:.2f} bps."
                )
                return False

        existing = positions.get(token_ca)
        if existing:
            new_token_amount = existing["token_amount"] + token_amount
            new_cost_basis_sol = existing["cost_basis_sol"] + amount_sol
            new_cost_basis_usd = existing["cost_basis_usd"] + spend_usd
            avg_entry_sol = new_cost_basis_sol / new_token_amount
            avg_entry_usd = new_cost_basis_usd / new_token_amount
        else:
            new_token_amount = token_amount
            new_cost_basis_sol = amount_sol
            new_cost_basis_usd = spend_usd
            avg_entry_sol = amount_sol / token_amount
            avg_entry_usd = spend_usd / token_amount

        projected_daily_notional = (
            simulated_state["daily_notional_usd"] + trade_notional_usd
            if _is_notional_limited_action(action)
            else simulated_state["daily_notional_usd"]
        )
        slippage_text = "n/a" if fill_slippage_bps is None else f"{fill_slippage_bps:.2f} bps"
        print(
            "[DRY-RUN][BUY] would execute\n"
            f"Token: {token_ca}\n"
            f"Spend: {amount_sol:.8f} SOL (${spend_usd:.2f})\n"
            f"Token amount: {token_amount:.8f}\n"
            f"SOL/USD: {sol_usd_price:.2f}\n"
            f"Pool liqSOL: {pool['liqSOL']:.2f}\n"
            f"Route: {buy_quote['route_label'] or pool.get('routeLabel') or 'n/a'}\n"
            f"Quote impact: {quote_impact_pct:.2f}%\n"
            f"Fill slippage: {slippage_text}\n"
            f"Projected position token amount: {new_token_amount:.8f}\n"
            f"Projected position cost basis: {new_cost_basis_sol:.8f} SOL (${new_cost_basis_usd:.2f})\n"
            f"Projected avg entry: {avg_entry_sol:.8f} SOL/token (${avg_entry_usd:.8f})\n"
            f"Projected trades today: {simulated_state['trades_today'] + 1}/{MAX_TRADES_PER_DAY}\n"
            f"Projected daily notional: ${projected_daily_notional:.2f}/${MAX_NOTIONAL_USD_PER_DAY:.2f}\n"
            "State unchanged. Telegram not sent."
        )
        return True

    position = positions.get(token_ca)
    if not position:
        print(f"[DRY-RUN][BLOCKED] SELL ignored: no open position for {token_ca}")
        return False

    if token_amount is None:
        token_amount = position["token_amount"]
    if token_amount <= 0:
        print(f"[DRY-RUN] Invalid token_amount: {token_amount}")
        return False
    if token_amount > position["token_amount"]:
        print(
            f"[DRY-RUN][BLOCKED] SELL size too large: requested={token_amount:.8f} "
            f"position={position['token_amount']:.8f}"
        )
        return False

    sell_quote = _build_sell_quote_context(token_ca, token_amount, pool.get("decimals"))
    if REQUIRE_QUOTE_FOR_EXECUTION and not sell_quote["quote"]:
        print(
            f"[DRY-RUN][BLOCKED] no Jupiter quote available for {token_ca}; "
            "execution quote required."
        )
        return False

    quote_impact_pct = sell_quote["impact_pct"]
    if quote_impact_pct > MAX_EXECUTION_PRICE_IMPACT_PCT:
        print(
            f"[DRY-RUN][BLOCKED] quote impact {quote_impact_pct:.2f}% exceeds "
            f"max {MAX_EXECUTION_PRICE_IMPACT_PCT:.2f}%."
        )
        return False

    fill_slippage_bps: Optional[float] = None
    expected_sol_out = sell_quote["expected_sol_out"]
    if expected_sol_out and expected_sol_out > 0:
        fill_slippage_bps = _slippage_bps(expected_sol_out, amount_sol)
        if fill_slippage_bps > MAX_FILL_SLIPPAGE_BPS:
            print(
                f"[DRY-RUN][BLOCKED] fill slippage {fill_slippage_bps:.2f} bps exceeds "
                f"max {MAX_FILL_SLIPPAGE_BPS:.2f} bps."
            )
            return False

    avg_entry_sol = position["avg_entry_sol"]
    avg_entry_usd = position["avg_entry_usd"]
    realized_cost_basis_sol = avg_entry_sol * token_amount
    realized_cost_basis_usd = avg_entry_usd * token_amount
    proceeds_usd = amount_sol * sol_usd_price
    realized_pnl_sol = amount_sol - realized_cost_basis_sol
    realized_pnl_usd = proceeds_usd - realized_cost_basis_usd

    projected_daily_pnl_sol = simulated_state["daily_pnl_sol"] + realized_pnl_sol
    projected_daily_pnl_usd = simulated_state["daily_pnl_usd"] + realized_pnl_usd
    projected_daily_notional = (
        simulated_state["daily_notional_usd"] + trade_notional_usd
        if _is_notional_limited_action(action)
        else simulated_state["daily_notional_usd"]
    )

    remaining_token_amount = position["token_amount"] - token_amount
    remaining_cost_basis_sol = position["cost_basis_sol"] - realized_cost_basis_sol
    remaining_cost_basis_usd = position["cost_basis_usd"] - realized_cost_basis_usd
    if remaining_token_amount <= 1e-12:
        remaining_text = "closed"
    else:
        remaining_avg_sol = remaining_cost_basis_sol / remaining_token_amount
        remaining_avg_usd = remaining_cost_basis_usd / remaining_token_amount
        remaining_text = (
            f"token_amount={remaining_token_amount:.8f}, "
            f"cost_basis_sol={remaining_cost_basis_sol:.8f}, "
            f"cost_basis_usd={remaining_cost_basis_usd:.2f}, "
            f"avg_entry_sol={remaining_avg_sol:.8f}, "
            f"avg_entry_usd={remaining_avg_usd:.8f}"
        )

    slippage_text = "n/a" if fill_slippage_bps is None else f"{fill_slippage_bps:.2f} bps"
    print(
        "[DRY-RUN][SELL] would execute\n"
        f"Token: {token_ca}\n"
        f"Receive: {amount_sol:.8f} SOL (${proceeds_usd:.2f})\n"
        f"Token amount sold: {token_amount:.8f}\n"
        f"SOL/USD: {sol_usd_price:.2f}\n"
        f"Pool liqSOL: {pool['liqSOL']:.2f}\n"
        f"Route: {sell_quote['route_label'] or pool.get('routeLabel') or 'n/a'}\n"
        f"Quote impact: {quote_impact_pct:.2f}%\n"
        f"Fill slippage: {slippage_text}\n"
        f"Projected realized PnL: {realized_pnl_sol:.8f} SOL (${realized_pnl_usd:.2f})\n"
        f"Projected remaining position: {remaining_text}\n"
        f"Projected daily PnL: {projected_daily_pnl_sol:.8f} SOL (${projected_daily_pnl_usd:.2f})\n"
        f"Projected trades today: {simulated_state['trades_today'] + 1}/{MAX_TRADES_PER_DAY}\n"
        f"Projected daily notional: ${projected_daily_notional:.2f}/${MAX_NOTIONAL_USD_PER_DAY:.2f}\n"
        "State unchanged. Telegram not sent."
    )
    return True


def _run_demo_trades(dry_run: bool) -> None:
    demo_trades = [
        ("4ybr1NZzY4AfXwFFi7SPbNEjVP6eMbxqGPazgqmZbonk", "BUY", 0.3, 120000.0),
        ("4ybr1NZzY4AfXwFFi7SPbNEjVP6eMbxqGPazgqmZbonk", "BUY", 0.2, 70000.0),
        ("4ybr1NZzY4AfXwFFi7SPbNEjVP6eMbxqGPazgqmZbonk", "SELL", 0.35, 100000.0),
    ]

    for token_ca, action, amount_sol, token_amount in demo_trades:
        if dry_run:
            preview_trade(token_ca, action, amount_sol, token_amount=token_amount)
        else:
            execute_trade(token_ca, action, amount_sol, token_amount=token_amount)


async def _run_advanced_autonomous_loop(
    once: bool,
    cycle_seconds_override: Optional[float] = None,
    arb_size_override: Optional[float] = None,
) -> int:
    try:
        from advanced_strategies import AdvancedAutonomousEngine, AdvancedStrategyConfig
        from advanced_strategies.autonomous_runner import (
            env_keywords,
            env_kol_wallets,
            env_token_list,
        )
    except Exception as exc:
        print(
            "Advanced strategies package is unavailable. "
            f"Ensure advanced_strategies modules are present. Error: {exc}"
        )
        return 1

    config = AdvancedStrategyConfig.from_env()
    token_mints = env_token_list()
    keywords = env_keywords()
    kol_wallets = env_kol_wallets()
    arb_size_sol = (
        arb_size_override
        if arb_size_override is not None
        else _safe_float(os.getenv("ADVANCED_ARB_TRADE_SIZE_SOL"), 0.2)
    )
    cycle_seconds = (
        cycle_seconds_override
        if cycle_seconds_override is not None
        else _safe_float(os.getenv("ADVANCED_CYCLE_SECONDS"), 12.0)
    )

    def _notify(message: str) -> None:
        print(message)
        send_telegram(message)

    engine = AdvancedAutonomousEngine(config=config, notifier=_notify)

    if once:
        result = await engine.run_once(
            token_mints=token_mints,
            keywords=keywords,
            kol_wallets=kol_wallets,
            arb_trade_size_sol=arb_size_sol,
        )
        sentiment_count = len(result.get("sentiment", []))
        momentum_count = sum(
            1 for row in result.get("sentiment", []) if getattr(row, "should_momentum_buy", False)
        )
        arb_count = len(result.get("arbitrage", []))
        profitable_arb = sum(
            1 for row in result.get("arbitrage", []) if getattr(row, "profitable", False)
        )
        summary = (
            "[ADVANCED] one-shot cycle complete\n"
            f"tokens_scanned={len(token_mints)} sentiment_scored={sentiment_count} "
            f"momentum_triggers={momentum_count}\n"
            f"arb_candidates={arb_count} profitable_arb={profitable_arb}"
        )
        print(summary)
        send_telegram(summary)
        return 0

    print(
        "[ADVANCED] autonomous loop started\n"
        f"tokens={len(token_mints)} cycle_seconds={cycle_seconds:.1f} "
        f"arb_size_sol={arb_size_sol:.4f}"
    )
    await engine.run_forever(
        token_mints=token_mints,
        keywords=keywords,
        kol_wallets=kol_wallets,
        arb_trade_size_sol=arb_size_sol,
        cycle_seconds=cycle_seconds,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Trade executor with risk checks and optional dry run.")
    parser.add_argument("--dry-run", action="store_true", help="Preview trade outcomes without state writes.")
    parser.add_argument("--token-ca", help="Token mint address for a single trade execution.")
    parser.add_argument("--action", choices=["BUY", "SELL"], default="BUY", help="Trade action.")
    parser.add_argument("--amount-sol", type=float, help="SOL notional to spend/receive.")
    parser.add_argument("--token-amount", type=float, help="Token units for weighted entry/exit accounting.")
    parser.add_argument("--demo", action="store_true", help="Run built-in demo sequence.")
    parser.add_argument(
        "--advanced-autonomous",
        action="store_true",
        help="Run autonomous advanced strategy loop (LP sniper + sentiment + cross-DEX arb).",
    )
    parser.add_argument(
        "--advanced-once",
        action="store_true",
        help="Run one advanced strategy cycle then exit.",
    )
    parser.add_argument(
        "--advanced-cycle-seconds",
        type=float,
        help="Override cycle interval for advanced autonomous loop.",
    )
    parser.add_argument(
        "--advanced-arb-size-sol",
        type=float,
        help="Override arbitrage notional in SOL for advanced loop.",
    )
    return parser


def run_cli() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.advanced_autonomous or args.advanced_once:
        return asyncio.run(
            _run_advanced_autonomous_loop(
                once=args.advanced_once,
                cycle_seconds_override=args.advanced_cycle_seconds,
                arb_size_override=args.advanced_arb_size_sol,
            )
        )

    has_single_trade_args = args.token_ca is not None or args.amount_sol is not None
    if has_single_trade_args and (args.token_ca is None or args.amount_sol is None):
        parser.error("--token-ca and --amount-sol must be provided together.")

    if args.demo:
        _run_demo_trades(dry_run=args.dry_run)
        return 0

    if has_single_trade_args:
        if args.dry_run:
            preview_trade(args.token_ca, args.action, args.amount_sol, token_amount=args.token_amount)
        else:
            execute_trade(args.token_ca, args.action, args.amount_sol, token_amount=args.token_amount)
        return 0

    _run_demo_trades(dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(run_cli())
