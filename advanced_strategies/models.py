from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class InstructionEvent:
    slot: int
    signature: str
    deployer: str
    token_mint: str
    instruction_name: str
    dex: str
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class BundleScanResult:
    slot: int
    candidate_transactions: int
    distributed_wallets: int
    detected_bundle: bool
    bundle_concentration_ratio: float
    high_risk_rug: bool
    dominant_root_account: Optional[str]
    reason: str


@dataclass
class LPExecutionDecision:
    should_execute: bool
    risk_label: str
    reason: str
    scan: BundleScanResult


@dataclass
class SentimentScore:
    organic_vs_paid: float
    memeability: float
    social_heat: float
    notes: str


@dataclass
class SentimentSnapshot:
    token_mint: str
    market_cap_usd: float
    community_growth_pct: float
    mindshare_score: float
    should_momentum_buy: bool
    sentiment: SentimentScore
    tweet_count: int


@dataclass
class DexQuote:
    dex: str
    input_mint: str
    output_mint: str
    in_amount_raw: int
    out_amount_raw: int
    fee_pct: float
    route_label: str
    raw: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ArbitrageOpportunity:
    token_mint: str
    buy_dex: str
    sell_dex: str
    start_sol: float
    final_sol: float
    gross_profit_sol: float
    total_fee_sol: float
    jito_tip_sol: float
    net_profit_sol: float
    expected_return_pct: float
    profitable: bool


@dataclass
class TrailingStopState:
    stop_loss_pct: float
    plateau_detected: bool
    social_heat: float
    social_heat_trend: float
