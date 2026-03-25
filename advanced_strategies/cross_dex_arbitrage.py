import asyncio
import os
from typing import Any, Awaitable, Callable, Dict, Optional, Sequence, Tuple

import aiohttp

from advanced_strategies.config import AdvancedStrategyConfig
from advanced_strategies.models import ArbitrageOpportunity, DexQuote
from advanced_strategies.rpc_clients import JitoBlockEngineClient

SOL_MINT = "So11111111111111111111111111111111111111112"
LAMPORTS_PER_SOL = 1_000_000_000
RAYDIUM_DEX = "Raydium"
METEORA_DEX = "Meteora DLMM"


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class JupiterDexQuoteClient:
    def __init__(self, quote_url: Optional[str] = None, timeout_seconds: float = 5.0) -> None:
        self.quote_url = (
            quote_url or os.getenv("JUPITER_QUOTE_URL") or "https://lite-api.jup.ag/swap/v1/quote"
        ).strip()
        self.timeout_seconds = timeout_seconds

    async def quote(
        self,
        session: aiohttp.ClientSession,
        input_mint: str,
        output_mint: str,
        amount_raw: int,
        dex: str,
        slippage_bps: int = 30,
    ) -> Optional[DexQuote]:
        if not self.quote_url or amount_raw <= 0:
            return None
        params = {
            "inputMint": input_mint,
            "outputMint": output_mint,
            "amount": str(amount_raw),
            "slippageBps": str(slippage_bps),
            "swapMode": "ExactIn",
            "dexes": dex,
        }
        try:
            async with session.get(
                self.quote_url,
                params=params,
                timeout=self.timeout_seconds,
            ) as response:
                if response.status != 200:
                    return None
                payload = await response.json()
        except (aiohttp.ClientError, TimeoutError, ValueError):
            return None

        in_amount = _safe_int(payload.get("inAmount"), amount_raw)
        out_amount = _safe_int(payload.get("outAmount"), 0)
        if out_amount <= 0:
            return None

        route_plan = payload.get("routePlan")
        first_leg = route_plan[0] if isinstance(route_plan, list) and route_plan else {}
        swap_info = first_leg.get("swapInfo") if isinstance(first_leg, dict) else {}
        route_label = str(swap_info.get("label") or dex) if isinstance(swap_info, dict) else dex
        fee_amount = _safe_float(swap_info.get("feeAmount"), 0.0) if isinstance(swap_info, dict) else 0.0
        fee_pct = (fee_amount / max(in_amount, 1)) * 100.0 if fee_amount > 0 else 0.0

        return DexQuote(
            dex=dex,
            input_mint=input_mint,
            output_mint=output_mint,
            in_amount_raw=in_amount,
            out_amount_raw=out_amount,
            fee_pct=fee_pct,
            route_label=route_label,
            raw=payload,
        )


class CrossDexArbitrageStrategy:
    def __init__(
        self,
        config: AdvancedStrategyConfig,
        quote_client: JupiterDexQuoteClient,
        jito_client: JitoBlockEngineClient,
    ) -> None:
        self.config = config
        self.quote_client = quote_client
        self.jito = jito_client

    async def detect_opportunity(
        self,
        session: aiohttp.ClientSession,
        token_mint: str,
        trade_size_sol: float,
    ) -> Optional[ArbitrageOpportunity]:
        start_lamports = max(1, int(trade_size_sol * LAMPORTS_PER_SOL))

        ray_buy = await self.quote_client.quote(
            session=session,
            input_mint=SOL_MINT,
            output_mint=token_mint,
            amount_raw=start_lamports,
            dex=RAYDIUM_DEX,
        )
        meteora_buy = await self.quote_client.quote(
            session=session,
            input_mint=SOL_MINT,
            output_mint=token_mint,
            amount_raw=start_lamports,
            dex=METEORA_DEX,
        )
        if ray_buy is None or meteora_buy is None:
            return None

        if ray_buy.out_amount_raw >= meteora_buy.out_amount_raw:
            buy_quote = ray_buy
            sell_dex = METEORA_DEX
        else:
            buy_quote = meteora_buy
            sell_dex = RAYDIUM_DEX

        sell_quote = await self.quote_client.quote(
            session=session,
            input_mint=token_mint,
            output_mint=SOL_MINT,
            amount_raw=buy_quote.out_amount_raw,
            dex=sell_dex,
        )
        if sell_quote is None:
            return None

        return self._compute_opportunity(
            buy_quote=buy_quote,
            sell_quote=sell_quote,
            start_sol=trade_size_sol,
        )

    def _compute_opportunity(
        self,
        buy_quote: DexQuote,
        sell_quote: DexQuote,
        start_sol: float,
    ) -> ArbitrageOpportunity:
        final_sol = sell_quote.out_amount_raw / LAMPORTS_PER_SOL
        gross_profit_sol = final_sol - start_sol

        raydium_fee_pct = self.config.arbitrage_raydium_fee_pct
        meteora_fee_pct = max(
            self.config.arbitrage_meteora_fee_pct,
            buy_quote.fee_pct if "Meteora" in buy_quote.dex else sell_quote.fee_pct,
        )
        ray_fee_sol = start_sol * (raydium_fee_pct / 100.0)
        meteora_fee_sol = start_sol * (meteora_fee_pct / 100.0)
        total_fee_sol = ray_fee_sol + meteora_fee_sol
        jito_tip_sol = self.config.arbitrage_base_jito_tip_sol
        net_profit_sol = gross_profit_sol - total_fee_sol - jito_tip_sol

        expected_return_pct = (net_profit_sol / start_sol) * 100.0 if start_sol > 0 else 0.0
        profitable = net_profit_sol >= self.config.arbitrage_min_profit_sol

        return ArbitrageOpportunity(
            token_mint=buy_quote.output_mint,
            buy_dex=buy_quote.dex,
            sell_dex=sell_quote.dex,
            start_sol=start_sol,
            final_sol=final_sol,
            gross_profit_sol=gross_profit_sol,
            total_fee_sol=total_fee_sol,
            jito_tip_sol=jito_tip_sol,
            net_profit_sol=net_profit_sol,
            expected_return_pct=expected_return_pct,
            profitable=profitable,
        )

    async def execute_atomic_bundle(
        self,
        session: aiohttp.ClientSession,
        opportunity: ArbitrageOpportunity,
        buy_tx_b64: str,
        sell_tx_b64: str,
        tip_tx_b64: str,
    ) -> Optional[str]:
        if not opportunity.profitable:
            return None
        if opportunity.net_profit_sol < self.config.arbitrage_min_profit_sol:
            return None
        if not buy_tx_b64 or not sell_tx_b64 or not tip_tx_b64:
            return None

        # Bundle submission provides all-or-nothing semantics for the loop.
        return await self.jito.send_bundle(session, [buy_tx_b64, sell_tx_b64, tip_tx_b64])

    async def monitor(
        self,
        token_mints: Sequence[str],
        trade_size_sol: float,
        on_opportunity: Callable[[ArbitrageOpportunity], Awaitable[None]],
        cycles: Optional[int] = None,
    ) -> None:
        loops = 0
        async with aiohttp.ClientSession() as session:
            while cycles is None or loops < cycles:
                loops += 1
                for token in token_mints:
                    opportunity = await self.detect_opportunity(
                        session=session,
                        token_mint=token,
                        trade_size_sol=trade_size_sol,
                    )
                    if opportunity is not None:
                        await on_opportunity(opportunity)
                await asyncio.sleep(self.config.arbitrage_poll_interval_ms / 1000.0)
