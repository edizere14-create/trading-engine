# l3_ecosystem_sniper.py - L3 Ecosystem Sniper (Arbitrum Orbit Chains)
#
# Monitors bridge flows between Arbitrum One and Orbit L3 chains
# (ApeChain, Xai, etc.). When ETH bridging spikes above threshold,
# triggers a sniper scan for new liquidity pairs on the sub-chain.
#
# Strategy:
#   1. Poll Arbitrum bridge contracts for deposit events to L3s
#   2. Detect ETH bridging spikes (>50% above rolling average)
#   3. Scan target L3 DEX for newly created pairs with fresh liquidity
#   4. Broadcast sniper opportunities to dashboard via StateManager

import asyncio
import math
import os
import time
import threading
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
from pydantic import BaseModel, Field

from dynamic_tuner import get_tuner, MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
POLL_INTERVAL_SECONDS = int(os.getenv("L3_POLL_INTERVAL", 30))
BRIDGE_SPIKE_THRESHOLD_PCT = float(os.getenv("L3_SPIKE_THRESHOLD_PCT", 50.0))
MIN_BRIDGE_Z_SCORE = float(os.getenv("MIN_BRIDGE_Z_SCORE", 1.5))  # Only trade abnormal volume
WINDOW_LONG = int(os.getenv("L3_WINDOW_LONG", 336))    # 7-day baseline (~336 samples at 30s polls)
WINDOW_SHORT = int(os.getenv("L3_WINDOW_SHORT", 8))     # 4-min momentum window
MIN_BRIDGE_ETH = float(os.getenv("L3_MIN_BRIDGE_ETH", 5.0))
MIN_PAIR_LIQUIDITY_USD = float(os.getenv("L3_MIN_PAIR_LIQ_USD", 10000.0))
MAX_PAIR_AGE_SECONDS = int(os.getenv("L3_MAX_PAIR_AGE", 3600))  # 1 hour
API_TIMEOUT_SECONDS = float(os.getenv("L3_API_TIMEOUT", 10))

# Supported L3 chains (Arbitrum Orbit)
L3_CHAINS: Dict[str, Dict[str, str]] = {
    "apechain": {
        "name": "ApeChain",
        "chain_id": "33139",
        "bridge_contract": os.getenv("APECHAIN_BRIDGE", ""),
        "dex_subgraph": os.getenv("APECHAIN_DEX_SUBGRAPH", ""),
        "explorer_api": os.getenv("APECHAIN_EXPLORER_API", ""),
    },
    "xai": {
        "name": "Xai",
        "chain_id": "660279",
        "bridge_contract": os.getenv("XAI_BRIDGE", ""),
        "dex_subgraph": os.getenv("XAI_DEX_SUBGRAPH", ""),
        "explorer_api": os.getenv("XAI_EXPLORER_API", ""),
    },
}

# Arbitrum One RPC for bridge monitoring
ARB_RPC_URL = os.getenv("ARB_RPC_URL", "https://arb1.arbitrum.io/rpc")


# ── Pydantic Models ─────────────────────────────────────────────────────────

class BridgeFlow(BaseModel):
    """Single bridge deposit event."""
    chain_id: str
    chain_name: str
    amount_eth: float
    tx_hash: str = ""
    timestamp: float = Field(default_factory=time.time)
    sender: str = ""


class BridgeSpike(BaseModel):
    """Detected bridging spike to an L3 chain."""
    chain_id: str
    chain_name: str
    current_rate_eth: float
    rolling_avg_eth: float
    spike_pct: float
    z_score: float = 0.0
    detected_at: float = Field(default_factory=time.time)


class NewPair(BaseModel):
    """Newly created liquidity pair on an L3 DEX."""
    chain_id: str
    chain_name: str
    pair_address: str
    token0: str
    token1: str
    token0_symbol: str = ""
    token1_symbol: str = ""
    liquidity_usd: float = 0.0
    created_at: float = 0.0
    dex_name: str = ""


class SniperOpportunity(BaseModel):
    """Actionable sniper opportunity combining bridge spike + new pair."""
    spike: BridgeSpike
    pair: NewPair
    regime: str = "NORMAL"
    score: float = 0.0  # Higher = better opportunity
    generated_at: float = Field(default_factory=time.time)


# ── L3 Ecosystem Sniper ────────────────────────────────────────────────────

class L3EcosystemSniper:
    """
    Monitors Arbitrum Orbit chain bridge flows and snipes new liquidity
    pairs when ETH bridging spikes are detected.
    """

    _instance: Optional["L3EcosystemSniper"] = None

    def __init__(self) -> None:
        self._bridge_history: Dict[str, List[float]] = {
            chain_id: [] for chain_id in L3_CHAINS
        }
        self._detected_spikes: List[BridgeSpike] = []
        self._opportunities: List[SniperOpportunity] = []
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._last_poll: Dict[str, float] = {}

    @classmethod
    def get_instance(cls) -> "L3EcosystemSniper":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Public API ──────────────────────────────────────────────────────

    def start(self) -> None:
        """Start background monitoring of L3 bridge flows."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name="l3-sniper"
        )
        self._thread.start()
        print("[L3_SNIPER] Started monitoring Arbitrum Orbit bridge flows")

    def stop(self) -> None:
        self._running = False

    def get_opportunities(self) -> List[SniperOpportunity]:
        """Return current sniper opportunities (newest first)."""
        with self._lock:
            return sorted(self._opportunities, key=lambda o: o.generated_at, reverse=True)

    def get_spikes(self) -> List[BridgeSpike]:
        """Return all detected bridge spikes."""
        with self._lock:
            return list(self._detected_spikes)

    def get_status(self) -> Dict[str, Any]:
        """Return current sniper status for dashboard."""
        with self._lock:
            return {
                "running": self._running,
                "chains_monitored": list(L3_CHAINS.keys()),
                "active_spikes": len(self._detected_spikes),
                "pending_opportunities": len(self._opportunities),
                "bridge_samples": {
                    chain: len(hist) for chain, hist in self._bridge_history.items()
                },
            }

    # ── Bridge Flow Monitoring ──────────────────────────────────────────

    async def poll_bridge_flows(self) -> List[BridgeFlow]:
        """Poll bridge contracts for recent deposit events to L3 chains."""
        flows: List[BridgeFlow] = []

        for chain_key, chain_info in L3_CHAINS.items():
            if not chain_info["bridge_contract"]:
                continue

            try:
                flow = await self._fetch_bridge_deposits(chain_key, chain_info)
                flows.extend(flow)
            except Exception as exc:
                print(f"[L3_SNIPER] Bridge poll error for {chain_info['name']}: {exc}")

        return flows

    async def _fetch_bridge_deposits(
        self, chain_key: str, chain_info: Dict[str, str]
    ) -> List[BridgeFlow]:
        """Fetch bridge deposit events from Arbitrum One to an L3 chain."""
        # Query Arbitrum RPC for bridge contract events
        # Using eth_getLogs for bridge deposit events
        bridge_addr = chain_info["bridge_contract"]
        # Standard bridge deposit event topic (ERC20/ETH deposit)
        deposit_topic = "0xe7bbb783e01fecea27c2daa0b88e081abbe6e0c2e1cfe486ae1fbabd2e2e25d4"

        last_poll = self._last_poll.get(chain_key, 0)
        now = time.time()
        if now - last_poll < POLL_INTERVAL_SECONDS:
            return []
        self._last_poll[chain_key] = now

        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getLogs",
            "params": [{
                "address": bridge_addr,
                "topics": [deposit_topic],
                "fromBlock": "latest",
            }],
        }

        timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(ARB_RPC_URL, json=payload) as resp:
                resp.raise_for_status()
                data = await resp.json()

        logs = data.get("result", [])
        flows: List[BridgeFlow] = []
        for log in logs:
            try:
                # Parse ETH value from log data (varies by bridge implementation)
                value_hex = log.get("data", "0x0")
                amount_wei = int(value_hex[:66], 16) if len(value_hex) >= 66 else 0
                amount_eth = amount_wei / 1e18

                if amount_eth >= MIN_BRIDGE_ETH:
                    flows.append(BridgeFlow(
                        chain_id=chain_info["chain_id"],
                        chain_name=chain_info["name"],
                        amount_eth=amount_eth,
                        tx_hash=log.get("transactionHash", ""),
                        sender=log.get("topics", ["", ""])[-1][-40:] if log.get("topics") else "",
                    ))
            except (ValueError, IndexError):
                continue

        return flows

    # ── Spike Detection ─────────────────────────────────────────────────

    def detect_spike(self, chain_key: str, flow_amount_eth: float) -> Optional[BridgeSpike]:
        """Check if a new bridge flow constitutes a spike using dual-window Z-score.

        Long window (WINDOW_LONG, default 336 = ~7 days) provides the baseline
        mean and stddev. Short window (WINDOW_SHORT, default 8 = ~4 min) captures
        current momentum.  Z = (short_mean - long_mean) / long_stddev.
        """
        with self._lock:
            history = self._bridge_history.get(chain_key, [])
            history.append(flow_amount_eth)

            # Trim to long window
            if len(history) > WINDOW_LONG:
                history = history[-WINDOW_LONG:]
            self._bridge_history[chain_key] = history

            # Need enough data for both windows
            if len(history) < max(WINDOW_SHORT + 1, 10):
                return None

            # Long-window baseline (everything except the short tail)
            baseline = history[:-WINDOW_SHORT] if len(history) > WINDOW_SHORT else history[:-1]
            mu = sum(baseline) / len(baseline)
            if mu <= 0:
                return None

            variance = sum((x - mu) ** 2 for x in baseline) / len(baseline)
            sigma = math.sqrt(variance) if variance > 0 else 0.0

            # Short-window current momentum
            recent = history[-WINDOW_SHORT:]
            x = sum(recent) / len(recent)

            # Dynamic Z-score: short momentum vs long baseline
            z_score = (x - mu) / sigma if sigma > 0 else 0.0
            spike_pct = ((x - mu) / mu) * 100

            # Gate: only trigger on abnormal volume (Z > MIN_BRIDGE_Z_SCORE)
            if z_score < MIN_BRIDGE_Z_SCORE:
                return None

            # Also require percentage spike above threshold
            if spike_pct < BRIDGE_SPIKE_THRESHOLD_PCT:
                return None

            chain_info = L3_CHAINS.get(chain_key, {})
            spike = BridgeSpike(
                chain_id=chain_info.get("chain_id", ""),
                chain_name=chain_info.get("name", chain_key),
                current_rate_eth=round(x, 4),
                rolling_avg_eth=round(mu, 4),
                spike_pct=round(spike_pct, 2),
                z_score=round(z_score, 3),
            )
            self._detected_spikes.append(spike)
            print(
                f"[L3_SNIPER] Bridge spike on {spike.chain_name}: "
                f"{flow_amount_eth:.2f} ETH vs avg {avg:.2f} ETH "
                f"(+{spike_pct:.1f}%, Z={z_score:.2f})"
            )
            return spike

        return None

    # ── New Pair Scanning ───────────────────────────────────────────────

    async def scan_new_pairs(self, chain_key: str) -> List[NewPair]:
        """Scan L3 DEX for newly created liquidity pairs."""
        chain_info = L3_CHAINS.get(chain_key, {})
        subgraph_url = chain_info.get("dex_subgraph", "")
        if not subgraph_url:
            return []

        now = time.time()
        min_created = now - MAX_PAIR_AGE_SECONDS

        # GraphQL query for recently created pairs
        query = """
        {
            pairs(
                first: 50,
                orderBy: createdAtTimestamp,
                orderDirection: desc,
                where: { createdAtTimestamp_gt: "%d" }
            ) {
                id
                token0 { id symbol }
                token1 { id symbol }
                reserveUSD
                createdAtTimestamp
            }
        }
        """ % int(min_created)

        pairs: List[NewPair] = []
        try:
            timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(
                    subgraph_url,
                    json={"query": query},
                ) as resp:
                    resp.raise_for_status()
                    data = await resp.json()

            for pair_data in data.get("data", {}).get("pairs", []):
                liq_usd = float(pair_data.get("reserveUSD", 0))
                if liq_usd >= MIN_PAIR_LIQUIDITY_USD:
                    pairs.append(NewPair(
                        chain_id=chain_info["chain_id"],
                        chain_name=chain_info["name"],
                        pair_address=pair_data["id"],
                        token0=pair_data["token0"]["id"],
                        token1=pair_data["token1"]["id"],
                        token0_symbol=pair_data["token0"].get("symbol", ""),
                        token1_symbol=pair_data["token1"].get("symbol", ""),
                        liquidity_usd=liq_usd,
                        created_at=float(pair_data.get("createdAtTimestamp", 0)),
                    ))
        except Exception as exc:
            print(f"[L3_SNIPER] Pair scan error on {chain_info['name']}: {exc}")

        return pairs

    # ── Opportunity Scoring ─────────────────────────────────────────────

    def score_opportunity(self, spike: BridgeSpike, pair: NewPair) -> float:
        """
        Score a sniper opportunity based on spike intensity and pair quality.
        Higher = better (0-100 scale).
        """
        score = 0.0

        # Spike intensity (0-40 pts)
        spike_factor = min(spike.spike_pct / 200, 1.0)  # cap at 200% spike
        score += spike_factor * 40

        # Liquidity (0-30 pts) — prefer moderate liquidity (not too low, not whale-trapped)
        liq_factor = min(pair.liquidity_usd / 100000, 1.0)
        score += liq_factor * 30

        # Freshness (0-30 pts) — newer pairs score higher
        age_seconds = time.time() - pair.created_at if pair.created_at > 0 else MAX_PAIR_AGE_SECONDS
        freshness = max(0, 1 - (age_seconds / MAX_PAIR_AGE_SECONDS))
        score += freshness * 30

        return round(score, 2)

    # ── Background Monitor ──────────────────────────────────────────────

    def _monitor_loop(self) -> None:
        """Background loop that polls bridge flows and scans for opportunities."""
        while self._running:
            try:
                asyncio.run(self._poll_cycle())
            except Exception as exc:
                print(f"[L3_SNIPER] Monitor cycle error: {exc}")

            time.sleep(POLL_INTERVAL_SECONDS)

    async def _poll_cycle(self) -> None:
        """Single monitoring cycle: poll bridges → detect spikes → scan pairs."""
        flows = await self.poll_bridge_flows()

        for flow in flows:
            chain_key = None
            for key, info in L3_CHAINS.items():
                if info["chain_id"] == flow.chain_id:
                    chain_key = key
                    break
            if not chain_key:
                continue

            spike = self.detect_spike(chain_key, flow.amount_eth)
            if spike:
                # Spike detected — scan for new pairs on target L3
                pairs = await self.scan_new_pairs(chain_key)
                regime = get_tuner().get_regime()

                for pair in pairs:
                    score = self.score_opportunity(spike, pair)
                    opportunity = SniperOpportunity(
                        spike=spike,
                        pair=pair,
                        regime=regime,
                        score=score,
                    )
                    with self._lock:
                        self._opportunities.append(opportunity)

                    print(
                        f"[L3_SNIPER] Opportunity: {pair.token0_symbol}/{pair.token1_symbol} "
                        f"on {pair.chain_name} (score={score:.1f}, liq=${pair.liquidity_usd:,.0f})"
                    )

                    # Broadcast to dashboard
                    try:
                        from state_manager import get_state_manager
                        asyncio.ensure_future(get_state_manager().broadcast_event(
                            event_type="l3_sniper_opportunity",
                            data={
                                "chain": spike.chain_name,
                                "spike_pct": spike.spike_pct,
                                "pair": pair.pair_address,
                                "tokens": f"{pair.token0_symbol}/{pair.token1_symbol}",
                                "liquidity_usd": pair.liquidity_usd,
                                "score": score,
                            },
                            regime=regime,
                        ))
                    except Exception:
                        pass  # Dashboard broadcast non-fatal

        # Prune stale opportunities (>1 hour old)
        cutoff = time.time() - 3600
        with self._lock:
            self._opportunities = [
                o for o in self._opportunities if o.generated_at > cutoff
            ]
            self._detected_spikes = self._detected_spikes[-100:]  # Keep last 100


# ── Singleton ───────────────────────────────────────────────────────────────

def get_l3_sniper() -> L3EcosystemSniper:
    return L3EcosystemSniper.get_instance()
