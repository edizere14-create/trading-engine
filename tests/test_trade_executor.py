import importlib
import os
import sys
import time
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch


class TradeExecutorTests(unittest.TestCase):
    def setUp(self):
        self.state_file = Path(__file__).resolve().parent / "state_test.json"
        if self.state_file.exists():
            self.state_file.unlink()
        os.environ["STATE_FILE"] = str(self.state_file)
        os.environ["KILL_SWITCH_MODE"] = "OFF"
        os.environ["MAX_NOTIONAL_USD_PER_TRADE"] = "1000"
        os.environ["MAX_NOTIONAL_USD_PER_DAY"] = "10000"
        os.environ["REQUIRE_QUOTE_FOR_EXECUTION"] = "true"
        os.environ["NOTIONAL_LIMIT_APPLIES_TO_SELLS"] = "false"

        if "trade_executor" in sys.modules:
            del sys.modules["trade_executor"]

        self.te = importlib.import_module("trade_executor")
        self.te.state = self.te._default_state()

    def tearDown(self):
        if self.state_file.exists():
            self.state_file.unlink()
        if "trade_executor" in sys.modules:
            del sys.modules["trade_executor"]

    def test_get_pool_info_estimates_liquidity_with_price_impact(self):
        self.te.LIQUIDITY_PROBE_SIZES_SOL = (1.0, 2.0, 5.0)
        self.te.LIQUIDITY_MAX_PRICE_IMPACT_PCT = 10.0

        quote_small = {
            "outAmount": "1000000",
            "routePlan": [{"swapInfo": {"label": "Raydium"}}],
        }
        quote_mid = {
            "outAmount": "1900000",
            "routePlan": [{"swapInfo": {"label": "Raydium"}}],
        }
        quote_large = {
            "outAmount": "4000000",
            "routePlan": [{"swapInfo": {"label": "Meteora"}}],
        }

        with patch.object(
            self.te,
            "_fetch_jupiter_quote",
            side_effect=[quote_small, quote_mid, quote_large],
        ), patch.object(
            self.te,
            "_fetch_helius_asset",
            return_value={"content": {"metadata": {"symbol": "TEST"}}},
        ):
            pool = self.te.get_pool_info("TestMint111111111111111111111111111111111")

        self.assertEqual(pool["symbol"], "TEST")
        self.assertAlmostEqual(pool["liqSOL"], 2.0)
        self.assertEqual(pool["routeLabel"], "Raydium")
        self.assertGreater(pool["impactPct"], 0.0)

    def test_check_risk_limits_uses_usd_daily_loss(self):
        self.te.state = self.te._default_state()
        self.te.state["daily_pnl_usd"] = -21.0
        self.te.MAX_DAILY_LOSS_PCT = 20.0
        self.te.INITIAL_CAPITAL_USD = 100.0

        allowed, reason = self.te.check_risk_limits("MintA", "BUY", 10.0)

        self.assertFalse(allowed)
        self.assertIn("Max daily loss", reason)

    def test_execute_trade_tracks_realized_pnl_in_sol_and_usd(self):
        self.te.state = self.te._default_state()

        with patch.object(self.te, "save_state"), patch.object(
            self.te, "send_telegram"
        ), patch.object(
            self.te,
            "get_pool_info",
            return_value={
                "tokenCA": "MintA",
                "symbol": "T",
                "liqSOL": 500.0,
                "impactPct": 0.5,
                "impactThresholdPct": 2.0,
                "routeLabel": "Raydium",
                "source": "helius+jupiter",
            },
        ), patch.object(
            self.te,
            "_build_buy_quote_context",
            return_value={
                "quote": {"outAmount": "10000000"},
                "expected_token_amount": 10.0,
                "impact_pct": 0.1,
                "route_label": "Raydium",
            },
        ), patch.object(
            self.te,
            "_build_sell_quote_context",
            return_value={
                "quote": {"outAmount": "600000000"},
                "expected_sol_out": 0.6,
                "impact_pct": 0.1,
                "route_label": "Raydium",
            },
        ), patch.object(
            self.te,
            "get_sol_usd_price",
            side_effect=[100.0, 110.0],
        ):
            self.te.execute_trade("MintA", "BUY", 1.0, token_amount=10.0)
            self.te.execute_trade("MintA", "SELL", 0.6, token_amount=5.0)

        self.assertAlmostEqual(self.te.state["daily_pnl_sol"], 0.1, places=8)
        self.assertAlmostEqual(self.te.state["daily_pnl_usd"], 16.0, places=8)
        remaining = self.te.get_position("MintA")
        self.assertIsNotNone(remaining)
        self.assertAlmostEqual(remaining["token_amount"], 5.0, places=8)
        self.assertAlmostEqual(remaining["cost_basis_sol"], 0.5, places=8)
        self.assertAlmostEqual(remaining["cost_basis_usd"], 50.0, places=8)
        self.assertAlmostEqual(self.te.state["daily_notional_usd"], 100.0, places=8)

    def test_preview_trade_does_not_mutate_state_or_send(self):
        self.te.state = self.te._default_state()
        self.te.state["open_positions"]["MintA"] = {
            "token_amount": 10.0,
            "cost_basis_sol": 1.0,
            "cost_basis_usd": 100.0,
            "avg_entry_sol": 0.1,
            "avg_entry_usd": 10.0,
            "buy_count": 1,
        }
        before = deepcopy(self.te.state)

        with patch.object(self.te, "save_state") as save_state_mock, patch.object(
            self.te, "send_telegram"
        ) as send_telegram_mock, patch.object(
            self.te,
            "get_pool_info",
            return_value={
                "tokenCA": "MintA",
                "symbol": "T",
                "liqSOL": 500.0,
                "impactPct": 0.5,
                "impactThresholdPct": 2.0,
                "routeLabel": "Raydium",
                "source": "helius+jupiter",
            },
        ), patch.object(
            self.te,
            "_build_sell_quote_context",
            return_value={
                "quote": {"outAmount": "600000000"},
                "expected_sol_out": 0.6,
                "impact_pct": 0.1,
                "route_label": "Raydium",
            },
        ), patch.object(
            self.te,
            "get_sol_usd_price",
            return_value=110.0,
        ):
            ok = self.te.preview_trade("MintA", "SELL", 0.6, token_amount=5.0)

        self.assertTrue(ok)
        self.assertEqual(self.te.state, before)
        save_state_mock.assert_not_called()
        send_telegram_mock.assert_not_called()

    def test_kill_switch_blocks_buy(self):
        self.te.KILL_SWITCH_MODE = "BLOCK_ALL"
        allowed, reason = self.te.check_risk_limits("MintA", "BUY", 10.0)
        self.assertFalse(allowed)
        self.assertIn("kill-switch", reason.lower())

    def test_max_notional_per_trade_blocks_buy(self):
        self.te.MAX_NOTIONAL_USD_PER_TRADE = 50.0
        allowed, reason = self.te.check_risk_limits("MintA", "BUY", 75.0)
        self.assertFalse(allowed)
        self.assertIn("notional", reason.lower())

    def test_circuit_breaker_opens_after_consecutive_failures(self):
        self.te.API_MAX_RETRIES = 1
        self.te.CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2
        self.te.CIRCUIT_BREAKER_COOLDOWN_SECONDS = 30.0
        self.te._api_circuit_state["jupiter"] = {"failures": 0.0, "open_until": 0.0}

        with patch("trade_executor.requests.request", side_effect=self.te.requests.RequestException()):
            self.assertIsNone(self.te._request_json("jupiter", "GET", "https://example.com"))
            self.assertIsNone(self.te._request_json("jupiter", "GET", "https://example.com"))

        open_until = self.te._api_circuit_state["jupiter"]["open_until"]
        self.assertGreater(open_until, time.time())

        with patch("trade_executor.requests.request") as request_mock:
            self.assertIsNone(self.te._request_json("jupiter", "GET", "https://example.com"))
            request_mock.assert_not_called()

    def test_buy_fill_slippage_guardrail_blocks_execution(self):
        self.te.state = self.te._default_state()
        self.te.MAX_FILL_SLIPPAGE_BPS = 50.0

        with patch.object(self.te, "save_state"), patch.object(
            self.te, "send_telegram"
        ), patch.object(
            self.te,
            "get_pool_info",
            return_value={
                "tokenCA": "MintA",
                "symbol": "T",
                "decimals": 6,
                "liqSOL": 500.0,
                "impactPct": 0.1,
                "impactThresholdPct": 2.0,
                "routeLabel": "Raydium",
                "source": "helius+jupiter",
            },
        ), patch.object(
            self.te,
            "_build_buy_quote_context",
            return_value={
                "quote": {"outAmount": "100000000"},
                "expected_token_amount": 100.0,
                "impact_pct": 0.1,
                "route_label": "Raydium",
            },
        ), patch.object(
            self.te,
            "get_sol_usd_price",
            return_value=100.0,
        ):
            self.te.execute_trade("MintA", "BUY", 1.0, token_amount=90.0)

        self.assertEqual(self.te.state["trades_today"], 0)
        self.assertNotIn("MintA", self.te.state["open_positions"])

    def test_execute_live_swap_retries_until_confirmed(self):
        with patch.object(
            self.te,
            "_load_live_wallet_context",
            return_value=({"keypair": object(), "pubkey": "Wallet111"}, ""),
        ), patch.object(
            self.te,
            "_build_jupiter_swap_transaction",
            return_value=("tx_b64", ""),
        ), patch.object(
            self.te,
            "_sign_versioned_transaction",
            return_value=("signed_b64", "sig_abc", ""),
        ), patch.object(
            self.te,
            "_wait_for_signature",
            side_effect=[(False, "timeout"), (True, "")],
        ), patch.object(
            self.te,
            "_reconcile_fill_from_signature",
            return_value=(
                {
                    "signature": "sig_abc",
                    "actual_token_amount": 12.0,
                    "actual_sol_amount": 0.5,
                    "fee_sol": 0.00001,
                    "slot": 1,
                },
                "",
            ),
        ), patch.object(
            self.te,
            "_rpc_call",
            return_value=(None, "rpc transient"),
        ) as rpc_call_mock:
            fill, error = self.te._execute_live_swap("BUY", "MintA", {"outAmount": "1"})

        self.assertEqual(error, "")
        self.assertIsNotNone(fill)
        self.assertEqual(fill["signature"], "sig_abc")
        self.assertGreaterEqual(rpc_call_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
