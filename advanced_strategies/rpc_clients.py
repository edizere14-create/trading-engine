import json
from typing import Any, Dict, List, Optional, Sequence

import aiohttp


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


class SolanaRpcClient:
    def __init__(self, rpc_url: str, timeout_seconds: float = 8.0) -> None:
        self.rpc_url = rpc_url.strip()
        self.timeout_seconds = timeout_seconds
        self._id_counter = 0

    async def rpc_call(
        self, session: aiohttp.ClientSession, method: str, params: Sequence[Any]
    ) -> Optional[Any]:
        if not self.rpc_url:
            return None

        self._id_counter += 1
        payload = {
            "jsonrpc": "2.0",
            "id": f"advanced-strategy-{self._id_counter}",
            "method": method,
            "params": list(params),
        }
        try:
            async with session.post(
                self.rpc_url, json=payload, timeout=self.timeout_seconds
            ) as response:
                if response.status != 200:
                    return None
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return None

        if not isinstance(parsed, dict):
            return None
        if parsed.get("error"):
            return None
        return parsed.get("result")

    async def get_block(
        self, session: aiohttp.ClientSession, slot: int, max_supported_version: int = 0
    ) -> Optional[Dict[str, Any]]:
        result = await self.rpc_call(
            session,
            "getBlock",
            [
                slot,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": max_supported_version,
                    "transactionDetails": "full",
                    "rewards": False,
                },
            ],
        )
        return result if isinstance(result, dict) else None

    async def get_slot(self, session: aiohttp.ClientSession) -> int:
        result = await self.rpc_call(session, "getSlot", [{"commitment": "confirmed"}])
        return _safe_int(result, 0)

    async def get_transaction(
        self, session: aiohttp.ClientSession, signature: str, max_supported_version: int = 0
    ) -> Optional[Dict[str, Any]]:
        result = await self.rpc_call(
            session,
            "getTransaction",
            [
                signature,
                {
                    "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": max_supported_version,
                    "commitment": "confirmed",
                },
            ],
        )
        return result if isinstance(result, dict) else None

    async def get_signatures_for_address(
        self,
        session: aiohttp.ClientSession,
        address: str,
        limit: int = 20,
    ) -> List[Dict[str, Any]]:
        result = await self.rpc_call(
            session,
            "getSignaturesForAddress",
            [
                address,
                {
                    "limit": max(1, min(limit, 100)),
                    "commitment": "confirmed",
                },
            ],
        )
        return result if isinstance(result, list) else []

    async def get_parsed_account_info(
        self, session: aiohttp.ClientSession, account: str
    ) -> Optional[Dict[str, Any]]:
        result = await self.rpc_call(
            session,
            "getAccountInfo",
            [account, {"encoding": "jsonParsed", "commitment": "confirmed"}],
        )
        return result if isinstance(result, dict) else None

    async def get_token_largest_accounts(
        self, session: aiohttp.ClientSession, mint: str
    ) -> List[Dict[str, Any]]:
        result = await self.rpc_call(session, "getTokenLargestAccounts", [mint])
        if not isinstance(result, dict):
            return []
        value = result.get("value")
        return value if isinstance(value, list) else []

    async def get_token_supply(
        self, session: aiohttp.ClientSession, mint: str
    ) -> float:
        result = await self.rpc_call(session, "getTokenSupply", [mint])
        if not isinstance(result, dict):
            return 0.0
        value = result.get("value")
        if not isinstance(value, dict):
            return 0.0
        return _safe_float(value.get("uiAmount"), 0.0)


class JitoBlockEngineClient:
    def __init__(self, endpoint_url: str, timeout_seconds: float = 6.0) -> None:
        self.endpoint_url = endpoint_url.strip()
        self.timeout_seconds = timeout_seconds

    async def send_bundle(
        self, session: aiohttp.ClientSession, transactions_b64: Sequence[str]
    ) -> Optional[str]:
        if not self.endpoint_url:
            return None
        txs = [tx for tx in transactions_b64 if isinstance(tx, str) and tx]
        if not txs:
            return None
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendBundle",
            "params": [txs, {"encoding": "base64"}],
        }
        try:
            async with session.post(
                self.endpoint_url, json=payload, timeout=self.timeout_seconds
            ) as response:
                if response.status != 200:
                    return None
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return None

        if not isinstance(parsed, dict):
            return None
        if parsed.get("error"):
            return None
        result = parsed.get("result")
        return str(result) if result is not None else None

    async def submit_tip_transaction(
        self, session: aiohttp.ClientSession, signed_tip_tx_b64: str
    ) -> Optional[str]:
        if not self.endpoint_url:
            return None
        if not signed_tip_tx_b64:
            return None
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendTransaction",
            "params": [
                signed_tip_tx_b64,
                {
                    "encoding": "base64",
                    "skipPreflight": True,
                    "maxRetries": 0,
                },
            ],
        }
        try:
            async with session.post(
                self.endpoint_url, json=payload, timeout=self.timeout_seconds
            ) as response:
                if response.status != 200:
                    return None
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return None

        if not isinstance(parsed, dict):
            return None
        if parsed.get("error"):
            return None
        result = parsed.get("result")
        return str(result) if result is not None else None


class OpenAIReasoningClient:
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1") -> None:
        self.api_key = api_key.strip()
        self.base_url = base_url.rstrip("/")

    async def chat_json(
        self,
        session: aiohttp.ClientSession,
        model: str,
        system_prompt: str,
        user_prompt: str,
        timeout_seconds: float = 12.0,
    ) -> Optional[Dict[str, Any]]:
        if not self.api_key:
            return None
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "response_format": {"type": "json_object"},
            "temperature": 0.2,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            async with session.post(
                f"{self.base_url}/chat/completions",
                json=payload,
                headers=headers,
                timeout=timeout_seconds,
            ) as response:
                if response.status != 200:
                    return None
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return None

        choices = parsed.get("choices") if isinstance(parsed, dict) else None
        if not isinstance(choices, list) or not choices:
            return None
        first = choices[0] if isinstance(choices[0], dict) else {}
        message = first.get("message") if isinstance(first, dict) else {}
        content = message.get("content") if isinstance(message, dict) else ""
        if not isinstance(content, str):
            return None
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None


class XApiClient:
    def __init__(self, bearer_token: str) -> None:
        self.bearer_token = bearer_token.strip()

    async def fetch_recent_tweets(
        self, session: aiohttp.ClientSession, query: str, max_results: int = 50
    ) -> List[str]:
        if not self.bearer_token:
            return []
        params = {
            "query": query,
            "max_results": str(max(10, min(max_results, 100))),
            "tweet.fields": "created_at,public_metrics,lang",
        }
        headers = {"Authorization": f"Bearer {self.bearer_token}"}
        try:
            async with session.get(
                "https://api.x.com/2/tweets/search/recent",
                params=params,
                headers=headers,
                timeout=8.0,
            ) as response:
                if response.status != 200:
                    return []
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return []

        data = parsed.get("data") if isinstance(parsed, dict) else None
        if not isinstance(data, list):
            return []

        texts: List[str] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())
        return texts


class MarketDataClient:
    def __init__(self, birdeye_api_key: str, dexscreener_base_url: str) -> None:
        self.birdeye_api_key = birdeye_api_key.strip()
        self.dexscreener_base_url = dexscreener_base_url.rstrip("/")

    async def fetch_birdeye_overview(
        self, session: aiohttp.ClientSession, token_mint: str
    ) -> Dict[str, Any]:
        if not self.birdeye_api_key:
            return {}
        headers = {
            "X-API-KEY": self.birdeye_api_key,
            "accept": "application/json",
        }
        try:
            async with session.get(
                "https://public-api.birdeye.so/defi/token_overview",
                params={"address": token_mint},
                headers=headers,
                timeout=8.0,
            ) as response:
                if response.status != 200:
                    return {}
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return {}
        data = parsed.get("data") if isinstance(parsed, dict) else None
        return data if isinstance(data, dict) else {}

    async def fetch_dexscreener_pairs(
        self, session: aiohttp.ClientSession, token_mint: str
    ) -> List[Dict[str, Any]]:
        try:
            async with session.get(
                f"{self.dexscreener_base_url}/tokens/{token_mint}",
                timeout=8.0,
            ) as response:
                if response.status != 200:
                    return []
                parsed = await response.json()
        except (aiohttp.ClientError, TimeoutError, json.JSONDecodeError):
            return []
        pairs = parsed.get("pairs") if isinstance(parsed, dict) else None
        return pairs if isinstance(pairs, list) else []
