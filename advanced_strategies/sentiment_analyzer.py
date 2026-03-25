import statistics
from collections import defaultdict, deque
from typing import Any, Deque, Dict, Iterable, List, Sequence

import aiohttp

from advanced_strategies.config import AdvancedStrategyConfig
from advanced_strategies.models import SentimentScore, SentimentSnapshot, TrailingStopState
from advanced_strategies.rpc_clients import MarketDataClient, OpenAIReasoningClient, XApiClient


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class SocialHeatTrailingStop:
    def __init__(
        self,
        plateau_delta: float,
        base_stop_pct: float = 12.0,
        min_stop_pct: float = 3.0,
        tighten_step_pct: float = 1.0,
        window_size: int = 6,
    ) -> None:
        self.plateau_delta = plateau_delta
        self.base_stop_pct = base_stop_pct
        self.min_stop_pct = min_stop_pct
        self.tighten_step_pct = tighten_step_pct
        self.window_size = max(3, window_size)
        self._history: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=self.window_size)
        )
        self._stop_levels: Dict[str, float] = {}

    def update(
        self, token_mint: str, social_heat: float, unrealized_pnl_pct: float
    ) -> TrailingStopState:
        history = self._history[token_mint]
        history.append(social_heat)

        current_stop = self._stop_levels.get(token_mint, self.base_stop_pct)
        trend = 0.0
        plateau_detected = False

        if len(history) >= 3:
            recent = list(history)[-3:]
            trend = recent[-1] - recent[0]
            plateau_detected = abs(trend) <= self.plateau_delta

        # Tighten only while trade is in profit and momentum has stalled.
        if unrealized_pnl_pct > 0 and plateau_detected:
            current_stop = max(self.min_stop_pct, current_stop - self.tighten_step_pct)

        # If social heat is accelerating, let the trade breathe again a bit.
        if trend > self.plateau_delta * 2:
            current_stop = min(self.base_stop_pct, current_stop + self.tighten_step_pct * 0.5)

        self._stop_levels[token_mint] = current_stop
        return TrailingStopState(
            stop_loss_pct=current_stop,
            plateau_detected=plateau_detected,
            social_heat=social_heat,
            social_heat_trend=trend,
        )


class SentimentAnalyzer:
    def __init__(
        self,
        config: AdvancedStrategyConfig,
        market_data_client: MarketDataClient,
        x_client: XApiClient,
        openai_client: OpenAIReasoningClient,
    ) -> None:
        self.config = config
        self.market_data = market_data_client
        self.x_client = x_client
        self.openai = openai_client
        self.trailing_stop = SocialHeatTrailingStop(
            plateau_delta=config.social_heat_plateau_delta
        )

    async def analyze_token(
        self,
        session: aiohttp.ClientSession,
        token_mint: str,
        keywords: Sequence[str],
        kol_wallets: Sequence[str],
    ) -> SentimentSnapshot:
        query = self._build_query(token_mint, keywords, kol_wallets)
        tweets = await self.x_client.fetch_recent_tweets(session, query, max_results=50)
        tweets = tweets[:50]

        birdeye = await self.market_data.fetch_birdeye_overview(session, token_mint)
        dexscreener_pairs = await self.market_data.fetch_dexscreener_pairs(session, token_mint)
        market_cap = self._market_cap_usd(birdeye, dexscreener_pairs)
        community_growth = self._community_growth_pct(birdeye, dexscreener_pairs)

        sentiment = await self._score_with_llm(session, token_mint, tweets)
        mindshare = self.compute_mindshare_score(community_growth, market_cap)
        should_buy = (
            mindshare >= self.config.mindshare_threshold
            and sentiment.organic_vs_paid >= 0.55
            and sentiment.memeability >= 6.0
        )

        return SentimentSnapshot(
            token_mint=token_mint,
            market_cap_usd=market_cap,
            community_growth_pct=community_growth,
            mindshare_score=mindshare,
            should_momentum_buy=should_buy,
            sentiment=sentiment,
            tweet_count=len(tweets),
        )

    def update_trailing_stop(
        self, token_mint: str, social_heat: float, unrealized_pnl_pct: float
    ) -> TrailingStopState:
        return self.trailing_stop.update(token_mint, social_heat, unrealized_pnl_pct)

    def compute_mindshare_score(
        self, community_growth_pct: float, market_cap_usd: float
    ) -> float:
        market_cap_millions = max(market_cap_usd / 1_000_000.0, 0.001)
        return max(0.0, community_growth_pct) / market_cap_millions

    async def _score_with_llm(
        self, session: aiohttp.ClientSession, token_mint: str, tweets: Sequence[str]
    ) -> SentimentScore:
        if not tweets:
            return SentimentScore(
                organic_vs_paid=0.5,
                memeability=3.0,
                social_heat=2.0,
                notes="No tweets collected.",
            )

        tweets_blob = "\n".join(f"- {line}" for line in tweets[:50])
        system_prompt = (
            "You are a Solana meme-coin sentiment analyst. Return strict JSON with keys: "
            "organic_vs_paid (0-1 float), memeability (1-10 float), social_heat (1-10 float), "
            "notes (short string)."
        )
        user_prompt = (
            f"Token: {token_mint}\n"
            "Analyze the following tweets and score organic-vs-paid activity and memeability:\n"
            f"{tweets_blob}"
        )
        parsed = await self.openai.chat_json(
            session=session,
            model=self.config.openai_sentiment_model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timeout_seconds=12.0,
        )

        if not isinstance(parsed, dict):
            return SentimentScore(
                organic_vs_paid=0.5,
                memeability=4.0,
                social_heat=3.0,
                notes="LLM scoring unavailable; using neutral defaults.",
            )

        organic_vs_paid = min(1.0, max(0.0, _safe_float(parsed.get("organic_vs_paid"), 0.5)))
        memeability = min(10.0, max(1.0, _safe_float(parsed.get("memeability"), 4.0)))
        social_heat = min(10.0, max(1.0, _safe_float(parsed.get("social_heat"), 3.0)))
        notes = str(parsed.get("notes") or "").strip() or "No notes."
        return SentimentScore(
            organic_vs_paid=organic_vs_paid,
            memeability=memeability,
            social_heat=social_heat,
            notes=notes,
        )

    def _build_query(
        self, token_mint: str, keywords: Sequence[str], kol_wallets: Sequence[str]
    ) -> str:
        terms: List[str] = [token_mint]
        terms.extend(k for k in keywords if k.strip())
        terms.extend(w for w in kol_wallets if w.strip())
        unique_terms = list(dict.fromkeys(terms))
        return " OR ".join(f'"{term}"' for term in unique_terms[:10])

    def _market_cap_usd(
        self, birdeye: Dict[str, Any], dexscreener_pairs: Iterable[Dict[str, Any]]
    ) -> float:
        for key in ("mc", "marketCap", "fdv"):
            value = _safe_float(birdeye.get(key), 0.0)
            if value > 0:
                return value
        pair_caps = [_safe_float(pair.get("fdv"), 0.0) for pair in dexscreener_pairs]
        pair_caps = [cap for cap in pair_caps if cap > 0]
        if pair_caps:
            return statistics.median(pair_caps)
        return 0.0

    def _community_growth_pct(
        self, birdeye: Dict[str, Any], dexscreener_pairs: Iterable[Dict[str, Any]]
    ) -> float:
        for key in ("holderChange24hPercent", "holdersChange24h", "volumeChange24h"):
            value = _safe_float(birdeye.get(key), 0.0)
            if value != 0:
                return value

        growth_samples: List[float] = []
        for pair in dexscreener_pairs:
            volume = pair.get("volume") if isinstance(pair, dict) else {}
            volume_24h = _safe_float(volume.get("h24") if isinstance(volume, dict) else 0.0, 0.0)
            liquidity = pair.get("liquidity") if isinstance(pair, dict) else {}
            liquidity_usd = _safe_float(
                liquidity.get("usd") if isinstance(liquidity, dict) else 0.0, 0.0
            )
            if liquidity_usd <= 0:
                continue
            growth_samples.append((volume_24h / liquidity_usd) * 100.0)

        if growth_samples:
            return statistics.median(growth_samples)
        return 0.0
