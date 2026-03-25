import asyncio
import json
from collections import defaultdict
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Tuple

import aiohttp

from advanced_strategies.config import AdvancedStrategyConfig
from advanced_strategies.models import BundleScanResult, InstructionEvent, LPExecutionDecision
from advanced_strategies.rpc_clients import JitoBlockEngineClient, OpenAIReasoningClient, SolanaRpcClient

RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
SYSTEM_PROGRAM = "11111111111111111111111111111111"


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


class YellowstoneGrpcEventSource:
    def __init__(self, endpoint: str, x_token: str = "") -> None:
        self.endpoint = endpoint.strip()
        self.x_token = x_token.strip()

    async def stream_events(self) -> AsyncIterator[InstructionEvent]:
        if not self.endpoint:
            return
        try:
            import grpc  # type: ignore
            import yellowstone_pb2  # type: ignore
            import yellowstone_pb2_grpc  # type: ignore
        except Exception as exc:
            raise RuntimeError(
                "Yellowstone proto stubs are missing. Generate yellowstone_pb2.py and "
                "yellowstone_pb2_grpc.py in the python path."
            ) from exc

        metadata: List[Tuple[str, str]] = []
        if self.x_token:
            metadata.append(("x-token", self.x_token))

        channel = grpc.aio.secure_channel(
            self.endpoint, grpc.ssl_channel_credentials()
        )
        stub = yellowstone_pb2_grpc.GeyserStub(channel)

        request = yellowstone_pb2.SubscribeRequest()
        if hasattr(request, "transactions"):
            tx_filter = request.transactions["lp_init"]
            tx_filter.failed = False
            tx_filter.account_include.extend([RAYDIUM_AMM_V4, METEORA_DLMM])

        call = stub.Subscribe(iter([request]), metadata=metadata)
        async for update in call:
            event = self._parse_update(update)
            if event is not None:
                yield event

    def _parse_update(self, update: Any) -> Optional[InstructionEvent]:
        update_json = json.loads(str(update)) if not isinstance(update, dict) else update

        slot = _safe_int(update_json.get("slot"), 0)
        signature = str(update_json.get("signature") or "")
        if slot <= 0 or not signature:
            return None

        instruction = json.dumps(update_json).lower()
        if "initialize2" in instruction:
            dex = "RAYDIUM"
            name = "Initialize2"
        elif "initializeconfig" in instruction or "initializelbpair" in instruction:
            dex = "METEORA"
            name = "InitializeConfig"
        else:
            return None

        account_keys = update_json.get("accountKeys")
        deployer = ""
        if isinstance(account_keys, list) and account_keys:
            first = account_keys[0]
            deployer = str(first.get("pubkey") if isinstance(first, dict) else first)

        token_mint = str(update_json.get("tokenMint") or "")
        if not token_mint:
            token_mint = str(update_json.get("mint") or "")

        return InstructionEvent(
            slot=slot,
            signature=signature,
            deployer=deployer,
            token_mint=token_mint,
            instruction_name=name,
            dex=dex,
            raw=update_json,
        )


class ZeroBlockLPSniper:
    def __init__(
        self,
        config: AdvancedStrategyConfig,
        rpc_client: SolanaRpcClient,
        jito_client: JitoBlockEngineClient,
        openai_client: Optional[OpenAIReasoningClient] = None,
    ) -> None:
        self.config = config
        self.rpc = rpc_client
        self.jito = jito_client
        self.openai = openai_client
        self._root_funder_cache: Dict[str, str] = {}

    async def evaluate_event(
        self,
        session: aiohttp.ClientSession,
        event: InstructionEvent,
    ) -> LPExecutionDecision:
        scan = await self.scan_slot_bundle(session, event)
        high_risk = scan.high_risk_rug
        reason = scan.reason

        if self.config.enable_llm_rug_reasoning and self.openai is not None:
            llm_high_risk, llm_reason = await self._llm_rug_check(session, event, scan)
            if llm_high_risk:
                high_risk = True
                reason = f"{reason}; LLM risk override: {llm_reason}"

        if high_risk:
            return LPExecutionDecision(
                should_execute=False,
                risk_label="HIGH_RISK_RUG",
                reason=reason,
                scan=scan,
            )
        return LPExecutionDecision(
            should_execute=True,
            risk_label="CLEAN",
            reason=reason,
            scan=scan,
        )

    async def scan_slot_bundle(
        self,
        session: aiohttp.ClientSession,
        event: InstructionEvent,
    ) -> BundleScanResult:
        block = await self.rpc.get_block(session, event.slot)
        transactions = block.get("transactions") if isinstance(block, dict) else []
        txs = transactions if isinstance(transactions, list) else []
        txs = txs[: max(1, self.config.bundle_scan_limit)]

        distributed_wallets = self._count_distributed_wallets(txs, event.token_mint, event.deployer)
        detected_bundle = distributed_wallets > self.config.bundle_same_root_threshold

        concentration_ratio, dominant_root = await self.calculate_bundle_concentration_ratio(
            session=session,
            token_mint=event.token_mint,
            current_slot=event.slot,
        )
        high_risk_rug = concentration_ratio > self.config.bundle_concentration_threshold
        reason = (
            "bundle+concentration risk"
            if detected_bundle and high_risk_rug
            else "bundle observed but concentration acceptable"
            if detected_bundle
            else "no suspicious bundle pattern"
        )

        return BundleScanResult(
            slot=event.slot,
            candidate_transactions=len(txs),
            distributed_wallets=distributed_wallets,
            detected_bundle=detected_bundle,
            bundle_concentration_ratio=concentration_ratio,
            high_risk_rug=high_risk_rug,
            dominant_root_account=dominant_root,
            reason=reason,
        )

    async def execute_if_clean(
        self,
        session: aiohttp.ClientSession,
        event: InstructionEvent,
        swap_tx_b64: str,
        tip_tx_b64: str,
    ) -> Tuple[LPExecutionDecision, Optional[str]]:
        decision = await self.evaluate_event(session, event)
        if not decision.should_execute:
            return decision, None
        if not swap_tx_b64 or not tip_tx_b64:
            return decision, None

        await self.jito.submit_tip_transaction(session, tip_tx_b64)
        bundle_id = await self.jito.send_bundle(session, [swap_tx_b64, tip_tx_b64])
        return decision, bundle_id

    async def run(
        self,
        event_source: YellowstoneGrpcEventSource,
        swap_tx_builder: Callable[[InstructionEvent], Awaitable[str]],
        tip_tx_builder: Callable[[int], Awaitable[str]],
        on_decision: Optional[Callable[[LPExecutionDecision, Optional[str]], Awaitable[None]]] = None,
    ) -> None:
        async with aiohttp.ClientSession() as session:
            async for event in event_source.stream_events():
                if not event.token_mint:
                    continue
                swap_tx = await swap_tx_builder(event)
                tip_tx = await tip_tx_builder(self.config.jito_tip_lamports)
                decision, bundle_id = await self.execute_if_clean(
                    session=session,
                    event=event,
                    swap_tx_b64=swap_tx,
                    tip_tx_b64=tip_tx,
                )
                if on_decision:
                    await on_decision(decision, bundle_id)

    def _count_distributed_wallets(
        self,
        transactions: List[Dict[str, Any]],
        token_mint: str,
        deployer: str,
    ) -> int:
        recipients: set[str] = set()
        for tx in transactions:
            for owner, delta in self._token_owner_deltas(tx, token_mint).items():
                if owner and owner != deployer and delta > 0:
                    recipients.add(owner)
        return len(recipients)

    def _token_owner_deltas(
        self, tx: Dict[str, Any], token_mint: str
    ) -> Dict[str, float]:
        meta = tx.get("meta") if isinstance(tx, dict) else {}
        pre = meta.get("preTokenBalances") if isinstance(meta, dict) else []
        post = meta.get("postTokenBalances") if isinstance(meta, dict) else []

        def to_map(entries: Any) -> Dict[str, float]:
            balances: Dict[str, float] = defaultdict(float)
            if not isinstance(entries, list):
                return balances
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                if entry.get("mint") != token_mint:
                    continue
                owner = str(entry.get("owner") or "")
                ui = entry.get("uiTokenAmount") if isinstance(entry, dict) else {}
                if not isinstance(ui, dict):
                    continue
                amount = _safe_float(ui.get("uiAmountString"), _safe_float(ui.get("uiAmount"), 0.0))
                if owner:
                    balances[owner] += amount
            return balances

        pre_map = to_map(pre)
        post_map = to_map(post)
        owners = set(pre_map.keys()) | set(post_map.keys())
        deltas: Dict[str, float] = {}
        for owner in owners:
            deltas[owner] = post_map.get(owner, 0.0) - pre_map.get(owner, 0.0)
        return deltas

    async def calculate_bundle_concentration_ratio(
        self,
        session: aiohttp.ClientSession,
        token_mint: str,
        current_slot: int,
    ) -> Tuple[float, Optional[str]]:
        largest_accounts = await self.rpc.get_token_largest_accounts(session, token_mint)
        if not largest_accounts:
            return 0.0, None

        token_supply = await self.rpc.get_token_supply(session, token_mint)
        if token_supply <= 0:
            token_supply = sum(
                _safe_float(a.get("uiAmount"), 0.0)
                for a in largest_accounts
                if isinstance(a, dict)
            )
        if token_supply <= 0:
            return 0.0, None

        root_balances: Dict[str, float] = defaultdict(float)
        semaphore = asyncio.Semaphore(8)

        async def process_holder(entry: Dict[str, Any]) -> None:
            token_account = str(entry.get("address") or "")
            amount = _safe_float(entry.get("uiAmount"), 0.0)
            if not token_account or amount <= 0:
                return
            owner = await self._token_account_owner(session, token_account)
            if not owner:
                return
            async with semaphore:
                root = await self._root_funder_for_wallet(session, owner, current_slot)
            root_balances[root] += amount

        await asyncio.gather(
            *(process_holder(item) for item in largest_accounts if isinstance(item, dict))
        )
        if not root_balances:
            return 0.0, None

        dominant_root, dominant_amount = max(root_balances.items(), key=lambda pair: pair[1])
        return dominant_amount / token_supply, dominant_root

    async def _token_account_owner(
        self, session: aiohttp.ClientSession, token_account: str
    ) -> str:
        account_info = await self.rpc.get_parsed_account_info(session, token_account)
        value = account_info.get("value") if isinstance(account_info, dict) else {}
        data = value.get("data") if isinstance(value, dict) else {}
        parsed = data.get("parsed") if isinstance(data, dict) else {}
        info = parsed.get("info") if isinstance(parsed, dict) else {}
        owner = info.get("owner") if isinstance(info, dict) else ""
        return str(owner or "")

    async def _root_funder_for_wallet(
        self, session: aiohttp.ClientSession, wallet: str, current_slot: int
    ) -> str:
        if wallet in self._root_funder_cache:
            return self._root_funder_cache[wallet]

        signatures = await self.rpc.get_signatures_for_address(session, wallet, limit=25)
        for sig_info in signatures:
            if not isinstance(sig_info, dict):
                continue
            slot = _safe_int(sig_info.get("slot"), 0)
            if slot <= 0 or (current_slot - slot) > self.config.bundle_funder_lookback_blocks:
                continue
            signature = str(sig_info.get("signature") or "")
            if not signature:
                continue
            tx = await self.rpc.get_transaction(session, signature)
            root = self._extract_funder_from_tx(tx, wallet)
            if root:
                self._root_funder_cache[wallet] = root
                return root

        self._root_funder_cache[wallet] = wallet
        return wallet

    def _extract_funder_from_tx(self, tx: Optional[Dict[str, Any]], wallet: str) -> str:
        if not isinstance(tx, dict):
            return ""
        transaction = tx.get("transaction") if isinstance(tx, dict) else {}
        message = transaction.get("message") if isinstance(transaction, dict) else {}
        instructions = message.get("instructions") if isinstance(message, dict) else []
        if not isinstance(instructions, list):
            return ""
        for instruction in instructions:
            if not isinstance(instruction, dict):
                continue
            parsed = instruction.get("parsed") if isinstance(instruction, dict) else {}
            if not isinstance(parsed, dict):
                continue
            if parsed.get("type") != "transfer":
                continue
            info = parsed.get("info") if isinstance(parsed, dict) else {}
            if not isinstance(info, dict):
                continue
            destination = str(info.get("destination") or "")
            source = str(info.get("source") or "")
            if destination == wallet and source:
                return source
        return ""

    async def _llm_rug_check(
        self,
        session: aiohttp.ClientSession,
        event: InstructionEvent,
        scan: BundleScanResult,
    ) -> Tuple[bool, str]:
        if self.openai is None:
            return False, ""
        system_prompt = (
            "You are a Solana risk analyst. Output JSON with keys high_risk (bool) and "
            "reason (string) only."
        )
        user_prompt = (
            f"token={event.token_mint}\n"
            f"dex={event.dex}\n"
            f"instruction={event.instruction_name}\n"
            f"slot={event.slot}\n"
            f"distributed_wallets={scan.distributed_wallets}\n"
            f"bundle_detected={scan.detected_bundle}\n"
            f"bundle_concentration_ratio={scan.bundle_concentration_ratio:.6f}\n"
            f"threshold={self.config.bundle_concentration_threshold:.6f}\n"
            "Decide if this is likely a coordinated rug setup."
        )
        parsed = await self.openai.chat_json(
            session=session,
            model=self.config.openai_rug_model,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            timeout_seconds=10.0,
        )
        if not isinstance(parsed, dict):
            return False, ""
        high_risk = bool(parsed.get("high_risk"))
        reason = str(parsed.get("reason") or "")
        return high_risk, reason
