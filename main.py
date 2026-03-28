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
    Signal ingestion loop. Replace the placeholder with your actual
    Telegram scraper, WebSocket feed, or Redis subscriber.
    """
    logger.info("Signal Listener active — waiting for alpha...")
    while True:
        # ── Replace with actual ingestion logic ──
        # Example sources:
        #   signal = await telegram_scraper.get()
        #   signal = await websocket_feed.recv()
        #   signal = await redis_subscriber.get_message()
        #
        # Expected signal shape:
        # {
        #     "address": "0x...",        # Token contract address
        #     "symbol": "MEME",          # Token symbol
        #     "price": 0.001,            # Current price (for PnL arrival)
        #     "tokenCA": "0x...",        # Same as address (for signal_filter)
        #     "liqSOL": 100.0,           # Pool liquidity in SOL
        #     "amountSOL": 5.0,          # Trade size
        #     "latency_ms": 150,         # Signal latency
        #     "buyTaxPct": 0.0,          # Buy tax percentage
        # }

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
