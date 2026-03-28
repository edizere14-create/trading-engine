# intent_arbitrage.py - Intent Arbitrage Loop (Cross-DEX Price Comparison)
#
# Before executing a BUY, compares price on Camelot vs Uniswap V3 (Arbitrum).
# If price gap >1%, sets the Dutch Auction start below the cheapest price,
# leveraging solver private liquidity discovery for better-than-AMM fills.
#
# Strategy:
#   1. Query both DEXes for the same token pair quote
#   2. Calculate price gap percentage
#   3. If gap > threshold, create an intent with start_price below cheapest
#   4. Let solvers discover hidden liquidity across pools

import asyncio
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from pydantic import BaseModel, Field

from dynamic_tuner import get_tuner, MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
CAMELOT_SUBGRAPH = os.getenv(
    "CAMELOT_SUBGRAPH",
    "https://api.thegraph.com/subgraphs/name/camelotlabs/camelot-amm-v3",
)
UNISWAPV3_SUBGRAPH = os.getenv(
    "UNISWAPV3_SUBGRAPH",
    "https://api.thegraph.com/subgraphs/name/ianlapham/arbitrum-minimal",
)
CAMELOT_QUOTER = os.getenv("CAMELOT_QUOTER", "")  # Quoter contract address
UNISWAPV3_QUOTER = os.getenv("UNISWAPV3_QUOTER", "")  # Quoter V2 address
ARB_RPC_URL = os.getenv("ARB_RPC_URL", "https://arb1.arbitrum.io/rpc")

MIN_GAP_PCT = float(os.getenv("INTENT_ARB_MIN_GAP_PCT", 1.0))
PRICE_IMPROVEMENT_BPS = int(os.getenv("INTENT_ARB_IMPROVEMENT_BPS", 15))  # 0.15%
API_TIMEOUT_SECONDS = float(os.getenv("INTENT_ARB_TIMEOUT", 8))
WETH_ADDRESS = os.getenv(
    "WETH_ADDRESS", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
).lower()


# ── Pydantic Models ─────────────────────────────────────────────────────────

class DEXQuote(BaseModel):
    """Price quote from a DEX."""
    dex_name: str
    token_in: str
    token_out: str
    amount_in: float
    amount_out: float
    price: float  # token_out per token_in
    pool_address: str = ""
    fee_tier: int = 0
    liquidity: float = 0.0
    fetched_at: float = Field(default_factory=time.time)


class ArbitrageSignal(BaseModel):
    """Detected cross-DEX price discrepancy."""
    token_address: str
    cheaper_dex: str
    expensive_dex: str
    cheap_price: float
    expensive_price: float
    gap_pct: float
    recommended_start_price: float
    amount_in: float
    regime: str = "NORMAL"
    detected_at: float = Field(default_factory=time.time)


class IntentOverride(BaseModel):
    """Override parameters for the Dutch Auction intent."""
    use_override: bool = False
    start_price: float = 0.0
    min_return_pct: float = 99.0
    improvement_bps: int = PRICE_IMPROVEMENT_BPS
    source_dex: str = ""
    gap_pct: float = 0.0


# ── Intent Arbitrage Engine ─────────────────────────────────────────────────

class IntentArbitrageEngine:
    """
    Cross-DEX price comparison engine for Camelot vs Uniswap V3 on Arbitrum.
    Detects price gaps and generates intent overrides for better fills.
    """

    _instance: Optional["IntentArbitrageEngine"] = None

    def __init__(self) -> None:
        self._quote_cache: Dict[str, Tuple[DEXQuote, float]] = {}
        self._cache_ttl = int(os.getenv("INTENT_ARB_CACHE_TTL", 15))  # 15 sec
        self._signals: List[ArbitrageSignal] = []
        self._total_checked = 0
        self._total_arb_found = 0

    @classmethod
    def get_instance(cls) -> "IntentArbitrageEngine":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Public API ──────────────────────────────────────────────────────

    async def check_arbitrage(
        self, token_address: str, amount_in_eth: float
    ) -> IntentOverride:
        """
        Compare prices on Camelot vs Uniswap V3 for a given token.
        Returns IntentOverride if price gap > threshold.
        """
        self._total_checked += 1
        token_lower = token_address.lower()

        # Fetch quotes from both DEXes in parallel
        camelot_quote, uni_quote = await asyncio.gather(
            self._get_camelot_quote(token_lower, amount_in_eth),
            self._get_uniswapv3_quote(token_lower, amount_in_eth),
            return_exceptions=True,
        )

        # Handle failures gracefully
        if isinstance(camelot_quote, Exception):
            print(f"[INTENT_ARB] Camelot quote failed: {camelot_quote}")
            camelot_quote = None
        if isinstance(uni_quote, Exception):
            print(f"[INTENT_ARB] Uniswap V3 quote failed: {uni_quote}")
            uni_quote = None

        # Need both quotes to compare
        if not camelot_quote or not uni_quote:
            return IntentOverride(use_override=False)

        if camelot_quote.price <= 0 or uni_quote.price <= 0:
            return IntentOverride(use_override=False)

        # Calculate gap
        cheap_quote = min(camelot_quote, uni_quote, key=lambda q: q.price)
        expensive_quote = max(camelot_quote, uni_quote, key=lambda q: q.price)

        gap_pct = ((expensive_quote.price - cheap_quote.price) / cheap_quote.price) * 100

        regime = get_tuner().get_regime()

        if gap_pct >= MIN_GAP_PCT:
            self._total_arb_found += 1

            # Set start price below the cheapest AMM price
            # This forces solvers to look for hidden liquidity
            improvement_factor = 1 - (PRICE_IMPROVEMENT_BPS / 10000)
            recommended_start = cheap_quote.price * improvement_factor

            signal = ArbitrageSignal(
                token_address=token_address,
                cheaper_dex=cheap_quote.dex_name,
                expensive_dex=expensive_quote.dex_name,
                cheap_price=cheap_quote.price,
                expensive_price=expensive_quote.price,
                gap_pct=round(gap_pct, 4),
                recommended_start_price=recommended_start,
                amount_in=amount_in_eth,
                regime=regime,
            )
            self._signals.append(signal)

            # Keep only last 200 signals
            if len(self._signals) > 200:
                self._signals = self._signals[-200:]

            print(
                f"[INTENT_ARB] Gap found: {cheap_quote.dex_name} "
                f"({cheap_quote.price:.8f}) vs {expensive_quote.dex_name} "
                f"({expensive_quote.price:.8f}) → gap={gap_pct:.2f}% "
                f"start_price={recommended_start:.8f}"
            )

            return IntentOverride(
                use_override=True,
                start_price=recommended_start,
                min_return_pct=_regime_min_return(regime),
                improvement_bps=PRICE_IMPROVEMENT_BPS,
                source_dex=cheap_quote.dex_name,
                gap_pct=round(gap_pct, 4),
            )

        return IntentOverride(use_override=False)

    def get_signals(self) -> List[ArbitrageSignal]:
        """Return recent arbitrage signals."""
        return list(self._signals)

    def get_stats(self) -> Dict[str, Any]:
        """Return arbitrage engine statistics."""
        return {
            "total_checked": self._total_checked,
            "total_arb_found": self._total_arb_found,
            "hit_rate_pct": round(
                (self._total_arb_found / max(self._total_checked, 1)) * 100, 2
            ),
            "recent_signals": len(self._signals),
            "min_gap_pct": MIN_GAP_PCT,
            "improvement_bps": PRICE_IMPROVEMENT_BPS,
        }

    # ── Camelot V3 Quotes ──────────────────────────────────────────────

    async def _get_camelot_quote(
        self, token_address: str, amount_in_eth: float
    ) -> DEXQuote:
        """Fetch price quote from Camelot V3 on Arbitrum."""
        cache_key = f"camelot:{token_address}:{amount_in_eth}"
        cached = self._check_cache(cache_key)
        if cached:
            return cached

        # Query Camelot subgraph for pool + price data
        query = """
        {
            pools(
                where: {
                    or: [
                        { token0: "%s", token1: "%s" },
                        { token0: "%s", token1: "%s" }
                    ]
                },
                first: 1,
                orderBy: totalValueLockedUSD,
                orderDirection: desc
            ) {
                id
                token0 { id symbol decimals }
                token1 { id symbol decimals }
                token0Price
                token1Price
                totalValueLockedUSD
                feeTier
            }
        }
        """ % (token_address, WETH_ADDRESS, WETH_ADDRESS, token_address)

        timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                CAMELOT_SUBGRAPH, json={"query": query}
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()

        pools = data.get("data", {}).get("pools", [])
        if not pools:
            return DEXQuote(
                dex_name="Camelot",
                token_in=WETH_ADDRESS,
                token_out=token_address,
                amount_in=amount_in_eth,
                amount_out=0,
                price=0,
            )

        pool = pools[0]
        # Determine price direction
        if pool["token0"]["id"].lower() == WETH_ADDRESS:
            price = float(pool["token0Price"])  # tokens per WETH
        else:
            price = float(pool["token1Price"])

        amount_out = amount_in_eth * price

        quote = DEXQuote(
            dex_name="Camelot",
            token_in=WETH_ADDRESS,
            token_out=token_address,
            amount_in=amount_in_eth,
            amount_out=amount_out,
            price=price,
            pool_address=pool["id"],
            fee_tier=int(pool.get("feeTier", 0)),
            liquidity=float(pool.get("totalValueLockedUSD", 0)),
        )

        self._update_cache(cache_key, quote)
        return quote

    # ── Uniswap V3 Quotes ─────────────────────────────────────────────

    async def _get_uniswapv3_quote(
        self, token_address: str, amount_in_eth: float
    ) -> DEXQuote:
        """Fetch price quote from Uniswap V3 on Arbitrum."""
        cache_key = f"uniswap:{token_address}:{amount_in_eth}"
        cached = self._check_cache(cache_key)
        if cached:
            return cached

        query = """
        {
            pools(
                where: {
                    or: [
                        { token0: "%s", token1: "%s" },
                        { token0: "%s", token1: "%s" }
                    ]
                },
                first: 1,
                orderBy: totalValueLockedUSD,
                orderDirection: desc
            ) {
                id
                token0 { id symbol decimals }
                token1 { id symbol decimals }
                token0Price
                token1Price
                totalValueLockedUSD
                feeTier
            }
        }
        """ % (token_address, WETH_ADDRESS, WETH_ADDRESS, token_address)

        timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                UNISWAPV3_SUBGRAPH, json={"query": query}
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()

        pools = data.get("data", {}).get("pools", [])
        if not pools:
            return DEXQuote(
                dex_name="UniswapV3",
                token_in=WETH_ADDRESS,
                token_out=token_address,
                amount_in=amount_in_eth,
                amount_out=0,
                price=0,
            )

        pool = pools[0]
        if pool["token0"]["id"].lower() == WETH_ADDRESS:
            price = float(pool["token0Price"])
        else:
            price = float(pool["token1Price"])

        amount_out = amount_in_eth * price

        quote = DEXQuote(
            dex_name="UniswapV3",
            token_in=WETH_ADDRESS,
            token_out=token_address,
            amount_in=amount_in_eth,
            amount_out=amount_out,
            price=price,
            pool_address=pool["id"],
            fee_tier=int(pool.get("feeTier", 0)),
            liquidity=float(pool.get("totalValueLockedUSD", 0)),
        )

        self._update_cache(cache_key, quote)
        return quote

    # ── Cache ───────────────────────────────────────────────────────────

    def _check_cache(self, key: str) -> Optional[DEXQuote]:
        entry = self._quote_cache.get(key)
        if entry:
            quote, ts = entry
            if time.time() - ts < self._cache_ttl:
                return quote
            del self._quote_cache[key]
        return None

    def _update_cache(self, key: str, quote: DEXQuote) -> None:
        self._quote_cache[key] = (quote, time.time())
        # Evict old entries
        if len(self._quote_cache) > 500:
            cutoff = time.time() - self._cache_ttl
            self._quote_cache = {
                k: v for k, v in self._quote_cache.items() if v[1] > cutoff
            }


# ── Helpers ─────────────────────────────────────────────────────────────────

def _regime_min_return(regime: str) -> float:
    """Minimum return percentage based on market regime."""
    return {
        MarketRegime.SAFE_MODE: 98.0,
        MarketRegime.NORMAL: 99.0,
        MarketRegime.AGGRESSIVE: 99.5,
    }.get(regime, 99.0)


# ── Singleton ───────────────────────────────────────────────────────────────

def get_intent_arbitrage() -> IntentArbitrageEngine:
    return IntentArbitrageEngine.get_instance()
