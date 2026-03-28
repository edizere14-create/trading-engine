# intent_signer.py - EIP-712 Intent Signing for Arbitrum Intent Layer
#
# Signs off-chain swap intents using EIP-712 typed data so they cannot
# be front-run. Compatible with 1inch Fusion / CoW Swap style resolvers.
#
# Regime-aware: SAFE_MODE tightens minReturn and shortens deadline.

import os
import time
from typing import Any, Dict, Optional

# ── Config ──────────────────────────────────────────────────────────────────
ARB_CHAIN_ID = int(os.getenv("ARB_CHAIN_ID", 42161))  # Arbitrum One
RESOLVER_CONTRACT = (os.getenv("INTENT_RESOLVER_CONTRACT") or "").strip()
ARB_PRIVATE_KEY = (os.getenv("ARB_PRIVATE_KEY") or "").strip()

# Deadline defaults (seconds from now)
INTENT_DEADLINE_NORMAL = int(os.getenv("INTENT_DEADLINE_NORMAL", 60))
INTENT_DEADLINE_SAFE = int(os.getenv("INTENT_DEADLINE_SAFE", 30))
INTENT_DEADLINE_AGGRESSIVE = int(os.getenv("INTENT_DEADLINE_AGGRESSIVE", 90))

# minReturn multipliers (fraction of expected output)
MIN_RETURN_FACTOR_NORMAL = float(os.getenv("MIN_RETURN_FACTOR_NORMAL", 0.97))      # 3% slippage
MIN_RETURN_FACTOR_SAFE = float(os.getenv("MIN_RETURN_FACTOR_SAFE", 0.99))          # 1% slippage
MIN_RETURN_FACTOR_AGGRESSIVE = float(os.getenv("MIN_RETURN_FACTOR_AGGRESSIVE", 0.95))  # 5% slippage

# EIP-712 type definitions
EIP712_DOMAIN = {
    "name": "EddyiIntentLayer",
    "version": "1",
    "chainId": ARB_CHAIN_ID,
    "verifyingContract": RESOLVER_CONTRACT,
}

EIP712_TYPES = {
    "SwapIntent": [
        {"name": "from", "type": "address"},
        {"name": "tokenIn", "type": "address"},
        {"name": "tokenOut", "type": "address"},
        {"name": "amount", "type": "uint256"},
        {"name": "minReturn", "type": "uint256"},
        {"name": "deadline", "type": "uint256"},
        {"name": "nonce", "type": "uint256"},
    ]
}


class IntentSigner:
    """
    Signs EIP-712 typed-data swap intents for the Arbitrum intent layer.

    The signer adapts its parameters based on the current market regime:
      - SAFE_MODE:   tight minReturn (99%), short deadline (30s)
      - NORMAL:      standard minReturn (97%), normal deadline (60s)
      - AGGRESSIVE:  loose minReturn (95%), long deadline (90s)
    """

    def __init__(self, private_key: Optional[str] = None) -> None:
        self._key = private_key or ARB_PRIVATE_KEY
        self._account = None
        self._address: str = ""
        self._init_error: str = ""

        if not self._key:
            self._init_error = "No ARB_PRIVATE_KEY configured"
            return

        try:
            from eth_account import Account
            self._account = Account.from_key(self._key)
            self._address = self._account.address
        except ImportError:
            self._init_error = "eth_account not installed (pip install eth-account)"
        except Exception as e:
            self._init_error = f"Failed to load key: {e}"

    @property
    def address(self) -> str:
        return self._address

    @property
    def is_ready(self) -> bool:
        return self._account is not None and bool(RESOLVER_CONTRACT)

    @property
    def status(self) -> Dict[str, Any]:
        return {
            "ready": self.is_ready,
            "address": self._address or None,
            "resolver": RESOLVER_CONTRACT or None,
            "chain_id": ARB_CHAIN_ID,
            "error": self._init_error or None,
        }

    def sign_swap_intent(
        self,
        token_in: str,
        token_out: str,
        amount: int,
        expected_output: int,
        regime: str = "NORMAL",
    ) -> Dict[str, Any]:
        """
        Sign an EIP-712 swap intent, adapting parameters to the regime.

        Args:
            token_in:        ERC-20 address of the input token
            token_out:       ERC-20 address of the output token
            amount:          Input amount in smallest unit (wei)
            expected_output: Expected output from a quote (wei)
            regime:          Current market regime from DynamicTuner

        Returns:
            Dict with 'ok', 'signature', 'message', and 'error' fields.
        """
        if not self.is_ready:
            return {
                "ok": False,
                "signature": None,
                "message": None,
                "error": self._init_error or "Signer not configured",
            }

        # Regime-aware parameters
        min_return_factor, deadline_seconds = self._regime_params(regime)
        min_return = int(expected_output * min_return_factor)
        deadline = int(time.time()) + deadline_seconds
        nonce = int(time.time() * 1000)

        message = {
            "from": self._address,
            "tokenIn": token_in,
            "tokenOut": token_out,
            "amount": amount,
            "minReturn": min_return,
            "deadline": deadline,
            "nonce": nonce,
        }

        try:
            from eth_account.messages import encode_typed_data

            signable = encode_typed_data(
                domain_data=EIP712_DOMAIN,
                message_types=EIP712_TYPES,
                message_data=message,
            )
            signed = self._account.sign_message(signable)

            print(
                f"[INTENT_SIGNER] Signed {regime} intent: "
                f"amount={amount} minReturn={min_return} "
                f"deadline=+{deadline_seconds}s"
            )

            return {
                "ok": True,
                "signature": signed.signature.hex(),
                "message": message,
                "error": None,
                "regime": regime,
                "min_return_factor": min_return_factor,
                "deadline_seconds": deadline_seconds,
            }

        except Exception as e:
            error_msg = f"EIP-712 signing failed: {e}"
            print(f"[INTENT_SIGNER] {error_msg}")
            return {
                "ok": False,
                "signature": None,
                "message": message,
                "error": error_msg,
            }

    def _regime_params(self, regime: str) -> tuple:
        """Return (min_return_factor, deadline_seconds) for the given regime."""
        if regime == "SAFE_MODE":
            return MIN_RETURN_FACTOR_SAFE, INTENT_DEADLINE_SAFE
        elif regime == "AGGRESSIVE":
            return MIN_RETURN_FACTOR_AGGRESSIVE, INTENT_DEADLINE_AGGRESSIVE
        return MIN_RETURN_FACTOR_NORMAL, INTENT_DEADLINE_NORMAL


# ── Module Singleton ────────────────────────────────────────────────────────
_signer: Optional[IntentSigner] = None


def get_signer() -> IntentSigner:
    global _signer
    if _signer is None:
        _signer = IntentSigner()
    return _signer
