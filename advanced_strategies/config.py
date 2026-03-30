import os
from dataclasses import dataclass


def _as_float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _as_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _as_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class AdvancedStrategyConfig:
    rpc_url: str
    yellowstone_grpc_endpoint: str
    yellowstone_x_token: str
    jito_block_engine_url: str
    jito_tip_lamports: int
    bundle_scan_limit: int
    bundle_same_root_threshold: int
    bundle_concentration_threshold: float
    bundle_funder_lookback_blocks: int
    birdeye_api_key: str
    dexscreener_base_url: str
    openai_api_key: str
    openai_base_url: str
    openai_sentiment_model: str
    openai_rug_model: str
    x_bearer_token: str
    mindshare_threshold: float
    social_heat_plateau_delta: float
    arbitrage_poll_interval_ms: int
    arbitrage_base_jito_tip_sol: float
    arbitrage_raydium_fee_pct: float
    arbitrage_meteora_fee_pct: float
    arbitrage_min_profit_sol: float
    enable_llm_rug_reasoning: bool

    @classmethod
    def from_env(cls) -> "AdvancedStrategyConfig":
        primary_rpc = (os.getenv("PRIMARY_RPC") or "").strip()
        helius_key = (os.getenv("HELIUS_API_KEY") or "").strip()
        rpc_url = primary_rpc
        if not rpc_url and helius_key:
            rpc_url = f"https://mainnet.helius-rpc.com/?api-key={helius_key}"

        return cls(
            rpc_url=rpc_url,
            yellowstone_grpc_endpoint=(os.getenv("YELLOWSTONE_GRPC_ENDPOINT") or "").strip(),
            yellowstone_x_token=(os.getenv("YELLOWSTONE_X_TOKEN") or "").strip(),
            jito_block_engine_url=(
                os.getenv("JITO_BLOCK_ENGINE_URL")
                or "https://mainnet.block-engine.jito.wtf/api/v1/bundles"
            ).strip(),
            jito_tip_lamports=_as_int("JITO_TIP_LAMPORTS", 1_000_000),
            bundle_scan_limit=_as_int("BUNDLE_SCAN_LIMIT", 10),
            bundle_same_root_threshold=_as_int("BUNDLE_SAME_ROOT_WALLET_THRESHOLD", 3),
            bundle_concentration_threshold=_as_float("BUNDLE_CONCENTRATION_THRESHOLD", 0.12),
            bundle_funder_lookback_blocks=_as_int("BUNDLE_FUNDER_LOOKBACK_BLOCKS", 200),
            birdeye_api_key=(os.getenv("BIRDEYE_API_KEY") or "").strip(),
            dexscreener_base_url=(
                os.getenv("DEXSCREENER_BASE_URL") or "https://api.dexscreener.com/latest/dex"
            ).strip(),
            openai_api_key=(os.getenv("OPENAI_API_KEY") or "").strip(),
            openai_base_url=(os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip(),
            openai_sentiment_model=(os.getenv("OPENAI_SENTIMENT_MODEL") or "gpt-4o-mini").strip(),
            openai_rug_model=(os.getenv("OPENAI_RUG_MODEL") or "o1-preview").strip(),
            x_bearer_token=(os.getenv("X_BEARER_TOKEN") or "").strip(),
            mindshare_threshold=_as_float("MINDSHARE_THRESHOLD", 0.5),
            social_heat_plateau_delta=_as_float("SOCIAL_HEAT_PLATEAU_DELTA", 0.05),
            arbitrage_poll_interval_ms=_as_int("ARBITRAGE_POLL_INTERVAL_MS", 50),
            arbitrage_base_jito_tip_sol=_as_float("ARBITRAGE_BASE_JITO_TIP_SOL", 0.001),
            arbitrage_raydium_fee_pct=_as_float("ARBITRAGE_RAYDIUM_FEE_PCT", 0.25),
            arbitrage_meteora_fee_pct=_as_float("ARBITRAGE_METEORA_FEE_PCT", 0.30),
            arbitrage_min_profit_sol=_as_float("ARBITRAGE_MIN_PROFIT_SOL", 0.0015),
            enable_llm_rug_reasoning=_as_bool("ENABLE_LLM_RUG_REASONING", False),
        )
