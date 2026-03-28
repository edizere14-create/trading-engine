# main.py — EDDYI Trading Engine v3.1 (Master Brain)
#
# Orchestrates all modules into a single resilient async loop:
#   - MarketWatcher (BTC/ETH regime detection)
#   - DynamicTuner (adaptive parameter tuning)
#   - Sentinel (dead man's switch + Telegram killswitch)
#   - TokenSecurityChecker (GoPlus + Honeypot.is pre-flight)
#   - SignalFilter (5-gate Profit Shield)
#   - IntentExecutor (Dutch Auction via solver network)
#   - PnL Logger (execution quality attribution)
#   - StateManager (Redis distributed locking + Pub/Sub)
#   - L3 Ecosystem Sniper (Arbitrum Orbit bridge flows)
#   - Whale Shadow Tracker (meme whale convergence)
#   - Intent Arbitrage (Camelot vs UniV3 cross-DEX)
#
# Run:  python main.py
# Docker:  python main.py  (inside the container defined in Dockerfile)

import asyncio
import logging
import os
import signal
import sys
from typing import Any, Dict, Optional

from dotenv import load_dotenv

load_dotenv()

# ── Module Imports ──────────────────────────────────────────────────────────
from market_watcher import get_watcher
from dynamic_tuner import get_tuner, MarketRegime
from sentinel import get_sentinel
from state_manager import get_state_manager
from token_security_checker import get_security_checker
from signal_filter import validate_signal
from intent_executor import get_executor
from intent_signer import get_signer
from pnl_logger import get_pnl_logger
from advanced_strategies.l3_ecosystem_sniper import get_l3_sniper
from advanced_strategies.whale_shadow import get_whale_tracker
from advanced_strategies.intent_arbitrage import get_intent_arbitrage
from auto_graduation import get_graduation_monitor
from telegram_reporter import daily_report_loop
from trade_executor import (
    get_open_positions,
    get_sol_usd_price,
    get_pool_info,
    execute_trade,
    send_telegram,
    LIQUIDITY_MAX_PRICE_IMPACT_PCT,
)

# ── Logging ─────────────────────────────────────────────────────────────────
LOG_FORMAT = "%(asctime)s [%(name)s] %(levelname)s — %(message)s"
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format=LOG_FORMAT,
    handlers=[
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger("EddyiEngine")

# ── Config ──────────────────────────────────────────────────────────────────
ENGINE_VERSION = "3.1"
SIGNAL_POLL_INTERVAL = int(os.getenv("SIGNAL_POLL_INTERVAL", 10))
HEALTH_CHECK_INTERVAL = int(os.getenv("HEALTH_CHECK_INTERVAL", 60))
SHUTDOWN_TIMEOUT = int(os.getenv("SHUTDOWN_TIMEOUT", 10))
STALE_EXIT_CHECK_INTERVAL = int(os.getenv("STALE_EXIT_CHECK_INTERVAL", 10))
STALE_EXIT_GRACE_SECONDS = int(os.getenv("STALE_EXIT_GRACE_SECONDS", 60))
STALE_EXIT_MIN_MOVE_PCT = float(os.getenv("STALE_EXIT_MIN_MOVE_PCT", 1.0))
STALE_EXIT_MAX_PRICE_IMPACT_PCT = float(os.getenv("STALE_EXIT_MAX_PRICE_IMPACT_PCT", 5.0))


# ── Core Pipeline ───────────────────────────────────────────────────────────

async def process_signal(signal_data: Dict[str, Any]) -> bool:
    """
    The Core Pipeline: Lock -> Security Scan -> Filter -> Intent Execution.
    Returns True if the signal was successfully executed.
    """
    token_address = signal_data.get("address", "")
    symbol = signal_data.get("symbol", "UNKNOWN")
    state = get_state_manager()

    # ── 1. Distributed Lock (Safety First) ──────────────────────────
    try:
        lock_result = await state.acquire_trade_lock(token_address)
        if not lock_result.acquired:
            logger.info(
                "Skipping %s: Already being processed by another node (error=%s)",
                symbol, lock_result.error,
            )
            return False
    except Exception as exc:
        # Redis down → proceed without lock (single-instance fallback)
        logger.warning("Lock unavailable (%s), proceeding without lock", exc)

    # ── 2. Security Firewall ────────────────────────────────────────
    try:
        verdict = await get_security_checker().scan_token(token_address)
        if not verdict.passed:
            logger.warning(
                "REJECTED %s: Security scan failed — risk=%s reasons=%s",
                symbol, verdict.risk_level, verdict.rejection_reasons,
            )
            await _broadcast_safe(
                "SECURITY_REJECTED",
                {"symbol": symbol, "risk": verdict.risk_level, "reasons": verdict.rejection_reasons},
            )
            return False
    except Exception as exc:
        logger.warning("Security scan error for %s (%s), proceeding with caution", symbol, exc)

    # ── 3. Profit Shield (Signal Filtering) ─────────────────────────
    is_valid, reason = validate_signal(signal_data)
    if not is_valid:
        await _broadcast_safe("SIGNAL_REJECTED", {"symbol": symbol, "reason": reason})
        logger.info("REJECTED %s: %s", symbol, reason)
        return False

    # ── 4. Intent Arbitrage Check ───────────────────────────────────
    regime = get_tuner().get_regime()
    arb_override = None
    try:
        amount_eth = float(signal_data.get("amountSOL", 0))
        arb_override = await get_intent_arbitrage().check_arbitrage(token_address, amount_eth)
        if arb_override.use_override:
            logger.info(
                "ARB OVERRIDE %s: gap=%.2f%% start=%.8f from=%s",
                symbol, arb_override.gap_pct, arb_override.start_price, arb_override.source_dex,
            )
    except Exception as exc:
        logger.debug("Intent arbitrage check skipped (%s)", exc)

    # ── 5. Intent Execution (The 'Ghost' Trade) ────────────────────
    executor = get_executor()
    logger.info("EXECUTING: Signing %s intent for %s", regime, symbol)

    # Sentinel heartbeat — proves the bot is alive
    get_sentinel().heartbeat()

    # PnL Logger — capture arrival price before signing
    arrival_price = float(signal_data.get("price", 0))
    if arrival_price > 0:
        get_pnl_logger().capture_arrival(
            token_ca=token_address,
            action="BUY",
            arrival_price=arrival_price,
            amount=float(signal_data.get("amountSOL", 0)),
            regime=regime,
        )

    # Build and sign the intent
    intent_params = executor.get_intent_params(regime)

    # Apply arb override if available
    if arb_override and arb_override.use_override:
        intent_params["start_price"] = arb_override.start_price
        intent_params["min_return_pct"] = arb_override.min_return_pct

    signer = get_signer()
    signed = None
    if signer.is_ready:
        signed = signer.sign_swap_intent(
            token_in=signal_data.get("tokenIn", ""),
            token_out=token_address,
            amount=int(float(signal_data.get("amountSOL", 0)) * 1e18),
            expected_output=int(arrival_price * 1e18) if arrival_price else 0,
            regime=regime,
        )

    intent = executor.create_onchain_intent(
        token_ca=token_address,
        action="BUY",
        amount=float(signal_data.get("amountSOL", 0)),
        expected_output=arrival_price,
        regime=regime,
        signed_intent=signed,
    )

    result = await executor.broadcast_intent_to_resolver(intent)

    if result.get("ok"):
        order_hash = result.get("order_hash", "")
        get_sentinel().track_intent(intent)

        await _broadcast_safe(
            "INTENT_DISPATCHED",
            {
                "symbol": symbol,
                "token": token_address,
                "regime": regime,
                "preset": intent_params.get("preset"),
                "order_hash": order_hash,
            },
        )
        logger.info("SUCCESS: %s intent broadcast to solver network (hash=%s)", symbol, order_hash)
        return True
    else:
        logger.error("FAILURE: Could not broadcast intent for %s — %s", symbol, result.get("error"))
        return False


# ── Signal Listener ─────────────────────────────────────────────────────────

async def signal_listener():
    """
    Signal ingestion loop — subscribes to Redis Pub/Sub 'incoming_signals'
    channel and dispatches each signal as a concurrent task.
    Falls back to polling if Redis is unavailable.
    """
    logger.info("Signal Listener active — subscribing to incoming_signals channel...")

    state = get_state_manager()
    try:
        async for signal_data in state.subscribe_signals():
            if not isinstance(signal_data, dict):
                logger.warning("Non-dict signal received, skipping: %s", type(signal_data))
                continue

            symbol = signal_data.get("symbol", "UNKNOWN")
            logger.info("SIGNAL RECEIVED: %s via Redis Pub/Sub", symbol)
            asyncio.create_task(process_signal(signal_data))
    except Exception as exc:
        logger.error("Signal listener fatal error: %s — falling back to poll mode", exc)
        # Fallback: sleep loop keeps the coroutine alive so asyncio.gather doesn't exit
        while True:
            await asyncio.sleep(SIGNAL_POLL_INTERVAL)


# ── Health Check ────────────────────────────────────────────────────────────

async def health_check_loop():
    """Periodic health check — logs system status to dashboard."""
    while True:
        await asyncio.sleep(HEALTH_CHECK_INTERVAL)
        try:
            regime = get_tuner().get_regime()
            sentinel = get_sentinel()
            status = {
                "regime": regime,
                "sentinel_triggered": sentinel.is_triggered,
                "sentinel_status": sentinel.status(),
                "pnl_summary": get_pnl_logger().get_summary(),
                "l3_sniper": get_l3_sniper().get_status(),
                "whale_tracker": get_whale_tracker().get_status(),
                "arb_stats": get_intent_arbitrage().get_stats(),
                "graduation": get_graduation_monitor().get_status(),
            }
            await _broadcast_safe("HEALTH_CHECK", status)
            logger.debug("Health check: regime=%s sentinel=%s", regime, sentinel.is_triggered)
        except Exception as exc:
            logger.warning("Health check error: %s", exc)


# ── STALE_EXIT Position Monitor (Dead-on-Arrival Killswitch) ────────────────

async def stale_exit_monitor():
    """
    Monitors open positions for "dead-on-arrival" tokens.
    If a position hasn't moved +1% within 60 seconds of entry,
    trigger an immediate STALE_EXIT sell to avoid slow bleed.
    """
    logger.info(
        "STALE_EXIT monitor active — grace=%ds, min_move=+%.1f%%",
        STALE_EXIT_GRACE_SECONDS,
        STALE_EXIT_MIN_MOVE_PCT,
    )
    import time as _time

    while True:
        await asyncio.sleep(STALE_EXIT_CHECK_INTERVAL)
        try:
            positions = get_open_positions()
            if not positions:
                continue

            now = _time.time()
            for token_ca, pos in list(positions.items()):
                entry_time = pos.get("entry_time", 0)
                if entry_time <= 0:
                    continue

                age_seconds = now - entry_time
                # Only check positions within the grace window (just past 60s)
                if age_seconds < STALE_EXIT_GRACE_SECONDS:
                    continue
                # Don't re-check positions that are much older (already past the kill window)
                if age_seconds > STALE_EXIT_GRACE_SECONDS * 3:
                    continue

                # Check current price vs entry price
                entry_price_usd = pos.get("entry_price_usd", 0)
                if entry_price_usd <= 0:
                    entry_price_usd = pos.get("avg_entry_usd", 0)
                if entry_price_usd <= 0:
                    continue

                pool = get_pool_info(token_ca)
                if not pool or pool.get("liqSOL", 0) <= 0:
                    # Can't price it — force exit to avoid holding dead tokens
                    logger.warning(
                        "STALE_EXIT: %s — no pool data after %ds, forcing exit",
                        token_ca, int(age_seconds),
                    )
                    _trigger_stale_exit(token_ca, pos, 0.0, entry_price_usd, age_seconds)
                    continue

                # Estimate current token price via pool data
                current_price_usd = _estimate_current_price_usd(token_ca, pos, pool)
                if current_price_usd is None or current_price_usd <= 0:
                    continue

                move_pct = ((current_price_usd - entry_price_usd) / entry_price_usd) * 100.0
                if move_pct < STALE_EXIT_MIN_MOVE_PCT:
                    logger.warning(
                        "STALE_EXIT: %s — only %.2f%% move in %ds (need +%.1f%%), killing position",
                        token_ca, move_pct, int(age_seconds), STALE_EXIT_MIN_MOVE_PCT,
                    )
                    _trigger_stale_exit(token_ca, pos, move_pct, entry_price_usd, age_seconds)

        except Exception as exc:
            logger.warning("STALE_EXIT monitor error: %s", exc)


def _estimate_current_price_usd(
    token_ca: str, pos: Dict[str, Any], pool: Dict[str, Any]
) -> Optional[float]:
    """Estimate current token price in USD using a small Jupiter quote."""
    try:
        from trade_executor import _fetch_jupiter_quote, _safe_int, LAMPORTS_PER_SOL, SOL_MINT
        # Probe with a tiny amount to get current rate
        probe_amount_raw = int(0.01 * LAMPORTS_PER_SOL)
        quote = _fetch_jupiter_quote(SOL_MINT, token_ca, probe_amount_raw)
        if not quote:
            return None
        out_raw = _safe_int(quote.get("outAmount"), 0)
        if out_raw <= 0:
            return None
        # Price = SOL_spent / tokens_received, converted to USD
        sol_per_token = 0.01 / (out_raw / 1e9)  # rough estimate
        sol_usd = get_sol_usd_price()
        return sol_per_token * sol_usd
    except Exception:
        return None


def _trigger_stale_exit(
    token_ca: str,
    pos: Dict[str, Any],
    move_pct: float,
    entry_price_usd: float,
    age_seconds: float,
) -> None:
    """
    Execute STALE_EXIT via Fast Dutch Auction (30s) to preserve principal.

    Flow:
      1. Check pool price impact — if impact > threshold, use Intent auction
      2. Build a STALE_EXIT intent with 30s fast auction + 95% min return
      3. Broadcast via solver network so MEV bots compete for the fill
      4. Fall back to direct execute_trade only if Intent system is unavailable
    """
    try:
        token_amount = pos.get("token_amount", 0)
        cost_basis_sol = pos.get("cost_basis_sol", 0)
        if token_amount <= 0 or cost_basis_sol <= 0:
            return

        # ── Price Impact Guard ──────────────────────────────────────────
        pool = get_pool_info(token_ca)
        pool_liq_sol = pool.get("liqSOL", 0) if pool else 0
        impact_pct = pool.get("impactPct", 0) if pool else 0

        # Estimate impact: position_size / pool_liquidity as a rough proxy
        estimated_impact = (
            (cost_basis_sol / pool_liq_sol) * 100.0
            if pool_liq_sol > 0
            else 999.0
        )
        use_intent = (
            estimated_impact > STALE_EXIT_MAX_PRICE_IMPACT_PCT
            or impact_pct > STALE_EXIT_MAX_PRICE_IMPACT_PCT
        )

        exit_method = "INTENT_FAST_AUCTION" if use_intent else "DIRECT_SELL"

        msg = (
            f"[STALE_EXIT] Killing dead position\n"
            f"Token: {token_ca}\n"
            f"Age: {int(age_seconds)}s\n"
            f"Price move: {move_pct:+.2f}% (needed +{STALE_EXIT_MIN_MOVE_PCT:.1f}%)\n"
            f"Entry price: ${entry_price_usd:.8f}\n"
            f"Pool liq: {pool_liq_sol:.2f} SOL | Est. impact: {estimated_impact:.2f}%\n"
            f"Exit method: {exit_method}\n"
            f"Selling full position: {token_amount:.8f} tokens"
        )
        logger.warning(msg)
        send_telegram(msg)

        # ── Intent Fast Auction Path ────────────────────────────────────
        if use_intent:
            _stale_exit_via_intent(token_ca, pos, cost_basis_sol, entry_price_usd)
        else:
            # Low-impact: safe to do a direct market sell
            execute_trade(token_ca, "SELL", cost_basis_sol)

    except Exception as exc:
        logger.error("STALE_EXIT execution failed for %s: %s", token_ca, exc)


def _stale_exit_via_intent(
    token_ca: str,
    pos: Dict[str, Any],
    cost_basis_sol: float,
    entry_price_usd: float,
) -> None:
    """
    Route STALE_EXIT through a 30-second Fast Dutch Auction.
    Solvers compete to fill the order, preventing AMM price cratering.
    Falls back to direct sell if the Intent system is unavailable.
    """
    try:
        from intent_executor import get_executor, STALE_EXIT_PRESET
        from intent_signer import get_signer

        executor = get_executor()
        params = executor.get_intent_params(STALE_EXIT_PRESET)

        # Sign the exit intent
        signer = get_signer()
        signed = None
        if signer.is_ready:
            signed = signer.sign_swap_intent(
                token_in=token_ca,
                token_out="",  # Selling to SOL/ETH
                amount=int(cost_basis_sol * 1e18),
                expected_output=int(entry_price_usd * 1e18),
                regime=STALE_EXIT_PRESET,
            )

        intent = executor.create_onchain_intent(
            token_ca=token_ca,
            action="SELL",
            amount=cost_basis_sol,
            expected_output=entry_price_usd,
            regime=STALE_EXIT_PRESET,
            signed_intent=signed,
        )

        # Broadcast to solver network
        import asyncio
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None

        if loop and loop.is_running():
            future = asyncio.ensure_future(
                executor.broadcast_intent_to_resolver(intent)
            )
            # Schedule fallback check: if intent not filled, do direct sell
            async def _check_intent_result():
                result = await future
                if result.get("ok"):
                    order_hash = result.get("order_hash", "")
                    logger.info(
                        "[STALE_EXIT] Intent accepted: hash=%s auction=%ds minReturn=%s%%",
                        order_hash,
                        params["auction_duration_s"],
                        params["min_return_pct"],
                    )
                    send_telegram(
                        f"[STALE_EXIT] Fast Auction dispatched for {token_ca}\n"
                        f"Duration: {params['auction_duration_s']}s\n"
                        f"Min return: {params['min_return_pct']}%\n"
                        f"Order hash: {order_hash}"
                    )
                else:
                    logger.warning(
                        "[STALE_EXIT] Intent broadcast failed: %s — falling back to direct sell",
                        result.get("error"),
                    )
                    send_telegram(
                        f"[STALE_EXIT] Intent failed for {token_ca}, using direct sell fallback"
                    )
                    execute_trade(token_ca, "SELL", cost_basis_sol)

            asyncio.ensure_future(_check_intent_result())
        else:
            # No running event loop — fall back to direct sell
            logger.warning("[STALE_EXIT] No event loop for intent broadcast — direct sell fallback")
            execute_trade(token_ca, "SELL", cost_basis_sol)

    except Exception as exc:
        logger.error(
            "[STALE_EXIT] Intent path failed for %s: %s — falling back to direct sell",
            token_ca, exc,
        )
        execute_trade(token_ca, "SELL", cost_basis_sol)


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _broadcast_safe(event_type: str, data: Dict[str, Any]) -> None:
    """Broadcast to dashboard via Redis — non-fatal on failure."""
    try:
        regime = get_tuner().get_regime()
        await get_state_manager().broadcast_event(event_type, data, regime)
    except Exception:
        pass  # Redis down → dashboard miss is non-fatal


# ── Engine Startup & Shutdown ───────────────────────────────────────────────

async def start_background_services():
    """Start all background monitoring threads (non-blocking)."""
    # Market Watcher — BTC/ETH regime detection (background thread)
    get_watcher().start()

    # Dynamic Tuner — adaptive parameter tuning (background thread)
    get_tuner().start()

    # Sentinel — dead man's switch + Telegram listener (background threads)
    get_sentinel().start()

    # L3 Ecosystem Sniper — Arbitrum Orbit bridge flow monitor
    get_l3_sniper().start()

    # Whale Shadow Tracker — meme whale convergence detection
    get_whale_tracker().start()

    # Auto-Graduation Monitor — proves profitability before LIVE unlock
    get_graduation_monitor().start()

    logger.info(
        "Background services started: "
        "MarketWatcher, DynamicTuner, Sentinel, L3Sniper, WhaleTracker, GraduationMonitor"
    )


async def main():
    """Engine entry point — initializes all subsystems and runs the async loop."""
    logger.info(
        "INITIALIZING EDDYI TRADING ENGINE v%s (2026 ARBITRUM EDITION)",
        ENGINE_VERSION,
    )

    # Start background monitoring threads
    await start_background_services()

    # Broadcast system online
    await _broadcast_safe("SYSTEM_ONLINE", {"version": ENGINE_VERSION, "status": "READY"})

    logger.info(
        "Engine READY — regime=%s, sentinel=%s, wallets=%d, chains=%s",
        get_tuner().get_regime(),
        "armed" if not get_sentinel().is_triggered else "TRIGGERED",
        len(get_whale_tracker().get_wallets()),
        list(get_l3_sniper().get_status().get("chains_monitored", [])),
    )

    # Run the async event loop
    try:
        await asyncio.gather(
            signal_listener(),
            health_check_loop(),
            stale_exit_monitor(),
            daily_report_loop(),
        )
    except asyncio.CancelledError:
        logger.info("Engine shutting down (CancelledError)...")
    except KeyboardInterrupt:
        logger.info("Engine shutting down (KeyboardInterrupt)...")
    except Exception as exc:
        logger.critical("ENGINE CRASH: %s", exc, exc_info=True)
    finally:
        logger.info("Cleanup complete. Engine stopped.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Stopped by user.")
