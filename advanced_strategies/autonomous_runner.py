import asyncio
from typing import Any, Awaitable, Callable, Dict, List, Optional, Sequence

import aiohttp

from advanced_strategies.config import AdvancedStrategyConfig
from advanced_strategies.cross_dex_arbitrage import CrossDexArbitrageStrategy, JupiterDexQuoteClient
from advanced_strategies.models import ArbitrageOpportunity, SentimentSnapshot
from advanced_strategies.rpc_clients import (
    JitoBlockEngineClient,
    MarketDataClient,
    OpenAIReasoningClient,
    SolanaRpcClient,
    XApiClient,
)
from advanced_strategies.sentiment_analyzer import SentimentAnalyzer
from advanced_strategies.zero_block_lp_sniper import ZeroBlockLPSniper


def _parse_csv(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


class AdvancedAutonomousEngine:
    def __init__(
        self,
        config: AdvancedStrategyConfig,
        notifier: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.config = config
        self.notify = notifier or (lambda _: None)

        self.rpc_client = SolanaRpcClient(config.rpc_url)
        self.jito_client = JitoBlockEngineClient(config.jito_block_engine_url)
        self.openai_client = OpenAIReasoningClient(config.openai_api_key, config.openai_base_url)
        self.market_client = MarketDataClient(
            birdeye_api_key=config.birdeye_api_key,
            dexscreener_base_url=config.dexscreener_base_url,
        )
        self.x_client = XApiClient(config.x_bearer_token)
        self.sentiment = SentimentAnalyzer(
            config=config,
            market_data_client=self.market_client,
            x_client=self.x_client,
            openai_client=self.openai_client,
        )
        self.arb = CrossDexArbitrageStrategy(
            config=config,
            quote_client=JupiterDexQuoteClient(),
            jito_client=self.jito_client,
        )
        self.sniper = ZeroBlockLPSniper(
            config=config,
            rpc_client=self.rpc_client,
            jito_client=self.jito_client,
            openai_client=self.openai_client,
        )

    async def run_sentiment_cycle(
        self,
        token_mints: Sequence[str],
        keywords: Sequence[str],
        kol_wallets: Sequence[str],
    ) -> List[SentimentSnapshot]:
        snapshots: List[SentimentSnapshot] = []
        async with aiohttp.ClientSession() as session:
            for token in token_mints:
                snapshot = await self.sentiment.analyze_token(
                    session=session,
                    token_mint=token,
                    keywords=keywords,
                    kol_wallets=kol_wallets,
                )
                snapshots.append(snapshot)
                if snapshot.should_momentum_buy:
                    self.notify(
                        "[MOMENTUM BUY] "
                        f"{token} | mindshare={snapshot.mindshare_score:.3f} "
                        f"organic={snapshot.sentiment.organic_vs_paid:.2f} "
                        f"memeability={snapshot.sentiment.memeability:.1f}"
                    )
        return snapshots

    async def run_arb_cycle(
        self, token_mints: Sequence[str], trade_size_sol: float
    ) -> List[ArbitrageOpportunity]:
        opportunities: List[ArbitrageOpportunity] = []
        async with aiohttp.ClientSession() as session:
            for token in token_mints:
                opportunity = await self.arb.detect_opportunity(
                    session=session,
                    token_mint=token,
                    trade_size_sol=trade_size_sol,
                )
                if opportunity is None:
                    continue
                opportunities.append(opportunity)
                if opportunity.profitable:
                    self.notify(
                        "[ARB READY] "
                        f"{token} buy={opportunity.buy_dex} sell={opportunity.sell_dex} "
                        f"net={opportunity.net_profit_sol:.6f} SOL "
                        f"return={opportunity.expected_return_pct:.2f}%"
                    )
        return opportunities

    async def run_once(
        self,
        token_mints: Sequence[str],
        keywords: Sequence[str],
        kol_wallets: Sequence[str],
        arb_trade_size_sol: float,
    ) -> Dict[str, Any]:
        sentiment, arbitrage = await asyncio.gather(
            self.run_sentiment_cycle(token_mints, keywords, kol_wallets),
            self.run_arb_cycle(token_mints, arb_trade_size_sol),
        )
        return {
            "sentiment": sentiment,
            "arbitrage": arbitrage,
        }

    async def run_forever(
        self,
        token_mints: Sequence[str],
        keywords: Sequence[str],
        kol_wallets: Sequence[str],
        arb_trade_size_sol: float,
        cycle_seconds: float = 12.0,
    ) -> None:
        while True:
            try:
                await self.run_once(
                    token_mints=token_mints,
                    keywords=keywords,
                    kol_wallets=kol_wallets,
                    arb_trade_size_sol=arb_trade_size_sol,
                )
            except Exception as exc:  # noqa: BLE001
                self.notify(f"[ADVANCED ENGINE ERROR] {exc}")
            await asyncio.sleep(max(1.0, cycle_seconds))


def env_token_list() -> List[str]:
    return _parse_csv(
        (
            __import__("os").getenv("ADVANCED_TOKEN_MINTS")
            or "4k3Dyjzvzp8eMzwc2vT3Wj4rA6kY8N4fW3YxN5vQ4M3z"
        )
    )


def env_keywords() -> List[str]:
    return _parse_csv(
        (__import__("os").getenv("ADVANCED_X_KEYWORDS") or "solana,memecoin,raydium,meteora")
    )


def env_kol_wallets() -> List[str]:
    return _parse_csv(__import__("os").getenv("ADVANCED_KOL_WALLETS") or "")
