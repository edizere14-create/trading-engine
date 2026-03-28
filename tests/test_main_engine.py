# tests/test_main_engine.py
# Tests for main.py — the Master Brain orchestrator

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from main import process_signal, _broadcast_safe


class TestProcessSignal:
    """Tests for the core pipeline: Lock -> Security -> Filter -> Execute."""

    CLEAN_SIGNAL = {
        "address": "0xCleanToken",
        "symbol": "CLEAN",
        "price": 0.001,
        "tokenCA": "0xCleanToken",
        "liqSOL": 100.0,
        "amountSOL": 5.0,
        "latency_ms": 150,
        "buyTaxPct": 0.0,
    }

    # ── Lock rejection ──────────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_signal_skipped_when_lock_not_acquired(self):
        mock_lock = MagicMock(acquired=False, error="already_locked")
        with patch("main.get_state_manager") as mock_state:
            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is False

    @pytest.mark.asyncio
    async def test_signal_proceeds_when_redis_down(self):
        """If Redis is down, engine falls through to security check."""
        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec:
            mock_state.return_value.acquire_trade_lock = AsyncMock(
                side_effect=ConnectionError("redis down")
            )
            # Security check will reject → proves pipeline continued past lock
            mock_verdict = MagicMock(passed=False, risk_level="HIGH", rejection_reasons=["test"])
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)
            mock_state.return_value.broadcast_event = AsyncMock()

            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is False  # Rejected by security, not by lock

    # ── Security rejection ──────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_signal_rejected_by_security(self):
        mock_lock = MagicMock(acquired=True)
        mock_verdict = MagicMock(
            passed=False, risk_level="CRITICAL",
            rejection_reasons=["goplus_honeypot_detected"],
        )
        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec:
            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            mock_state.return_value.broadcast_event = AsyncMock()
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)

            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is False

    # ── Signal filter rejection ─────────────────────────────────────

    @pytest.mark.asyncio
    async def test_signal_rejected_by_filter(self):
        mock_lock = MagicMock(acquired=True)
        mock_verdict = MagicMock(passed=True)

        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec, \
             patch("main.validate_signal", return_value=(False, "LOW_LIQUIDITY")):
            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            mock_state.return_value.broadcast_event = AsyncMock()
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)

            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is False

    # ── Successful execution ────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_signal_executed_successfully(self):
        mock_lock = MagicMock(acquired=True)
        mock_verdict = MagicMock(passed=True)
        mock_arb = MagicMock(use_override=False)
        mock_intent_result = {"ok": True, "order_hash": "0xhash123"}

        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec, \
             patch("main.validate_signal", return_value=(True, "VALID_ALPHA")), \
             patch("main.get_intent_arbitrage") as mock_arb_eng, \
             patch("main.get_tuner") as mock_tuner, \
             patch("main.get_executor") as mock_exec, \
             patch("main.get_signer") as mock_signer, \
             patch("main.get_sentinel") as mock_sentinel, \
             patch("main.get_pnl_logger") as mock_pnl:

            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            mock_state.return_value.broadcast_event = AsyncMock()
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)
            mock_arb_eng.return_value.check_arbitrage = AsyncMock(return_value=mock_arb)
            mock_tuner.return_value.get_regime.return_value = "NORMAL"
            mock_exec.return_value.get_intent_params.return_value = {
                "preset": "fair", "min_return_pct": 99.0,
            }
            mock_exec.return_value.create_onchain_intent.return_value = {"token_ca": "0xClean"}
            mock_exec.return_value.broadcast_intent_to_resolver = AsyncMock(
                return_value=mock_intent_result
            )
            mock_signer.return_value.is_ready = False
            mock_sentinel.return_value.is_triggered = False

            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is True

    # ── Intent broadcast failure ────────────────────────────────────

    @pytest.mark.asyncio
    async def test_signal_intent_broadcast_failure(self):
        mock_lock = MagicMock(acquired=True)
        mock_verdict = MagicMock(passed=True)
        mock_arb = MagicMock(use_override=False)

        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec, \
             patch("main.validate_signal", return_value=(True, "VALID_ALPHA")), \
             patch("main.get_intent_arbitrage") as mock_arb_eng, \
             patch("main.get_tuner") as mock_tuner, \
             patch("main.get_executor") as mock_exec, \
             patch("main.get_signer") as mock_signer, \
             patch("main.get_sentinel") as mock_sentinel, \
             patch("main.get_pnl_logger") as mock_pnl:

            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            mock_state.return_value.broadcast_event = AsyncMock()
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)
            mock_arb_eng.return_value.check_arbitrage = AsyncMock(return_value=mock_arb)
            mock_tuner.return_value.get_regime.return_value = "SAFE_MODE"
            mock_exec.return_value.get_intent_params.return_value = {
                "preset": "fast", "min_return_pct": 98.0,
            }
            mock_exec.return_value.create_onchain_intent.return_value = {}
            mock_exec.return_value.broadcast_intent_to_resolver = AsyncMock(
                return_value={"ok": False, "error": "solver_timeout"}
            )
            mock_signer.return_value.is_ready = False
            mock_sentinel.return_value.is_triggered = False

            result = await process_signal(self.CLEAN_SIGNAL)

        assert result is False

    # ── Arb override applied ────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_arb_override_applied_to_intent(self):
        mock_lock = MagicMock(acquired=True)
        mock_verdict = MagicMock(passed=True)
        mock_arb = MagicMock(
            use_override=True, start_price=0.00095,
            min_return_pct=99.5, gap_pct=2.5, source_dex="Camelot",
        )
        mock_intent_result = {"ok": True, "order_hash": "0xarb456"}

        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_security_checker") as mock_sec, \
             patch("main.validate_signal", return_value=(True, "VALID_ALPHA")), \
             patch("main.get_intent_arbitrage") as mock_arb_eng, \
             patch("main.get_tuner") as mock_tuner, \
             patch("main.get_executor") as mock_exec, \
             patch("main.get_signer") as mock_signer, \
             patch("main.get_sentinel") as mock_sentinel, \
             patch("main.get_pnl_logger") as mock_pnl:

            mock_state.return_value.acquire_trade_lock = AsyncMock(return_value=mock_lock)
            mock_state.return_value.broadcast_event = AsyncMock()
            mock_sec.return_value.scan_token = AsyncMock(return_value=mock_verdict)
            mock_arb_eng.return_value.check_arbitrage = AsyncMock(return_value=mock_arb)
            mock_tuner.return_value.get_regime.return_value = "AGGRESSIVE"

            intent_params = {"preset": "auction", "min_return_pct": 99.5}
            mock_exec.return_value.get_intent_params.return_value = intent_params
            mock_exec.return_value.create_onchain_intent.return_value = {}
            mock_exec.return_value.broadcast_intent_to_resolver = AsyncMock(
                return_value=mock_intent_result
            )
            mock_signer.return_value.is_ready = False
            mock_sentinel.return_value.is_triggered = False

            result = await process_signal(self.CLEAN_SIGNAL)

        # Verify arb override was applied
        assert intent_params["start_price"] == 0.00095
        assert result is True


class TestBroadcastSafe:
    """Tests for the _broadcast_safe helper."""

    @pytest.mark.asyncio
    async def test_broadcast_succeeds(self):
        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_tuner") as mock_tuner:
            mock_tuner.return_value.get_regime.return_value = "NORMAL"
            mock_state.return_value.broadcast_event = AsyncMock()
            await _broadcast_safe("TEST_EVENT", {"key": "value"})
            mock_state.return_value.broadcast_event.assert_called_once()

    @pytest.mark.asyncio
    async def test_broadcast_swallows_redis_error(self):
        with patch("main.get_state_manager") as mock_state, \
             patch("main.get_tuner") as mock_tuner:
            mock_tuner.return_value.get_regime.return_value = "NORMAL"
            mock_state.return_value.broadcast_event = AsyncMock(
                side_effect=ConnectionError("redis down")
            )
            # Should not raise
            await _broadcast_safe("TEST_EVENT", {"key": "value"})


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
