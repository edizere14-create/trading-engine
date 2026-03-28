# whale_shadow.py - Whale Shadow Strategy (Meme Whale Wallet Tracking)
#
# Tracks 50+ known "Meme Whale" wallets via Debank/Zerion API.
# When 3+ whales buy the same token within a 10-minute window AND
# the token passes token_security_checker, bypasses conservative
# filters and enters AGGRESSIVE regime via DynamicTuner.
#
# Strategy:
#   1. Poll whale wallets for recent transactions (buys)
#   2. Aggregate: group buys by token within sliding 10-min window
#   3. Convergence trigger: 3+ whales buying same token → AGGRESSIVE signal
#   4. Security gate: token must pass token_security_checker before execution

import asyncio
import os
import time
import threading
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

import aiohttp
from pydantic import BaseModel, Field

from dynamic_tuner import get_tuner, MarketRegime

# ── Config ──────────────────────────────────────────────────────────────────
POLL_INTERVAL_SECONDS = int(os.getenv("WHALE_POLL_INTERVAL", 30))
CONVERGENCE_WINDOW_SECONDS = int(os.getenv("WHALE_CONVERGENCE_WINDOW", 600))  # 10 min
MIN_WHALES_FOR_TRIGGER = int(os.getenv("WHALE_MIN_CONVERGENCE", 3))
MIN_BUY_VALUE_USD = float(os.getenv("WHALE_MIN_BUY_USD", 5000.0))
AGGRESSIVE_DURATION_SECONDS = int(os.getenv("WHALE_AGGRESSIVE_DURATION", 300))  # 5 min
API_TIMEOUT_SECONDS = float(os.getenv("WHALE_API_TIMEOUT", 10))

DEBANK_API_BASE = os.getenv("DEBANK_API_BASE", "https://pro-openapi.debank.com/v1")
DEBANK_API_KEY = os.getenv("DEBANK_API_KEY", "")
ZERION_API_BASE = os.getenv("ZERION_API_BASE", "https://api.zerion.io/v1")
ZERION_API_KEY = os.getenv("ZERION_API_KEY", "")

# Known meme whale wallets (env-configurable, comma-separated)
_DEFAULT_WHALES = os.getenv("WHALE_WALLETS", "")
WHALE_WALLETS: List[str] = [
    w.strip().lower() for w in _DEFAULT_WHALES.split(",") if w.strip()
] if _DEFAULT_WHALES else []


# ── Pydantic Models ─────────────────────────────────────────────────────────

class WhaleBuy(BaseModel):
    """Single whale buy transaction."""
    wallet: str
    token_address: str
    token_symbol: str = ""
    chain: str = "arbitrum"
    amount_usd: float = 0.0
    tx_hash: str = ""
    timestamp: float = Field(default_factory=time.time)


class WhaleConvergence(BaseModel):
    """Convergence event: multiple whales buying the same token."""
    token_address: str
    token_symbol: str = ""
    whale_count: int
    total_usd: float
    wallets: List[str] = Field(default_factory=list)
    buys: List[WhaleBuy] = Field(default_factory=list)
    window_start: float = 0.0
    window_end: float = 0.0
    detected_at: float = Field(default_factory=time.time)


class AggressiveTrigger(BaseModel):
    """AGGRESSIVE mode trigger from whale convergence."""
    convergence: WhaleConvergence
    security_passed: bool
    previous_regime: str
    triggered_at: float = Field(default_factory=time.time)
    expires_at: float = 0.0


# ── Whale Shadow Tracker ───────────────────────────────────────────────────

class WhaleShadowTracker:
    """
    Tracks known meme whale wallets and triggers AGGRESSIVE mode
    when convergence is detected (3+ whales buying same token in 10 min).
    """

    _instance: Optional["WhaleShadowTracker"] = None

    def __init__(self) -> None:
        self._wallets: Set[str] = set(WHALE_WALLETS)
        self._recent_buys: List[WhaleBuy] = []
        self._convergences: List[WhaleConvergence] = []
        self._triggers: List[AggressiveTrigger] = []
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._aggressive_until: float = 0.0
        self._previous_regime: str = MarketRegime.NORMAL

    @classmethod
    def get_instance(cls) -> "WhaleShadowTracker":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Wallet Management ───────────────────────────────────────────────

    def add_wallet(self, address: str) -> None:
        """Add a whale wallet to track."""
        self._wallets.add(address.lower().strip())

    def remove_wallet(self, address: str) -> None:
        """Remove a whale wallet from tracking."""
        self._wallets.discard(address.lower().strip())

    def get_wallets(self) -> List[str]:
        """Return all tracked whale wallets."""
        return sorted(self._wallets)

    def load_wallets(self, addresses: List[str]) -> int:
        """Bulk load whale wallet addresses. Returns count added."""
        before = len(self._wallets)
        for addr in addresses:
            self._wallets.add(addr.lower().strip())
        return len(self._wallets) - before

    # ── Public API ──────────────────────────────────────────────────────

    def start(self) -> None:
        """Start background whale monitoring."""
        if self._running:
            return
        if not self._wallets:
            print("[WHALE_SHADOW] No wallets configured, monitoring skipped")
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name="whale-shadow"
        )
        self._thread.start()
        print(f"[WHALE_SHADOW] Started tracking {len(self._wallets)} whale wallets")

    def stop(self) -> None:
        self._running = False

    def is_aggressive_active(self) -> bool:
        """Check if whale-triggered AGGRESSIVE mode is still active."""
        return time.time() < self._aggressive_until

    def get_convergences(self) -> List[WhaleConvergence]:
        """Return detected convergence events."""
        with self._lock:
            return list(self._convergences)

    def get_triggers(self) -> List[AggressiveTrigger]:
        """Return AGGRESSIVE triggers."""
        with self._lock:
            return list(self._triggers)

    def get_status(self) -> Dict[str, Any]:
        """Return whale tracker status for dashboard."""
        with self._lock:
            return {
                "running": self._running,
                "wallets_tracked": len(self._wallets),
                "recent_buys": len(self._recent_buys),
                "convergences_detected": len(self._convergences),
                "aggressive_active": self.is_aggressive_active(),
                "aggressive_expires_in": max(0, self._aggressive_until - time.time()),
            }

    # ── Convergence Detection ───────────────────────────────────────────

    def record_buy(self, buy: WhaleBuy) -> Optional[WhaleConvergence]:
        """
        Record a whale buy and check for convergence.
        Returns WhaleConvergence if threshold is met.
        """
        with self._lock:
            self._recent_buys.append(buy)
            return self._check_convergence(buy.token_address)

    def _check_convergence(self, token_address: str) -> Optional[WhaleConvergence]:
        """Check if enough whales bought the same token within the window."""
        now = time.time()
        window_start = now - CONVERGENCE_WINDOW_SECONDS

        # Filter recent buys for this token within window
        token_buys = [
            b for b in self._recent_buys
            if b.token_address.lower() == token_address.lower()
            and b.timestamp >= window_start
            and b.amount_usd >= MIN_BUY_VALUE_USD
        ]

        # Count unique whales
        unique_wallets = set(b.wallet.lower() for b in token_buys)

        if len(unique_wallets) >= MIN_WHALES_FOR_TRIGGER:
            total_usd = sum(b.amount_usd for b in token_buys)
            symbol = token_buys[0].token_symbol if token_buys else ""

            convergence = WhaleConvergence(
                token_address=token_address,
                token_symbol=symbol,
                whale_count=len(unique_wallets),
                total_usd=total_usd,
                wallets=list(unique_wallets),
                buys=token_buys,
                window_start=window_start,
                window_end=now,
            )
            self._convergences.append(convergence)

            # Keep only last 50 convergences
            if len(self._convergences) > 50:
                self._convergences = self._convergences[-50:]

            print(
                f"[WHALE_SHADOW] CONVERGENCE: {len(unique_wallets)} whales "
                f"buying {symbol or token_address[:10]} "
                f"(${total_usd:,.0f} total in {CONVERGENCE_WINDOW_SECONDS}s)"
            )
            return convergence

        return None

    # ── AGGRESSIVE Trigger ──────────────────────────────────────────────

    async def trigger_aggressive(
        self, convergence: WhaleConvergence, security_passed: bool
    ) -> Optional[AggressiveTrigger]:
        """
        Trigger AGGRESSIVE mode based on whale convergence.
        Only triggers if security check passes.
        """
        if not security_passed:
            print(
                f"[WHALE_SHADOW] AGGRESSIVE blocked: security check failed for "
                f"{convergence.token_address}"
            )
            return None

        tuner = get_tuner()
        previous_regime = tuner.get_regime()

        # Set AGGRESSIVE mode
        tuner.set_regime(MarketRegime.AGGRESSIVE)
        self._aggressive_until = time.time() + AGGRESSIVE_DURATION_SECONDS
        self._previous_regime = previous_regime

        trigger = AggressiveTrigger(
            convergence=convergence,
            security_passed=True,
            previous_regime=previous_regime,
            expires_at=self._aggressive_until,
        )

        with self._lock:
            self._triggers.append(trigger)
            if len(self._triggers) > 50:
                self._triggers = self._triggers[-50:]

        print(
            f"[WHALE_SHADOW] AGGRESSIVE MODE ACTIVATED: "
            f"{convergence.whale_count} whales → {convergence.token_symbol or convergence.token_address[:10]} "
            f"(expires in {AGGRESSIVE_DURATION_SECONDS}s, was {previous_regime})"
        )

        # Broadcast to dashboard
        try:
            from state_manager import get_state_manager
            await get_state_manager().broadcast_event(
                event_type="whale_aggressive_trigger",
                data={
                    "token": convergence.token_address,
                    "symbol": convergence.token_symbol,
                    "whale_count": convergence.whale_count,
                    "total_usd": convergence.total_usd,
                    "wallets": convergence.wallets[:5],  # Limit broadcast size
                    "previous_regime": previous_regime,
                    "expires_in": AGGRESSIVE_DURATION_SECONDS,
                },
                regime=MarketRegime.AGGRESSIVE,
            )
        except Exception:
            pass  # Dashboard broadcast non-fatal

        # Schedule regime revert
        asyncio.get_event_loop().call_later(
            AGGRESSIVE_DURATION_SECONDS,
            self._revert_regime,
            previous_regime,
        )

        return trigger

    def _revert_regime(self, previous_regime: str) -> None:
        """Revert regime after AGGRESSIVE mode expires."""
        if time.time() >= self._aggressive_until:
            get_tuner().set_regime(previous_regime)
            self._aggressive_until = 0.0
            print(f"[WHALE_SHADOW] AGGRESSIVE expired, reverted to {previous_regime}")

    # ── Wallet Polling ──────────────────────────────────────────────────

    async def poll_whale_transactions(self) -> List[WhaleBuy]:
        """Poll tracked wallets for recent buy transactions."""
        all_buys: List[WhaleBuy] = []

        # Process wallets in batches to avoid rate limits
        wallet_list = list(self._wallets)
        batch_size = 5
        for i in range(0, len(wallet_list), batch_size):
            batch = wallet_list[i:i + batch_size]
            tasks = [self._fetch_wallet_buys(w) for w in batch]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for result in results:
                if isinstance(result, list):
                    all_buys.extend(result)
                elif isinstance(result, Exception):
                    print(f"[WHALE_SHADOW] Wallet poll error: {result}")

            # Rate limit between batches
            if i + batch_size < len(wallet_list):
                await asyncio.sleep(1)

        return all_buys

    async def _fetch_wallet_buys(self, wallet: str) -> List[WhaleBuy]:
        """Fetch recent buy transactions for a single wallet via Debank."""
        if not DEBANK_API_KEY:
            return await self._fetch_wallet_buys_zerion(wallet)

        url = f"{DEBANK_API_BASE}/user/history_list"
        headers = {"AccessKey": DEBANK_API_KEY}
        params = {
            "id": wallet,
            "chain_id": "arb",
            "page_count": 20,
        }

        buys: List[WhaleBuy] = []
        try:
            timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, params=params, headers=headers) as resp:
                    resp.raise_for_status()
                    data = await resp.json()

            cutoff = time.time() - CONVERGENCE_WINDOW_SECONDS
            for tx in data.get("history_list", []):
                if tx.get("time_at", 0) < cutoff:
                    continue

                # Look for swap/buy transactions
                if tx.get("cate_id") not in ("swap", "send"):
                    continue

                receives = tx.get("receives", [])
                for recv in receives:
                    token_addr = recv.get("token_id", "")
                    if not token_addr or token_addr.lower() == "arb":
                        continue

                    amount_usd = float(recv.get("amount", 0)) * float(recv.get("price", 0))
                    if amount_usd >= MIN_BUY_VALUE_USD:
                        buys.append(WhaleBuy(
                            wallet=wallet,
                            token_address=token_addr,
                            token_symbol=recv.get("symbol", ""),
                            amount_usd=amount_usd,
                            tx_hash=tx.get("id", ""),
                            timestamp=float(tx.get("time_at", time.time())),
                        ))
        except Exception as exc:
            print(f"[WHALE_SHADOW] Debank fetch error for {wallet[:10]}...: {exc}")

        return buys

    async def _fetch_wallet_buys_zerion(self, wallet: str) -> List[WhaleBuy]:
        """Fallback: fetch buy transactions via Zerion API."""
        if not ZERION_API_KEY:
            return []

        url = f"{ZERION_API_BASE}/wallets/{wallet}/transactions"
        headers = {
            "Authorization": f"Basic {ZERION_API_KEY}",
            "Accept": "application/json",
        }
        params = {
            "filter[chain_ids]": "arbitrum-one",
            "filter[operation_types]": "trade",
            "page[size]": 20,
        }

        buys: List[WhaleBuy] = []
        try:
            timeout = aiohttp.ClientTimeout(total=API_TIMEOUT_SECONDS)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, params=params, headers=headers) as resp:
                    resp.raise_for_status()
                    data = await resp.json()

            cutoff = time.time() - CONVERGENCE_WINDOW_SECONDS
            for item in data.get("data", []):
                attrs = item.get("attributes", {})
                if attrs.get("mined_at_timestamp", 0) < cutoff:
                    continue

                transfers = attrs.get("transfers", [])
                for transfer in transfers:
                    if transfer.get("direction") != "in":
                        continue

                    fungible = transfer.get("fungible_info", {})
                    impl = fungible.get("implementations", [])
                    token_addr = ""
                    for impl_item in impl:
                        if impl_item.get("chain_id") == "arbitrum-one":
                            token_addr = impl_item.get("address", "")
                            break

                    if not token_addr:
                        continue

                    value = float(transfer.get("value", 0))
                    price = float(transfer.get("price", 0))
                    amount_usd = value * price

                    if amount_usd >= MIN_BUY_VALUE_USD:
                        buys.append(WhaleBuy(
                            wallet=wallet,
                            token_address=token_addr,
                            token_symbol=fungible.get("symbol", ""),
                            amount_usd=amount_usd,
                            tx_hash=attrs.get("hash", ""),
                            timestamp=float(attrs.get("mined_at_timestamp", time.time())),
                        ))
        except Exception as exc:
            print(f"[WHALE_SHADOW] Zerion fetch error for {wallet[:10]}...: {exc}")

        return buys

    # ── Background Monitor ──────────────────────────────────────────────

    def _monitor_loop(self) -> None:
        """Background loop that polls whale wallets and checks convergence."""
        while self._running:
            try:
                asyncio.run(self._poll_cycle())
            except Exception as exc:
                print(f"[WHALE_SHADOW] Monitor cycle error: {exc}")

            # Prune old buys outside convergence window
            cutoff = time.time() - CONVERGENCE_WINDOW_SECONDS * 2
            with self._lock:
                self._recent_buys = [
                    b for b in self._recent_buys if b.timestamp > cutoff
                ]

            time.sleep(POLL_INTERVAL_SECONDS)

    async def _poll_cycle(self) -> None:
        """Single polling cycle: fetch buys → check convergence → maybe trigger."""
        buys = await self.poll_whale_transactions()

        for buy in buys:
            convergence = self.record_buy(buy)

            if convergence and not self.is_aggressive_active():
                # Security check before triggering AGGRESSIVE
                try:
                    from token_security_checker import get_security_checker
                    verdict = await get_security_checker().scan_token(
                        convergence.token_address
                    )
                    await self.trigger_aggressive(convergence, verdict.passed)
                except Exception as exc:
                    print(f"[WHALE_SHADOW] Security check error: {exc}")
                    # Do not trigger AGGRESSIVE if security check fails


# ── Singleton ───────────────────────────────────────────────────────────────

def get_whale_tracker() -> WhaleShadowTracker:
    return WhaleShadowTracker.get_instance()
