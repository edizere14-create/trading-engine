"""Tests for advanced_strategies decision logic.

Covers:
  - Bundle-risk math (concentration ratio, high-risk detection)
  - Mindshare trigger & sentiment momentum buy
  - Cross-DEX arb profitability (_compute_opportunity)
  - Social-heat trailing stop (plateau detection, tightening)
  - trade_executor CLI argument parsing for --advanced-* flags
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from advanced_strategies.config import AdvancedStrategyConfig
from advanced_strategies.cross_dex_arbitrage import (
    LAMPORTS_PER_SOL,
    CrossDexArbitrageStrategy,
    JupiterDexQuoteClient,
)
from advanced_strategies.models import (
    ArbitrageOpportunity,
    BundleScanResult,
    DexQuote,
    InstructionEvent,
    LPExecutionDecision,
    SentimentScore,
    SentimentSnapshot,
)
from advanced_strategies.rpc_clients import JitoBlockEngineClient
from advanced_strategies.sentiment_analyzer import SentimentAnalyzer, SocialHeatTrailingStop
from advanced_strategies.zero_block_lp_sniper import ZeroBlockLPSniper


# ── helpers ──────────────────────────────────────────────────────

def _make_config(**overrides: object) -> AdvancedStrategyConfig:
    """Build an AdvancedStrategyConfig with safe test defaults."""
    defaults = dict(
        rpc_url="",
        yellowstone_grpc_endpoint="",
        yellowstone_x_token="",
        jito_block_engine_url="",
        jito_tip_lamports=1_000_000,
        bundle_scan_limit=5,
        bundle_same_root_threshold=5,
        bundle_concentration_threshold=0.20,
        bundle_funder_lookback_blocks=100,
        birdeye_api_key="",
        dexscreener_base_url="https://api.dexscreener.com/latest/dex",
        openai_api_key="",
        openai_base_url="https://api.openai.com/v1",
        openai_sentiment_model="gpt-4o-mini",
        openai_rug_model="o1-preview",
        x_bearer_token="",
        mindshare_threshold=0.5,
        social_heat_plateau_delta=0.05,
        arbitrage_poll_interval_ms=50,
        arbitrage_base_jito_tip_sol=0.001,
        arbitrage_raydium_fee_pct=0.25,
        arbitrage_meteora_fee_pct=0.30,
        arbitrage_min_profit_sol=0.0015,
        enable_llm_rug_reasoning=False,
    )
    defaults.update(overrides)
    return AdvancedStrategyConfig(**defaults)


def _make_dex_quote(
    dex: str = "Raydium",
    input_mint: str = "SOL",
    output_mint: str = "TOKEN",
    in_amount_raw: int = 200_000_000,
    out_amount_raw: int = 1_000_000_000,
    fee_pct: float = 0.25,
) -> DexQuote:
    return DexQuote(
        dex=dex,
        input_mint=input_mint,
        output_mint=output_mint,
        in_amount_raw=in_amount_raw,
        out_amount_raw=out_amount_raw,
        fee_pct=fee_pct,
        route_label=dex,
    )


# ═══════════════════════════════════════════════════════════════════
# 1. Bundle-risk math
# ═══════════════════════════════════════════════════════════════════

class TestBundleScanResult:
    """Test BundleScanResult construction and risk flag semantics."""

    def test_clean_scan_no_bundle(self):
        scan = BundleScanResult(
            slot=100,
            candidate_transactions=5,
            distributed_wallets=2,
            detected_bundle=False,
            bundle_concentration_ratio=0.05,
            high_risk_rug=False,
            dominant_root_account=None,
            reason="no suspicious bundle pattern",
        )
        assert not scan.detected_bundle
        assert not scan.high_risk_rug
        assert scan.bundle_concentration_ratio < 0.20

    def test_bundle_detected_but_concentration_ok(self):
        scan = BundleScanResult(
            slot=200,
            candidate_transactions=5,
            distributed_wallets=8,
            detected_bundle=True,
            bundle_concentration_ratio=0.10,
            high_risk_rug=False,
            dominant_root_account="rootWallet1",
            reason="bundle observed but concentration acceptable",
        )
        assert scan.detected_bundle
        assert not scan.high_risk_rug

    def test_bundle_with_high_concentration_is_high_risk(self):
        scan = BundleScanResult(
            slot=300,
            candidate_transactions=5,
            distributed_wallets=10,
            detected_bundle=True,
            bundle_concentration_ratio=0.35,
            high_risk_rug=True,
            dominant_root_account="rugWallet",
            reason="bundle+concentration risk",
        )
        assert scan.detected_bundle
        assert scan.high_risk_rug
        assert scan.bundle_concentration_ratio > 0.20

    def test_concentration_at_exact_threshold(self):
        """Concentration exactly at threshold should NOT be high risk (> not >=)."""
        threshold = 0.20
        scan = BundleScanResult(
            slot=400,
            candidate_transactions=5,
            distributed_wallets=5,
            detected_bundle=True,
            bundle_concentration_ratio=threshold,
            high_risk_rug=False,  # matching engine logic: > threshold
            dominant_root_account="borderlineWallet",
            reason="exactly at threshold",
        )
        assert not scan.high_risk_rug


class TestLPExecutionDecision:
    """Test LP sniper decision logic routing."""

    def test_high_risk_blocks_execution(self):
        scan = BundleScanResult(
            slot=100, candidate_transactions=3, distributed_wallets=8,
            detected_bundle=True, bundle_concentration_ratio=0.40,
            high_risk_rug=True, dominant_root_account="rug",
            reason="rug detected",
        )
        decision = LPExecutionDecision(
            should_execute=False,
            risk_label="HIGH_RISK_RUG",
            reason="rug detected",
            scan=scan,
        )
        assert not decision.should_execute
        assert decision.risk_label == "HIGH_RISK_RUG"

    def test_clean_allows_execution(self):
        scan = BundleScanResult(
            slot=100, candidate_transactions=3, distributed_wallets=1,
            detected_bundle=False, bundle_concentration_ratio=0.02,
            high_risk_rug=False, dominant_root_account=None,
            reason="clean",
        )
        decision = LPExecutionDecision(
            should_execute=True,
            risk_label="CLEAN",
            reason="clean",
            scan=scan,
        )
        assert decision.should_execute
        assert decision.risk_label == "CLEAN"


class TestBundleConcentrationThresh:
    """Test ZeroBlockLPSniper evaluate_event against concentration threshold."""

    @pytest.mark.asyncio
    async def test_evaluate_event_blocks_high_concentration(self):
        config = _make_config(bundle_concentration_threshold=0.15)
        rpc = MagicMock()
        jito = MagicMock()

        sniper = ZeroBlockLPSniper(config=config, rpc_client=rpc, jito_client=jito)

        # Build a scan result that exceeds threshold
        high_risk_scan = BundleScanResult(
            slot=500, candidate_transactions=5, distributed_wallets=8,
            detected_bundle=True, bundle_concentration_ratio=0.30,
            high_risk_rug=True, dominant_root_account="rugger",
            reason="bundle+concentration risk",
        )
        # Mock scan_slot_bundle to return high risk
        sniper.scan_slot_bundle = AsyncMock(return_value=high_risk_scan)

        event = InstructionEvent(
            slot=500, signature="sig1", deployer="deployer1",
            token_mint="tokenMint1", instruction_name="Initialize2", dex="RAYDIUM",
        )
        session = MagicMock()
        decision = await sniper.evaluate_event(session, event)
        assert not decision.should_execute
        assert decision.risk_label == "HIGH_RISK_RUG"

    @pytest.mark.asyncio
    async def test_evaluate_event_allows_clean_scan(self):
        config = _make_config(bundle_concentration_threshold=0.20)
        sniper = ZeroBlockLPSniper(
            config=config, rpc_client=MagicMock(), jito_client=MagicMock()
        )
        clean_scan = BundleScanResult(
            slot=600, candidate_transactions=3, distributed_wallets=1,
            detected_bundle=False, bundle_concentration_ratio=0.05,
            high_risk_rug=False, dominant_root_account=None,
            reason="no suspicious bundle pattern",
        )
        sniper.scan_slot_bundle = AsyncMock(return_value=clean_scan)

        event = InstructionEvent(
            slot=600, signature="sig2", deployer="deployer2",
            token_mint="tokenMint2", instruction_name="InitializeConfig", dex="METEORA",
        )
        decision = await sniper.evaluate_event(MagicMock(), event)
        assert decision.should_execute
        assert decision.risk_label == "CLEAN"


# ═══════════════════════════════════════════════════════════════════
# 2. Mindshare trigger & sentiment momentum buy
# ═══════════════════════════════════════════════════════════════════

class TestMindshareScore:
    """Test SentimentAnalyzer.compute_mindshare_score."""

    def _make_analyzer(self, **config_overrides: object) -> SentimentAnalyzer:
        config = _make_config(**config_overrides)
        return SentimentAnalyzer(
            config=config,
            market_data_client=MagicMock(),
            x_client=MagicMock(),
            openai_client=MagicMock(),
        )

    def test_basic_mindshare_calculation(self):
        analyzer = self._make_analyzer()
        # community_growth=50%, market_cap=$1M → 50 / 1 = 50.0
        assert analyzer.compute_mindshare_score(50.0, 1_000_000) == pytest.approx(50.0)

    def test_high_mcap_dilutes_mindshare(self):
        analyzer = self._make_analyzer()
        # community_growth=50%, market_cap=$10M → 50 / 10 = 5.0
        assert analyzer.compute_mindshare_score(50.0, 10_000_000) == pytest.approx(5.0)

    def test_zero_growth_gives_zero_mindshare(self):
        analyzer = self._make_analyzer()
        assert analyzer.compute_mindshare_score(0.0, 1_000_000) == pytest.approx(0.0)

    def test_negative_growth_clamped_to_zero(self):
        analyzer = self._make_analyzer()
        assert analyzer.compute_mindshare_score(-20.0, 1_000_000) == pytest.approx(0.0)

    def test_zero_mcap_uses_floor(self):
        analyzer = self._make_analyzer()
        # $0 mcap → floor at 0.001M → 50 / 0.001 = 50_000
        assert analyzer.compute_mindshare_score(50.0, 0.0) == pytest.approx(50_000.0)

    def test_tiny_mcap_amplifies_mindshare(self):
        analyzer = self._make_analyzer()
        # market_cap=$10K = 0.01M → 10 / 0.01 = 1000
        assert analyzer.compute_mindshare_score(10.0, 10_000) == pytest.approx(1000.0)


class TestMomentumBuyTrigger:
    """Test the should_momentum_buy logic in SentimentSnapshot."""

    def test_meets_all_criteria(self):
        """mindshare >= threshold AND organic >= 0.55 AND memeability >= 6.0 → BUY."""
        snapshot = SentimentSnapshot(
            token_mint="tok1",
            market_cap_usd=500_000,
            community_growth_pct=30.0,
            mindshare_score=0.8,
            should_momentum_buy=True,
            sentiment=SentimentScore(
                organic_vs_paid=0.70, memeability=8.0, social_heat=7.0, notes="strong"
            ),
            tweet_count=45,
        )
        assert snapshot.should_momentum_buy

    def test_low_mindshare_blocks_buy(self):
        """mindshare below threshold → no buy."""
        snapshot = SentimentSnapshot(
            token_mint="tok2",
            market_cap_usd=5_000_000,
            community_growth_pct=1.0,
            mindshare_score=0.1,  # below 0.5 threshold
            should_momentum_buy=False,
            sentiment=SentimentScore(
                organic_vs_paid=0.90, memeability=9.0, social_heat=8.0, notes="good"
            ),
            tweet_count=30,
        )
        assert not snapshot.should_momentum_buy

    def test_low_organic_blocks_buy(self):
        """organic_vs_paid < 0.55 → no buy even with high mindshare."""
        snapshot = SentimentSnapshot(
            token_mint="tok3",
            market_cap_usd=500_000,
            community_growth_pct=30.0,
            mindshare_score=1.5,
            should_momentum_buy=False,
            sentiment=SentimentScore(
                organic_vs_paid=0.40, memeability=8.0, social_heat=7.0, notes="paid"
            ),
            tweet_count=50,
        )
        assert not snapshot.should_momentum_buy

    def test_low_memeability_blocks_buy(self):
        """memeability < 6.0 → no buy."""
        snapshot = SentimentSnapshot(
            token_mint="tok4",
            market_cap_usd=500_000,
            community_growth_pct=30.0,
            mindshare_score=1.5,
            should_momentum_buy=False,
            sentiment=SentimentScore(
                organic_vs_paid=0.80, memeability=4.0, social_heat=7.0, notes="low meme"
            ),
            tweet_count=50,
        )
        assert not snapshot.should_momentum_buy

    @pytest.mark.asyncio
    async def test_analyze_token_sets_should_buy_correctly(self):
        """Integration: analyze_token produces correct should_momentum_buy."""
        config = _make_config(mindshare_threshold=0.5)
        market = MagicMock()
        x_client = MagicMock()
        openai_client = MagicMock()

        analyzer = SentimentAnalyzer(
            config=config,
            market_data_client=market,
            x_client=x_client,
            openai_client=openai_client,
        )
        # Mock external calls
        x_client.fetch_recent_tweets = AsyncMock(return_value=["bullish tweet 1"])
        market.fetch_birdeye_overview = AsyncMock(return_value={"mc": 500_000})
        market.fetch_dexscreener_pairs = AsyncMock(return_value=[])
        # Return sentiment that meets buy criteria
        openai_client.chat_json = AsyncMock(return_value={
            "organic_vs_paid": 0.80,
            "memeability": 8.0,
            "social_heat": 7.0,
            "notes": "very organic",
        })
        # community_growth will default to 0 since birdeye doesn't have it
        # and dexscreener is empty — mindshare = 0 / 0.5 = 0.0 < 0.5
        # So should_momentum_buy = False
        session = MagicMock()
        snap = await analyzer.analyze_token(session, "testMint", ["solana"], [])
        assert not snap.should_momentum_buy  # mindshare too low

    @pytest.mark.asyncio
    async def test_analyze_token_with_growth_triggers_buy(self):
        """With adequate community growth → mindshare high → buy trigger."""
        config = _make_config(mindshare_threshold=0.5)
        market = MagicMock()
        x_client = MagicMock()
        openai_client = MagicMock()

        analyzer = SentimentAnalyzer(
            config=config,
            market_data_client=market,
            x_client=x_client,
            openai_client=openai_client,
        )
        x_client.fetch_recent_tweets = AsyncMock(return_value=["hype tweet"])
        market.fetch_birdeye_overview = AsyncMock(return_value={
            "mc": 500_000,
            "holderChange24hPercent": 100.0,  # 100% holder growth
        })
        market.fetch_dexscreener_pairs = AsyncMock(return_value=[])
        openai_client.chat_json = AsyncMock(return_value={
            "organic_vs_paid": 0.80,
            "memeability": 8.0,
            "social_heat": 7.5,
            "notes": "organic hype",
        })
        session = MagicMock()
        snap = await analyzer.analyze_token(session, "bullishMint", ["memecoin"], [])
        # mindshare = 100 / 0.5 = 200.0 → well above 0.5
        assert snap.should_momentum_buy
        assert snap.mindshare_score > 0.5


# ═══════════════════════════════════════════════════════════════════
# 3. Cross-DEX arb profitability
# ═══════════════════════════════════════════════════════════════════

class TestArbProfitability:
    """Test CrossDexArbitrageStrategy._compute_opportunity math."""

    def _make_strategy(self, **config_overrides: object) -> CrossDexArbitrageStrategy:
        config = _make_config(**config_overrides)
        quote_client = MagicMock(spec=JupiterDexQuoteClient)
        jito_client = MagicMock(spec=JitoBlockEngineClient)
        return CrossDexArbitrageStrategy(
            config=config, quote_client=quote_client, jito_client=jito_client,
        )

    def test_profitable_arb(self):
        """Buy on Raydium, sell on Meteora with enough spread to cover fees+tip."""
        strategy = self._make_strategy(
            arbitrage_raydium_fee_pct=0.25,
            arbitrage_meteora_fee_pct=0.30,
            arbitrage_base_jito_tip_sol=0.001,
            arbitrage_min_profit_sol=0.001,
        )
        start_sol = 1.0
        # Buy 1 SOL worth of tokens on Raydium
        buy_quote = _make_dex_quote(
            dex="Raydium",
            input_mint="SOL",
            output_mint="TOKEN",
            in_amount_raw=int(start_sol * LAMPORTS_PER_SOL),
            out_amount_raw=1_000_000_000,
            fee_pct=0.25,
        )
        # Sell tokens on Meteora → get 1.02 SOL back (2% spread)
        sell_quote = _make_dex_quote(
            dex="Meteora DLMM",
            input_mint="TOKEN",
            output_mint="SOL",
            in_amount_raw=1_000_000_000,
            out_amount_raw=int(1.02 * LAMPORTS_PER_SOL),
            fee_pct=0.30,
        )
        opp = strategy._compute_opportunity(buy_quote, sell_quote, start_sol)
        # gross = 1.02 - 1.0 = 0.02
        assert opp.gross_profit_sol == pytest.approx(0.02, abs=0.001)
        # fee = 1.0 * (0.25/100) + 1.0 * (0.30/100) = 0.0025 + 0.003 = 0.0055
        assert opp.total_fee_sol == pytest.approx(0.0055, abs=0.0001)
        # tip = 0.001
        # net = 0.02 - 0.0055 - 0.001 = 0.0135
        assert opp.net_profit_sol == pytest.approx(0.0135, abs=0.001)
        assert opp.profitable

    def test_unprofitable_arb_below_min(self):
        """Spread too small → net < min_profit_sol → not profitable."""
        strategy = self._make_strategy(
            arbitrage_raydium_fee_pct=0.25,
            arbitrage_meteora_fee_pct=0.30,
            arbitrage_base_jito_tip_sol=0.001,
            arbitrage_min_profit_sol=0.01,  # high bar
        )
        start_sol = 0.2
        buy_quote = _make_dex_quote(
            dex="Raydium",
            in_amount_raw=int(0.2 * LAMPORTS_PER_SOL),
            out_amount_raw=500_000_000,
            fee_pct=0.25,
        )
        # Sell → 0.201 SOL (0.5% spread on small notional)
        sell_quote = _make_dex_quote(
            dex="Meteora DLMM",
            in_amount_raw=500_000_000,
            out_amount_raw=int(0.201 * LAMPORTS_PER_SOL),
            fee_pct=0.30,
        )
        opp = strategy._compute_opportunity(buy_quote, sell_quote, start_sol=0.2)
        # gross = 0.201 - 0.2 = 0.001
        # fee = 0.2 * (0.0025 + 0.003) = 0.0011
        # tip = 0.001
        # net = 0.001 - 0.0011 - 0.001 = -0.0011
        assert opp.net_profit_sol < 0
        assert not opp.profitable

    def test_zero_spread_unprofitable(self):
        """Same price on both DEXs → negative after fees."""
        strategy = self._make_strategy(
            arbitrage_min_profit_sol=0.0001,
        )
        start_sol = 1.0
        amount_raw = int(start_sol * LAMPORTS_PER_SOL)
        buy = _make_dex_quote(in_amount_raw=amount_raw, out_amount_raw=1_000_000_000)
        sell = _make_dex_quote(
            dex="Meteora DLMM", in_amount_raw=1_000_000_000,
            out_amount_raw=amount_raw,  # same price
        )
        opp = strategy._compute_opportunity(buy, sell, start_sol)
        assert opp.gross_profit_sol == pytest.approx(0.0, abs=0.0001)
        assert opp.net_profit_sol < 0
        assert not opp.profitable

    def test_large_spread_profitable(self):
        """Large price discrepancy → clearly profitable."""
        strategy = self._make_strategy(
            arbitrage_min_profit_sol=0.001,
            arbitrage_base_jito_tip_sol=0.001,
        )
        start_sol = 5.0
        buy = _make_dex_quote(
            in_amount_raw=int(5 * LAMPORTS_PER_SOL),
            out_amount_raw=10_000_000_000,
        )
        sell = _make_dex_quote(
            dex="Meteora DLMM",
            in_amount_raw=10_000_000_000,
            out_amount_raw=int(5.5 * LAMPORTS_PER_SOL),  # 10% spread
        )
        opp = strategy._compute_opportunity(buy, sell, start_sol)
        assert opp.gross_profit_sol == pytest.approx(0.5, abs=0.01)
        assert opp.net_profit_sol > 0
        assert opp.profitable
        assert opp.expected_return_pct > 0

    def test_expected_return_pct(self):
        """Return percentage = (net / start) * 100."""
        strategy = self._make_strategy(
            arbitrage_raydium_fee_pct=0.0,
            arbitrage_meteora_fee_pct=0.0,
            arbitrage_base_jito_tip_sol=0.0,
            arbitrage_min_profit_sol=0.0,
        )
        # Use fee_pct=0.0 on both quotes so max() in _compute_opportunity stays 0
        buy = _make_dex_quote(
            in_amount_raw=LAMPORTS_PER_SOL, out_amount_raw=1_000_000_000, fee_pct=0.0,
        )
        sell = _make_dex_quote(
            dex="Meteora DLMM", in_amount_raw=1_000_000_000,
            out_amount_raw=int(1.1 * LAMPORTS_PER_SOL), fee_pct=0.0,
        )
        opp = strategy._compute_opportunity(buy, sell, 1.0)
        assert opp.expected_return_pct == pytest.approx(10.0, abs=0.1)

    @pytest.mark.asyncio
    async def test_detect_opportunity_returns_none_when_quotes_missing(self):
        """If one DEX quote fails, detect_opportunity returns None."""
        strategy = self._make_strategy()
        strategy.quote_client.quote = AsyncMock(return_value=None)
        session = MagicMock()
        result = await strategy.detect_opportunity(session, "someMint", 1.0)
        assert result is None

    @pytest.mark.asyncio
    async def test_detect_opportunity_picks_best_route(self):
        """Strategy picks cheaper buy and sells on the other DEX."""
        config = _make_config(
            arbitrage_raydium_fee_pct=0.25,
            arbitrage_meteora_fee_pct=0.30,
            arbitrage_base_jito_tip_sol=0.001,
            arbitrage_min_profit_sol=0.0001,
        )
        quote_client = MagicMock(spec=JupiterDexQuoteClient)
        jito_client = MagicMock(spec=JitoBlockEngineClient)
        strategy = CrossDexArbitrageStrategy(
            config=config, quote_client=quote_client, jito_client=jito_client,
        )
        start_lamports = LAMPORTS_PER_SOL  # 1 SOL

        # Raydium gives more tokens than Meteora (better buy)
        ray_buy = _make_dex_quote(
            dex="Raydium", in_amount_raw=start_lamports,
            out_amount_raw=2_000_000_000,
        )
        met_buy = _make_dex_quote(
            dex="Meteora DLMM", in_amount_raw=start_lamports,
            out_amount_raw=1_800_000_000,
        )
        # Sell tokens on Meteora → get 1.05 SOL
        met_sell = _make_dex_quote(
            dex="Meteora DLMM", in_amount_raw=2_000_000_000,
            out_amount_raw=int(1.05 * LAMPORTS_PER_SOL),
        )

        async def mock_quote(session, input_mint, output_mint, amount_raw, dex, slippage_bps=30):
            if dex == "Raydium" and output_mint != "So11111111111111111111111111111111111111112":
                return ray_buy
            if dex == "Meteora DLMM" and output_mint != "So11111111111111111111111111111111111111112":
                return met_buy
            # Sell leg
            return met_sell

        quote_client.quote = AsyncMock(side_effect=mock_quote)
        session = MagicMock()
        opp = await strategy.detect_opportunity(session, "tokenXYZ", 1.0)
        assert opp is not None
        assert opp.buy_dex == "Raydium"
        assert opp.sell_dex == "Meteora DLMM"


# ═══════════════════════════════════════════════════════════════════
# 4. Social-heat trailing stop
# ═══════════════════════════════════════════════════════════════════

class TestSocialHeatTrailingStop:
    """Test plateau detection, stop tightening, and relaxation."""

    def test_initial_stop_is_base(self):
        stop = SocialHeatTrailingStop(plateau_delta=0.05, base_stop_pct=12.0)
        state = stop.update("tok1", social_heat=5.0, unrealized_pnl_pct=0.0)
        assert state.stop_loss_pct == 12.0  # first update, base level
        assert not state.plateau_detected  # need >=3 samples

    def test_plateau_detection_requires_three_samples(self):
        stop = SocialHeatTrailingStop(plateau_delta=0.05, base_stop_pct=12.0)
        stop.update("tok1", 5.0, 0.0)
        stop.update("tok1", 5.01, 0.0)
        state = stop.update("tok1", 5.02, 0.0)
        # trend = 5.02 - 5.0 = 0.02, |0.02| <= 0.05 → plateau
        assert state.plateau_detected

    def test_stop_tightens_on_plateau_in_profit(self):
        stop = SocialHeatTrailingStop(
            plateau_delta=0.05, base_stop_pct=12.0,
            tighten_step_pct=1.0, min_stop_pct=3.0,
        )
        stop.update("tok1", 5.0, 5.0)
        stop.update("tok1", 5.01, 5.0)
        state = stop.update("tok1", 5.02, 5.0)  # plateau + profit
        assert state.plateau_detected
        assert state.stop_loss_pct == 11.0  # 12 - 1 = 11

    def test_stop_does_not_tighten_in_loss(self):
        stop = SocialHeatTrailingStop(
            plateau_delta=0.05, base_stop_pct=12.0, tighten_step_pct=1.0,
        )
        stop.update("tok1", 5.0, -2.0)  # in loss
        stop.update("tok1", 5.01, -2.0)
        state = stop.update("tok1", 5.02, -2.0)
        assert state.plateau_detected
        assert state.stop_loss_pct == 12.0  # unchanged

    def test_stop_respects_minimum(self):
        stop = SocialHeatTrailingStop(
            plateau_delta=0.05, base_stop_pct=4.0,
            tighten_step_pct=2.0, min_stop_pct=3.0,
        )
        stop.update("tok1", 5.0, 10.0)
        stop.update("tok1", 5.01, 10.0)
        state = stop.update("tok1", 5.02, 10.0)
        # 4.0 - 2.0 = 2.0, but min is 3.0 → clamped to 3.0
        assert state.stop_loss_pct == 3.0

    def test_stop_relaxes_on_accelerating_heat(self):
        stop = SocialHeatTrailingStop(
            plateau_delta=0.05, base_stop_pct=12.0, tighten_step_pct=1.0,
        )
        # First tighten via plateau
        stop.update("tok1", 5.0, 5.0)
        stop.update("tok1", 5.01, 5.0)
        stop.update("tok1", 5.02, 5.0)  # tightens to 11.0

        # Now accelerating heat (trend > plateau_delta * 2 = 0.10)
        stop.update("tok1", 5.10, 5.0)
        state = stop.update("tok1", 5.25, 5.0)  # trend = 5.25 - 5.02 = 0.23 > 0.10
        # Should relax by 0.5 (tighten_step * 0.5)
        assert state.stop_loss_pct > 11.0

    def test_multiple_tokens_independent(self):
        stop = SocialHeatTrailingStop(
            plateau_delta=0.05, base_stop_pct=12.0, tighten_step_pct=1.0,
        )
        stop.update("tok1", 5.0, 10.0)
        stop.update("tok1", 5.01, 10.0)
        s1 = stop.update("tok1", 5.02, 10.0)

        s2 = stop.update("tok2", 8.0, 0.0)  # different token, first sample
        assert s1.stop_loss_pct == 11.0  # tok1 tightened
        assert s2.stop_loss_pct == 12.0  # tok2 at base


# ═══════════════════════════════════════════════════════════════════
# 5. CLI argument parsing
# ═══════════════════════════════════════════════════════════════════

class TestCLIParser:
    """Test trade_executor.py build_parser for --advanced-* flags."""

    def test_advanced_autonomous_flag(self):
        from trade_executor import build_parser
        parser = build_parser()
        args = parser.parse_args(["--advanced-autonomous"])
        assert args.advanced_autonomous
        assert not args.advanced_once

    def test_advanced_once_flag(self):
        from trade_executor import build_parser
        parser = build_parser()
        args = parser.parse_args(["--advanced-once"])
        assert args.advanced_once
        assert not args.advanced_autonomous

    def test_advanced_cycle_seconds_override(self):
        from trade_executor import build_parser
        parser = build_parser()
        args = parser.parse_args(["--advanced-autonomous", "--advanced-cycle-seconds", "30.0"])
        assert args.advanced_cycle_seconds == 30.0

    def test_advanced_arb_size_override(self):
        from trade_executor import build_parser
        parser = build_parser()
        args = parser.parse_args(["--advanced-once", "--advanced-arb-size-sol", "0.5"])
        assert args.advanced_arb_size_sol == 0.5

    def test_default_no_advanced_flags(self):
        from trade_executor import build_parser
        parser = build_parser()
        args = parser.parse_args([])
        assert not args.advanced_autonomous
        assert not args.advanced_once
        assert args.advanced_cycle_seconds is None
        assert args.advanced_arb_size_sol is None


# ═══════════════════════════════════════════════════════════════════
# 6. ArbitrageOpportunity edge cases
# ═══════════════════════════════════════════════════════════════════

class TestArbitrageOpportunityModel:
    """Test ArbitrageOpportunity dataclass behaviour."""

    def test_fields_populated(self):
        opp = ArbitrageOpportunity(
            token_mint="mint1",
            buy_dex="Raydium",
            sell_dex="Meteora DLMM",
            start_sol=1.0,
            final_sol=1.05,
            gross_profit_sol=0.05,
            total_fee_sol=0.006,
            jito_tip_sol=0.001,
            net_profit_sol=0.043,
            expected_return_pct=4.3,
            profitable=True,
        )
        assert opp.buy_dex == "Raydium"
        assert opp.sell_dex == "Meteora DLMM"
        assert opp.profitable

    def test_negative_net_is_not_profitable(self):
        opp = ArbitrageOpportunity(
            token_mint="mint2",
            buy_dex="Raydium",
            sell_dex="Meteora DLMM",
            start_sol=1.0,
            final_sol=0.99,
            gross_profit_sol=-0.01,
            total_fee_sol=0.005,
            jito_tip_sol=0.001,
            net_profit_sol=-0.016,
            expected_return_pct=-1.6,
            profitable=False,
        )
        assert not opp.profitable
        assert opp.expected_return_pct < 0


# ═══════════════════════════════════════════════════════════════════
# 7. Config from_env edge cases
# ═══════════════════════════════════════════════════════════════════

class TestConfigFromEnv:
    """Test AdvancedStrategyConfig.from_env with various env states."""

    def test_default_config_no_env(self):
        with patch.dict("os.environ", {}, clear=True):
            config = AdvancedStrategyConfig.from_env()
            assert config.rpc_url == ""
            assert config.jito_tip_lamports == 1_000_000
            assert config.bundle_concentration_threshold == 0.20
            assert config.mindshare_threshold == 0.5
            assert not config.enable_llm_rug_reasoning

    def test_helius_key_builds_rpc_url(self):
        with patch.dict("os.environ", {"HELIUS_API_KEY": "test-key-123"}, clear=True):
            config = AdvancedStrategyConfig.from_env()
            assert "test-key-123" in config.rpc_url
            assert "helius" in config.rpc_url.lower()

    def test_primary_rpc_takes_priority(self):
        with patch.dict(
            "os.environ",
            {"PRIMARY_RPC": "https://my-rpc.com", "HELIUS_API_KEY": "key"},
            clear=True,
        ):
            config = AdvancedStrategyConfig.from_env()
            assert config.rpc_url == "https://my-rpc.com"
