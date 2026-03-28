# tests/test_security_and_strategies.py
# Tests for: token_security_checker, l3_ecosystem_sniper, intent_arbitrage, whale_shadow

import asyncio
import time
import os
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ── token_security_checker tests ────────────────────────────────────────────

from token_security_checker import (
    TokenSecurityChecker,
    GoPlusResult,
    HoneypotResult,
    SecurityVerdict,
    get_security_checker,
    _safe_pct,
    _risk_ord,
)


class TestTokenSecurityChecker:
    """Tests for the pre-flight security scanner."""

    def setup_method(self):
        TokenSecurityChecker._instance = None
        self.checker = get_security_checker()
        self.checker.clear_cache()

    # ── Singleton ───────────────────────────────────────────────────

    def test_singleton_returns_same_instance(self):
        a = get_security_checker()
        b = get_security_checker()
        assert a is b

    # ── GoPlusResult model ──────────────────────────────────────────

    def test_goplus_result_defaults(self):
        r = GoPlusResult()
        assert r.is_honeypot is False
        assert r.buy_tax_pct == 0.0
        assert r.sell_tax_pct == 0.0
        assert r.owner_change_balance is False

    def test_goplus_result_with_flags(self):
        r = GoPlusResult(
            is_honeypot=True,
            buy_tax_pct=15.0,
            sell_tax_pct=25.0,
            hidden_owner=True,
        )
        assert r.is_honeypot is True
        assert r.buy_tax_pct == 15.0
        assert r.hidden_owner is True

    # ── HoneypotResult model ────────────────────────────────────────

    def test_honeypot_result_defaults(self):
        r = HoneypotResult()
        assert r.is_honeypot is False
        assert r.simulate_success is True

    def test_honeypot_result_flagged(self):
        r = HoneypotResult(is_honeypot=True, reason="sell blocked")
        assert r.is_honeypot is True
        assert r.reason == "sell blocked"

    # ── SecurityVerdict model ───────────────────────────────────────

    def test_verdict_passed(self):
        v = SecurityVerdict(token_address="0xabc", passed=True)
        assert v.passed is True
        assert v.risk_level == "LOW"
        assert v.rejection_reasons == []

    def test_verdict_rejected(self):
        v = SecurityVerdict(
            token_address="0xabc",
            passed=False,
            risk_level="CRITICAL",
            rejection_reasons=["goplus_honeypot_detected"],
        )
        assert v.passed is False
        assert v.risk_level == "CRITICAL"

    # ── _safe_pct helper ────────────────────────────────────────────

    def test_safe_pct_decimal(self):
        assert _safe_pct("0.05") == 5.0

    def test_safe_pct_percentage(self):
        assert _safe_pct("15") == 15.0

    def test_safe_pct_zero(self):
        assert _safe_pct("0") == 0.0

    def test_safe_pct_invalid(self):
        assert _safe_pct("abc") == 0.0

    def test_safe_pct_none(self):
        assert _safe_pct(None) == 0.0

    # ── _risk_ord helper ────────────────────────────────────────────

    def test_risk_ordering(self):
        assert _risk_ord("LOW") < _risk_ord("MEDIUM")
        assert _risk_ord("MEDIUM") < _risk_ord("HIGH")
        assert _risk_ord("HIGH") < _risk_ord("CRITICAL")

    # ── scan_token with mocked APIs ─────────────────────────────────

    @pytest.mark.asyncio
    async def test_scan_clean_token(self):
        goplus = GoPlusResult(buy_tax_pct=2.0, sell_tax_pct=3.0)
        honeypot = HoneypotResult(simulate_success=True)

        with patch.object(self.checker, "_check_goplus", return_value=goplus), \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot):
            verdict = await self.checker.scan_token("0xclean")

        assert verdict.passed is True
        assert verdict.risk_level == "LOW"
        assert len(verdict.rejection_reasons) == 0

    @pytest.mark.asyncio
    async def test_scan_honeypot_token(self):
        goplus = GoPlusResult(is_honeypot=True)
        honeypot = HoneypotResult(is_honeypot=True, reason="sell reverts")

        with patch.object(self.checker, "_check_goplus", return_value=goplus), \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot):
            verdict = await self.checker.scan_token("0xhoneypot")

        assert verdict.passed is False
        assert verdict.risk_level == "CRITICAL"
        assert any("honeypot" in r for r in verdict.rejection_reasons)

    @pytest.mark.asyncio
    async def test_scan_high_tax_token(self):
        goplus = GoPlusResult(buy_tax_pct=15.0, sell_tax_pct=20.0)
        honeypot = HoneypotResult()

        with patch.object(self.checker, "_check_goplus", return_value=goplus), \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot):
            verdict = await self.checker.scan_token("0xhightax")

        assert verdict.passed is False
        assert verdict.risk_level in ("HIGH", "CRITICAL")
        assert any("buy_tax" in r for r in verdict.rejection_reasons)
        assert any("sell_tax" in r for r in verdict.rejection_reasons)

    @pytest.mark.asyncio
    async def test_scan_owner_manipulation(self):
        goplus = GoPlusResult(owner_change_balance=True, selfdestruct=True)
        honeypot = HoneypotResult()

        with patch.object(self.checker, "_check_goplus", return_value=goplus), \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot):
            verdict = await self.checker.scan_token("0xruggable")

        assert verdict.passed is False
        assert verdict.risk_level == "CRITICAL"
        assert any("owner_can_modify" in r for r in verdict.rejection_reasons)
        assert any("selfdestruct" in r for r in verdict.rejection_reasons)

    @pytest.mark.asyncio
    async def test_scan_api_failure_fail_closed(self):
        with patch.object(
            self.checker, "_check_goplus", side_effect=Exception("timeout")
        ), patch.object(
            self.checker, "_check_honeypot_is", side_effect=Exception("timeout")
        ), patch.dict(os.environ, {"SECURITY_FAIL_OPEN": "false"}):
            verdict = await self.checker.scan_token("0xunknown")

        # Default is fail-closed — should reject
        assert verdict.passed is False

    @pytest.mark.asyncio
    async def test_scan_caching(self):
        goplus = GoPlusResult(buy_tax_pct=1.0)
        honeypot = HoneypotResult()

        with patch.object(self.checker, "_check_goplus", return_value=goplus) as gp_mock, \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot) as hp_mock:
            v1 = await self.checker.scan_token("0xcached")
            v2 = await self.checker.scan_token("0xcached")

        assert v1.token_address == v2.token_address
        # APIs should only be called once due to cache
        assert gp_mock.call_count == 1
        assert hp_mock.call_count == 1

    @pytest.mark.asyncio
    async def test_scan_records_duration(self):
        goplus = GoPlusResult()
        honeypot = HoneypotResult()

        with patch.object(self.checker, "_check_goplus", return_value=goplus), \
             patch.object(self.checker, "_check_honeypot_is", return_value=honeypot):
            verdict = await self.checker.scan_token("0xduration")

        assert verdict.duration_ms >= 0


# ── l3_ecosystem_sniper tests ──────────────────────────────────────────────

from advanced_strategies.l3_ecosystem_sniper import (
    L3EcosystemSniper,
    BridgeFlow,
    BridgeSpike,
    NewPair,
    SniperOpportunity,
    get_l3_sniper,
)


class TestL3EcosystemSniper:
    """Tests for the L3 bridge flow monitoring and pair sniping."""

    def setup_method(self):
        L3EcosystemSniper._instance = None
        self.sniper = get_l3_sniper()

    # ── Singleton ───────────────────────────────────────────────────

    def test_singleton(self):
        a = get_l3_sniper()
        b = get_l3_sniper()
        assert a is b

    # ── Models ──────────────────────────────────────────────────────

    def test_bridge_flow_model(self):
        flow = BridgeFlow(
            chain_id="33139",
            chain_name="ApeChain",
            amount_eth=10.5,
            tx_hash="0xabc",
        )
        assert flow.amount_eth == 10.5
        assert flow.chain_name == "ApeChain"

    def test_new_pair_model(self):
        pair = NewPair(
            chain_id="33139",
            chain_name="ApeChain",
            pair_address="0xpair",
            token0="0xt0",
            token1="0xt1",
            liquidity_usd=50000,
        )
        assert pair.liquidity_usd == 50000

    # ── Spike Detection ─────────────────────────────────────────────

    def test_spike_detection_insufficient_data(self):
        result = self.sniper.detect_spike("apechain", 10.0)
        assert result is None  # Only 1 sample, need at least 3

    def test_spike_detection_normal_flow(self):
        # Build baseline
        for _ in range(5):
            self.sniper.detect_spike("apechain", 10.0)

        # Normal flow — no spike
        result = self.sniper.detect_spike("apechain", 12.0)
        assert result is None  # 20% above avg < 50% threshold

    def test_spike_detection_triggered(self):
        # Build varied baseline (natural bridge flow variance, mean ≈ 10)
        baseline = [8.0, 12.0, 9.0, 11.0, 10.0, 13.0, 7.0, 11.0, 9.0, 12.0,
                    8.0, 10.0, 11.0, 9.0, 10.0, 12.0, 8.0, 11.0, 10.0, 9.0]
        for val in baseline:
            self.sniper.detect_spike("apechain", val)

        # Sustained spike: 8 consecutive 30 ETH flows fills WINDOW_SHORT
        # short_mean=30, Z=(30-10)/σ ≈ 12.6, spike_pct=200%
        for _ in range(7):
            self.sniper.detect_spike("apechain", 30.0)
        result = self.sniper.detect_spike("apechain", 30.0)
        assert result is not None
        assert isinstance(result, BridgeSpike)
        assert result.spike_pct >= 50.0

    # ── Opportunity Scoring ─────────────────────────────────────────

    def test_score_opportunity(self):
        spike = BridgeSpike(
            chain_id="33139",
            chain_name="ApeChain",
            current_rate_eth=20.0,
            rolling_avg_eth=10.0,
            spike_pct=100.0,
        )
        pair = NewPair(
            chain_id="33139",
            chain_name="ApeChain",
            pair_address="0x123",
            token0="0xa",
            token1="0xb",
            liquidity_usd=50000,
            created_at=time.time() - 300,  # 5 min ago
        )
        score = self.sniper.score_opportunity(spike, pair)
        assert 0 <= score <= 100
        assert score > 0  # Should have non-trivial score

    def test_score_opportunity_stale_pair(self):
        spike = BridgeSpike(
            chain_id="33139",
            chain_name="ApeChain",
            current_rate_eth=20.0,
            rolling_avg_eth=10.0,
            spike_pct=100.0,
        )
        pair = NewPair(
            chain_id="33139",
            chain_name="ApeChain",
            pair_address="0x123",
            token0="0xa",
            token1="0xb",
            liquidity_usd=50000,
            created_at=time.time() - 7200,  # 2 hours ago — stale
        )
        score = self.sniper.score_opportunity(spike, pair)
        # Stale pair should score lower (freshness = 0)
        assert score < 80

    # ── Status ──────────────────────────────────────────────────────

    def test_get_status(self):
        status = self.sniper.get_status()
        assert "running" in status
        assert "chains_monitored" in status
        assert isinstance(status["chains_monitored"], list)


# ── intent_arbitrage tests ─────────────────────────────────────────────────

from advanced_strategies.intent_arbitrage import (
    IntentArbitrageEngine,
    DEXQuote,
    ArbitrageSignal,
    IntentOverride,
    get_intent_arbitrage,
)


class TestIntentArbitrage:
    """Tests for the cross-DEX price comparison engine."""

    def setup_method(self):
        IntentArbitrageEngine._instance = None
        self.engine = get_intent_arbitrage()

    # ── Singleton ───────────────────────────────────────────────────

    def test_singleton(self):
        a = get_intent_arbitrage()
        b = get_intent_arbitrage()
        assert a is b

    # ── Models ──────────────────────────────────────────────────────

    def test_dex_quote_model(self):
        q = DEXQuote(
            dex_name="Camelot",
            token_in="0xweth",
            token_out="0xtoken",
            amount_in=1.0,
            amount_out=1000.0,
            price=1000.0,
        )
        assert q.price == 1000.0

    def test_intent_override_defaults(self):
        o = IntentOverride()
        assert o.use_override is False

    def test_intent_override_active(self):
        o = IntentOverride(
            use_override=True,
            start_price=0.001,
            gap_pct=2.5,
            source_dex="Camelot",
        )
        assert o.use_override is True
        assert o.gap_pct == 2.5

    # ── Arbitrage Detection ─────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_no_arbitrage_when_prices_close(self):
        camelot_q = DEXQuote(
            dex_name="Camelot", token_in="w", token_out="t",
            amount_in=1, amount_out=100, price=100.0,
        )
        uni_q = DEXQuote(
            dex_name="UniswapV3", token_in="w", token_out="t",
            amount_in=1, amount_out=100.5, price=100.5,
        )

        with patch.object(self.engine, "_get_camelot_quote", return_value=camelot_q), \
             patch.object(self.engine, "_get_uniswapv3_quote", return_value=uni_q):
            override = await self.engine.check_arbitrage("0xtoken", 1.0)

        assert override.use_override is False  # 0.5% < 1% threshold

    @pytest.mark.asyncio
    async def test_arbitrage_detected_when_gap_large(self):
        camelot_q = DEXQuote(
            dex_name="Camelot", token_in="w", token_out="t",
            amount_in=1, amount_out=100, price=100.0,
        )
        uni_q = DEXQuote(
            dex_name="UniswapV3", token_in="w", token_out="t",
            amount_in=1, amount_out=103, price=103.0,
        )

        with patch.object(self.engine, "_get_camelot_quote", return_value=camelot_q), \
             patch.object(self.engine, "_get_uniswapv3_quote", return_value=uni_q):
            override = await self.engine.check_arbitrage("0xtoken", 1.0)

        assert override.use_override is True
        assert override.gap_pct >= 1.0
        assert override.start_price < 100.0  # Below cheapest price
        assert override.source_dex == "Camelot"

    @pytest.mark.asyncio
    async def test_arbitrage_handles_api_failure(self):
        with patch.object(
            self.engine, "_get_camelot_quote", side_effect=Exception("timeout")
        ), patch.object(
            self.engine, "_get_uniswapv3_quote", side_effect=Exception("timeout")
        ):
            override = await self.engine.check_arbitrage("0xfail", 1.0)

        assert override.use_override is False

    @pytest.mark.asyncio
    async def test_arbitrage_handles_zero_price(self):
        camelot_q = DEXQuote(
            dex_name="Camelot", token_in="w", token_out="t",
            amount_in=1, amount_out=0, price=0,
        )
        uni_q = DEXQuote(
            dex_name="UniswapV3", token_in="w", token_out="t",
            amount_in=1, amount_out=100, price=100.0,
        )

        with patch.object(self.engine, "_get_camelot_quote", return_value=camelot_q), \
             patch.object(self.engine, "_get_uniswapv3_quote", return_value=uni_q):
            override = await self.engine.check_arbitrage("0xzero", 1.0)

        assert override.use_override is False

    # ── Stats ───────────────────────────────────────────────────────

    def test_stats_initial(self):
        stats = self.engine.get_stats()
        assert stats["total_checked"] == 0
        assert stats["total_arb_found"] == 0

    @pytest.mark.asyncio
    async def test_stats_after_check(self):
        camelot_q = DEXQuote(
            dex_name="Camelot", token_in="w", token_out="t",
            amount_in=1, amount_out=100, price=100.0,
        )
        uni_q = DEXQuote(
            dex_name="UniswapV3", token_in="w", token_out="t",
            amount_in=1, amount_out=100, price=100.0,
        )

        with patch.object(self.engine, "_get_camelot_quote", return_value=camelot_q), \
             patch.object(self.engine, "_get_uniswapv3_quote", return_value=uni_q):
            await self.engine.check_arbitrage("0xtest", 1.0)

        stats = self.engine.get_stats()
        assert stats["total_checked"] == 1


# ── whale_shadow tests ─────────────────────────────────────────────────────

from advanced_strategies.whale_shadow import (
    WhaleShadowTracker,
    WhaleBuy,
    WhaleConvergence,
    AggressiveTrigger,
    get_whale_tracker,
)


class TestWhaleShadow:
    """Tests for the whale tracking and convergence detection."""

    def setup_method(self):
        WhaleShadowTracker._instance = None
        self.tracker = get_whale_tracker()

    # ── Singleton ───────────────────────────────────────────────────

    def test_singleton(self):
        a = get_whale_tracker()
        b = get_whale_tracker()
        assert a is b

    # ── Wallet Management ───────────────────────────────────────────

    def test_add_wallet(self):
        self.tracker.add_wallet("0xWhale1")
        assert "0xwhale1" in self.tracker.get_wallets()

    def test_remove_wallet(self):
        self.tracker.add_wallet("0xWhale2")
        self.tracker.remove_wallet("0xWhale2")
        assert "0xwhale2" not in self.tracker.get_wallets()

    def test_load_wallets_bulk(self):
        count = self.tracker.load_wallets(["0xa", "0xb", "0xc"])
        assert count == 3
        assert len(self.tracker.get_wallets()) >= 3

    # ── Models ──────────────────────────────────────────────────────

    def test_whale_buy_model(self):
        buy = WhaleBuy(
            wallet="0xwhale",
            token_address="0xtoken",
            token_symbol="MEME",
            amount_usd=10000,
        )
        assert buy.amount_usd == 10000
        assert buy.chain == "arbitrum"

    def test_convergence_model(self):
        c = WhaleConvergence(
            token_address="0xtoken",
            whale_count=3,
            total_usd=30000,
            wallets=["0xa", "0xb", "0xc"],
        )
        assert c.whale_count == 3
        assert len(c.wallets) == 3

    # ── Convergence Detection ───────────────────────────────────────

    def test_no_convergence_single_whale(self):
        buy = WhaleBuy(
            wallet="0xwhale1",
            token_address="0xtoken",
            amount_usd=10000,
        )
        result = self.tracker.record_buy(buy)
        assert result is None  # 1 whale < 3 threshold

    def test_no_convergence_two_whales(self):
        for i in range(2):
            buy = WhaleBuy(
                wallet=f"0xwhale{i}",
                token_address="0xtoken",
                amount_usd=10000,
            )
            self.tracker.record_buy(buy)

        assert len(self.tracker.get_convergences()) == 0

    def test_convergence_three_whales(self):
        for i in range(3):
            buy = WhaleBuy(
                wallet=f"0xwhale{i}",
                token_address="0xtoken",
                token_symbol="MEME",
                amount_usd=10000,
            )
            result = self.tracker.record_buy(buy)

        # Third whale should trigger convergence
        assert result is not None
        assert isinstance(result, WhaleConvergence)
        assert result.whale_count == 3
        assert result.total_usd == 30000

    def test_convergence_requires_min_amount(self):
        # Buys below MIN_BUY_VALUE_USD should not count
        for i in range(3):
            buy = WhaleBuy(
                wallet=f"0xwhale{i}",
                token_address="0xsmall",
                amount_usd=100,  # Below $5000 threshold
            )
            result = self.tracker.record_buy(buy)

        assert result is None

    def test_convergence_different_tokens_no_trigger(self):
        for i in range(3):
            buy = WhaleBuy(
                wallet=f"0xwhale{i}",
                token_address=f"0xtoken{i}",  # Different tokens
                amount_usd=10000,
            )
            result = self.tracker.record_buy(buy)

        assert result is None

    def test_duplicate_wallet_counts_once(self):
        # Same whale buying twice should count as 1
        for _ in range(3):
            buy = WhaleBuy(
                wallet="0xsamewhale",
                token_address="0xtoken",
                amount_usd=10000,
            )
            result = self.tracker.record_buy(buy)

        assert result is None  # Only 1 unique whale

    # ── AGGRESSIVE Trigger ──────────────────────────────────────────

    @pytest.mark.asyncio
    async def test_trigger_aggressive_security_passed(self):
        convergence = WhaleConvergence(
            token_address="0xtoken",
            token_symbol="MEME",
            whale_count=3,
            total_usd=30000,
            wallets=["0xa", "0xb", "0xc"],
        )

        with patch("advanced_strategies.whale_shadow.get_tuner") as mock_tuner:
            mock_tuner.return_value.get_regime.return_value = "NORMAL"
            trigger = await self.tracker.trigger_aggressive(convergence, security_passed=True)

        assert trigger is not None
        assert trigger.security_passed is True
        assert trigger.previous_regime == "NORMAL"

    @pytest.mark.asyncio
    async def test_trigger_aggressive_security_failed(self):
        convergence = WhaleConvergence(
            token_address="0xtoken",
            whale_count=3,
            total_usd=30000,
            wallets=["0xa", "0xb", "0xc"],
        )

        trigger = await self.tracker.trigger_aggressive(convergence, security_passed=False)
        assert trigger is None  # Should not trigger when security fails

    # ── Status ──────────────────────────────────────────────────────

    def test_status(self):
        status = self.tracker.get_status()
        assert "running" in status
        assert "wallets_tracked" in status
        assert "aggressive_active" in status
        assert status["aggressive_active"] is False

    def test_aggressive_not_active_initially(self):
        assert self.tracker.is_aggressive_active() is False


# ── Integration tests ──────────────────────────────────────────────────────

class TestSecurityIntegration:
    """Integration tests for security checker in trade flow."""

    def test_verdict_serialization(self):
        verdict = SecurityVerdict(
            token_address="0xabc",
            passed=False,
            risk_level="CRITICAL",
            rejection_reasons=["goplus_honeypot_detected"],
        )
        data = verdict.model_dump()
        assert data["token_address"] == "0xabc"
        assert data["passed"] is False
        assert data["risk_level"] == "CRITICAL"

    def test_arbitrage_signal_serialization(self):
        signal = ArbitrageSignal(
            token_address="0xtoken",
            cheaper_dex="Camelot",
            expensive_dex="UniswapV3",
            cheap_price=100.0,
            expensive_price=103.0,
            gap_pct=3.0,
            recommended_start_price=99.85,
            amount_in=1.0,
        )
        data = signal.model_dump()
        assert data["gap_pct"] == 3.0

    def test_sniper_opportunity_serialization(self):
        spike = BridgeSpike(
            chain_id="33139",
            chain_name="ApeChain",
            current_rate_eth=20.0,
            rolling_avg_eth=10.0,
            spike_pct=100.0,
        )
        pair = NewPair(
            chain_id="33139",
            chain_name="ApeChain",
            pair_address="0xpair",
            token0="0xa",
            token1="0xb",
        )
        opp = SniperOpportunity(spike=spike, pair=pair, score=75.0)
        data = opp.model_dump()
        assert data["score"] == 75.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
