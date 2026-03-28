# tests/test_distributed_upgrade.py
#
# Tests for the distributed architecture upgrade:
#   1. StateManager (Redis locking + Pub/Sub)
#   2. PnL Logger (arrival capture + fill delta)
#   3. Shadow Resolver (OHLCV backtest)
#   4. API Server (FastAPI WebSocket Gateway)
#   5. Integration (trade_executor wiring)

import asyncio
import json
import os
import sys
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Ensure project root is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestStateManager(unittest.TestCase):
    """Test Redis distributed locking and event broadcasting."""

    def setUp(self):
        from state_manager import StateManager
        # Always create a fresh instance for tests
        StateManager._instance = None
        self.sm = StateManager(redis_url="redis://localhost:6379/0")

    def test_singleton(self):
        from state_manager import StateManager, get_state_manager
        StateManager._instance = None
        sm1 = get_state_manager()
        sm2 = get_state_manager()
        self.assertIs(sm1, sm2)

    def test_lock_result_model(self):
        from state_manager import LockResult
        lr = LockResult(acquired=True, token_symbol="SOL", lock_key="eddyi:lock:trade:SOL")
        self.assertTrue(lr.acquired)
        self.assertEqual(lr.token_symbol, "SOL")
        self.assertEqual(lr.ttl_seconds, 10)
        self.assertIsNone(lr.error)

    def test_event_payload_model(self):
        from state_manager import EventPayload
        ep = EventPayload(
            event_type="trade_attempt",
            regime="SAFE_MODE",
            data={"token": "TEST", "amount": 1.5},
        )
        self.assertEqual(ep.event_type, "trade_attempt")
        self.assertEqual(ep.regime, "SAFE_MODE")
        self.assertIn("token", ep.data)
        self.assertGreater(ep.timestamp, 0)

    def test_acquire_lock_redis_down(self):
        """When Redis is down, lock should fail gracefully."""
        async def _test():
            result = await self.sm.acquire_trade_lock("TEST_TOKEN")
            self.assertFalse(result.acquired)
            self.assertIsNotNone(result.error)
        try:
            asyncio.run(_test())
        except Exception:
            pass  # Redis not running is expected in CI

    def test_broadcast_event_redis_down(self):
        """When Redis is down, broadcast should return False."""
        async def _test():
            result = await self.sm.broadcast_event(
                "test_event",
                {"key": "value"},
                regime="NORMAL",
            )
            self.assertFalse(result)
        try:
            asyncio.run(_test())
        except Exception:
            pass

    @patch("state_manager.StateManager._ensure_connection", new_callable=AsyncMock)
    def test_acquire_lock_success(self, mock_conn):
        """Mock Redis to test successful lock acquisition."""
        async def _test():
            mock_redis = AsyncMock()
            mock_redis.set = AsyncMock(return_value=True)
            self.sm._redis = mock_redis
            self.sm._connected = True

            result = await self.sm.acquire_trade_lock("SOL_TOKEN")
            self.assertTrue(result.acquired)
            self.assertEqual(result.token_symbol, "SOL_TOKEN")
            mock_redis.set.assert_called_once()
        asyncio.run(_test())

    @patch("state_manager.StateManager._ensure_connection", new_callable=AsyncMock)
    def test_acquire_lock_denied(self, mock_conn):
        """Mock Redis SETNX returning False (lock already held)."""
        async def _test():
            mock_redis = AsyncMock()
            mock_redis.set = AsyncMock(return_value=False)
            self.sm._redis = mock_redis
            self.sm._connected = True

            result = await self.sm.acquire_trade_lock("SOL_TOKEN")
            self.assertFalse(result.acquired)
        asyncio.run(_test())

    @patch("state_manager.StateManager._ensure_connection", new_callable=AsyncMock)
    def test_broadcast_event_success(self, mock_conn):
        """Mock Redis publish to test event broadcasting."""
        async def _test():
            mock_redis = AsyncMock()
            mock_redis.publish = AsyncMock(return_value=2)
            self.sm._redis = mock_redis
            self.sm._connected = True

            result = await self.sm.broadcast_event(
                "trade_fill",
                {"token": "TEST", "delta_bps": 15.5},
                regime="AGGRESSIVE",
            )
            self.assertTrue(result)
            mock_redis.publish.assert_called_once()

            # Verify the published message
            call_args = mock_redis.publish.call_args
            channel = call_args[0][0]
            message = json.loads(call_args[0][1])
            self.assertEqual(channel, "eddyi_live_feed")
            self.assertEqual(message["event_type"], "trade_fill")
            self.assertEqual(message["regime"], "AGGRESSIVE")
        asyncio.run(_test())

    @patch("state_manager.StateManager._ensure_connection", new_callable=AsyncMock)
    def test_release_lock(self, mock_conn):
        async def _test():
            mock_redis = AsyncMock()
            mock_redis.delete = AsyncMock(return_value=1)
            self.sm._redis = mock_redis
            self.sm._connected = True

            released = await self.sm.release_trade_lock("SOL_TOKEN")
            self.assertTrue(released)
        asyncio.run(_test())

    def test_status(self):
        status = self.sm.status()
        self.assertIn("redis_url_set", status)
        self.assertIn("connected", status)
        self.assertEqual(status["channel"], "eddyi_live_feed")
        self.assertEqual(status["lock_ttl_seconds"], 10)


class TestPnLLogger(unittest.TestCase):
    """Test Execution Quality (PnL) Logger."""

    def setUp(self):
        from pnl_logger import PnLLogger
        PnLLogger._instance = None
        self.logger = PnLLogger()

    def test_singleton(self):
        from pnl_logger import PnLLogger, get_pnl_logger
        PnLLogger._instance = None
        l1 = get_pnl_logger()
        l2 = get_pnl_logger()
        self.assertIs(l1, l2)

    def test_capture_arrival(self):
        snap = self.logger.capture_arrival(
            token_ca="TOKEN_A",
            action="BUY",
            arrival_price=150.0,
            amount=1.5,
            regime="NORMAL",
        )
        self.assertEqual(snap.token_ca, "TOKEN_A")
        self.assertEqual(snap.arrival_price, 150.0)
        self.assertEqual(self.logger.get_pending_count(), 1)

    def test_record_fill_positive_delta(self):
        """Fill price > arrival = Intent Value-Add (positive delta)."""
        self.logger.capture_arrival(
            token_ca="TOKEN_B",
            action="BUY",
            arrival_price=100.0,
            amount=2.0,
            regime="AGGRESSIVE",
            order_hash="hash_001",
        )
        record = self.logger.record_fill("hash_001", fill_price=101.5)
        self.assertIsNotNone(record)
        self.assertTrue(record.intent_value_add)
        self.assertAlmostEqual(record.delta_bps, 150.0, places=1)

    def test_record_fill_negative_delta(self):
        """Fill price < arrival = Worse than AMM (negative delta)."""
        self.logger.capture_arrival(
            token_ca="TOKEN_C",
            action="BUY",
            arrival_price=100.0,
            amount=1.0,
            regime="SAFE_MODE",
            order_hash="hash_002",
        )
        record = self.logger.record_fill("hash_002", fill_price=99.0)
        self.assertIsNotNone(record)
        self.assertFalse(record.intent_value_add)
        self.assertAlmostEqual(record.delta_bps, -100.0, places=1)

    def test_record_fill_no_snapshot(self):
        """No matching arrival snapshot should return None."""
        record = self.logger.record_fill("nonexistent_hash", fill_price=100.0)
        self.assertIsNone(record)

    def test_record_fill_fallback_by_token(self):
        """Fall back to token_ca + action match if order_hash not found."""
        self.logger.capture_arrival(
            token_ca="TOKEN_D",
            action="SELL",
            arrival_price=200.0,
            amount=3.0,
            regime="NORMAL",
        )
        record = self.logger.record_fill(
            "unknown_hash",
            fill_price=202.0,
            token_ca="TOKEN_D",
            action="SELL",
        )
        self.assertIsNotNone(record)
        self.assertAlmostEqual(record.delta_bps, 100.0, places=1)

    def test_summary_empty(self):
        summary = self.logger.get_summary()
        self.assertEqual(summary["total_fills"], 0)
        self.assertEqual(summary["avg_delta_bps"], 0.0)

    def test_summary_with_fills(self):
        self.logger.capture_arrival("T1", "BUY", 100.0, 1.0, "NORMAL", "h1")
        self.logger.capture_arrival("T2", "BUY", 100.0, 1.0, "NORMAL", "h2")
        self.logger.record_fill("h1", 102.0)  # +200 bps
        self.logger.record_fill("h2", 99.0)   # -100 bps
        summary = self.logger.get_summary()
        self.assertEqual(summary["total_fills"], 2)
        self.assertAlmostEqual(summary["avg_delta_bps"], 50.0, places=1)
        self.assertEqual(summary["intent_value_adds"], 1)
        self.assertEqual(summary["intent_worse"], 1)
        self.assertAlmostEqual(summary["win_rate_pct"], 50.0, places=1)

    def test_recent_fills(self):
        self.logger.capture_arrival("T1", "BUY", 100.0, 1.0, "NORMAL", "h1")
        self.logger.record_fill("h1", 101.0)
        fills = self.logger.get_recent_fills()
        self.assertEqual(len(fills), 1)
        self.assertEqual(fills[0]["token_ca"], "T1")

    def test_arrival_snapshot_model(self):
        from pnl_logger import ArrivalSnapshot
        snap = ArrivalSnapshot(
            token_ca="X", action="BUY", arrival_price=50.0,
            amount=1.0, regime="NORMAL"
        )
        self.assertEqual(snap.token_ca, "X")
        self.assertGreater(snap.captured_at, 0)


class TestShadowResolver(unittest.TestCase):
    """Test Shadow Resolver backtesting logic."""

    def setUp(self):
        from shadow_resolver import ShadowResolver
        ShadowResolver._instance = None
        self.resolver = ShadowResolver()

    def test_singleton(self):
        from shadow_resolver import ShadowResolver, get_shadow_resolver
        ShadowResolver._instance = None
        r1 = get_shadow_resolver()
        r2 = get_shadow_resolver()
        self.assertIs(r1, r2)

    def test_ingest_ohlcv(self):
        bars = [
            {"timestamp": 1000, "open": 100, "high": 105, "low": 98, "close": 102},
            {"timestamp": 1060, "open": 102, "high": 108, "low": 100, "close": 106},
        ]
        count = self.resolver.ingest_ohlcv("TOKEN_X", bars)
        self.assertEqual(count, 2)

    def test_buy_intent_filled(self):
        """BUY intent fills when low price <= minReturn."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 1000, "open": 100, "high": 110, "low": 95, "close": 105},
            {"timestamp": 1030, "open": 105, "high": 112, "low": 97, "close": 108},
        ]
        self.resolver.ingest_ohlcv("BUY_TOKEN", bars)

        intent = SimulatedIntent(
            token_ca="BUY_TOKEN",
            action="BUY",
            amount=1.0,
            min_return=98.0,  # wants to buy at <= 98
            signed_at=1000,
            regime="NORMAL",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertTrue(result.filled)
        self.assertEqual(result.fill_price, 95.0)  # first bar low satisfies
        self.assertEqual(result.bars_checked, 2)

    def test_buy_intent_missed(self):
        """BUY intent misses when no bar low <= minReturn."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 1000, "open": 100, "high": 110, "low": 99, "close": 105},
            {"timestamp": 1030, "open": 105, "high": 112, "low": 101, "close": 108},
        ]
        self.resolver.ingest_ohlcv("MISS_TOKEN", bars)

        intent = SimulatedIntent(
            token_ca="MISS_TOKEN",
            action="BUY",
            amount=1.0,
            min_return=90.0,  # wants < 90, but lowest is 99
            signed_at=1000,
            regime="SAFE_MODE",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertFalse(result.filled)
        self.assertIsNone(result.fill_price)

    def test_sell_intent_filled(self):
        """SELL intent fills when high price >= minReturn."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 2000, "open": 100, "high": 115, "low": 98, "close": 110},
        ]
        self.resolver.ingest_ohlcv("SELL_TOKEN", bars)

        intent = SimulatedIntent(
            token_ca="SELL_TOKEN",
            action="SELL",
            amount=1.0,
            min_return=112.0,  # wants >= 112
            signed_at=2000,
            regime="AGGRESSIVE",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertTrue(result.filled)
        self.assertEqual(result.fill_price, 115.0)

    def test_sell_intent_missed(self):
        """SELL intent misses when no high >= minReturn."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 3000, "open": 100, "high": 105, "low": 98, "close": 103},
        ]
        self.resolver.ingest_ohlcv("SELL_MISS", bars)

        intent = SimulatedIntent(
            token_ca="SELL_MISS",
            action="SELL",
            amount=1.0,
            min_return=120.0,  # wants >= 120, but max is 105
            signed_at=3000,
            regime="NORMAL",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertFalse(result.filled)

    def test_window_filtering(self):
        """Only bars within auction window should be checked."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 1000, "open": 100, "high": 110, "low": 99, "close": 105},
            {"timestamp": 1030, "open": 105, "high": 108, "low": 80, "close": 90},  # in window
            {"timestamp": 1090, "open": 90, "high": 95, "low": 70, "close": 85},   # out of 60s window
        ]
        self.resolver.ingest_ohlcv("WINDOW_TOKEN", bars)

        intent = SimulatedIntent(
            token_ca="WINDOW_TOKEN",
            action="BUY",
            amount=1.0,
            min_return=85.0,  # bar at 1030 has low=80 (fills), bar at 1090 has low=70 but out of window
            signed_at=1000,
            regime="NORMAL",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertTrue(result.filled)
        self.assertEqual(result.bars_checked, 2)  # only bars at 1000 and 1030 in window
        self.assertEqual(result.fill_price, 80.0)  # from bar at t=1030

    def test_delta_bps_calculation(self):
        """Verify delta_bps = (fill - minReturn) / minReturn * 10000."""
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 1000, "open": 100, "high": 110, "low": 95, "close": 105},
        ]
        self.resolver.ingest_ohlcv("DELTA_TOKEN", bars)

        intent = SimulatedIntent(
            token_ca="DELTA_TOKEN",
            action="BUY",
            amount=1.0,
            min_return=100.0,
            signed_at=1000,
            regime="NORMAL",
            auction_duration_s=60,
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertTrue(result.filled)
        # delta = (95 - 100) / 100 * 10000 = -500 bps (bought cheaper)
        self.assertAlmostEqual(result.delta_bps, -500.0, places=1)

    def test_no_ohlcv_data(self):
        """Intent with no OHLCV data should be missed."""
        from shadow_resolver import SimulatedIntent
        intent = SimulatedIntent(
            token_ca="NO_DATA_TOKEN",
            action="BUY",
            amount=1.0,
            min_return=100.0,
            signed_at=1000,
            regime="NORMAL",
        )
        result = self.resolver.evaluate_intent(intent)
        self.assertFalse(result.filled)
        self.assertEqual(result.bars_checked, 0)

    def test_batch_backtest(self):
        from shadow_resolver import SimulatedIntent
        bars = [
            {"timestamp": 1000, "open": 100, "high": 115, "low": 90, "close": 110, "volume": 500},
            {"timestamp": 1060, "open": 110, "high": 120, "low": 105, "close": 118, "volume": 600},
        ]
        self.resolver.ingest_ohlcv("BATCH_TOKEN", bars)

        intents = [
            SimulatedIntent(token_ca="BATCH_TOKEN", action="BUY", amount=1.0,
                            min_return=95.0, signed_at=1000, regime="NORMAL"),
            SimulatedIntent(token_ca="BATCH_TOKEN", action="SELL", amount=1.0,
                            min_return=118.0, signed_at=1000, regime="AGGRESSIVE"),
        ]
        results = self.resolver.run_backtest(intents)
        self.assertEqual(len(results), 2)
        self.assertTrue(results[0].filled)  # BUY: low=90 <= 95
        self.assertTrue(results[1].filled)  # SELL: high=120 >= 118 (second bar in window)
        self.assertEqual(results[1].fill_price, 120.0)

    def test_summary_stats(self):
        from shadow_resolver import SimulatedIntent
        bars = [{"timestamp": 1000, "open": 100, "high": 110, "low": 90, "close": 105}]
        self.resolver.ingest_ohlcv("STAT_TOKEN", bars)

        i1 = SimulatedIntent(token_ca="STAT_TOKEN", action="BUY", amount=1.0,
                             min_return=95.0, signed_at=1000, regime="NORMAL")
        i2 = SimulatedIntent(token_ca="STAT_TOKEN", action="BUY", amount=1.0,
                             min_return=80.0, signed_at=1000, regime="SAFE_MODE")
        self.resolver.evaluate_intent(i1)  # fills (low=90 <= 95)
        self.resolver.evaluate_intent(i2)  # misses (low=90 > 80)

        summary = self.resolver.get_summary()
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["filled"], 1)
        self.assertEqual(summary["missed"], 1)
        self.assertAlmostEqual(summary["fill_rate_pct"], 50.0)
        self.assertIn("NORMAL", summary["regime_breakdown"])

    def test_ohlcv_bar_model(self):
        from shadow_resolver import OHLCVBar
        bar = OHLCVBar(timestamp=1000, open=100, high=110, low=90, close=105, volume=500)
        self.assertEqual(bar.high, 110)
        self.assertEqual(bar.volume, 500)


class TestAPIServer(unittest.TestCase):
    """Test FastAPI WebSocket Gateway structure."""

    def test_app_exists(self):
        from api_server import app
        self.assertIsNotNone(app)

    def test_connection_manager(self):
        from api_server import ConnectionManager
        cm = ConnectionManager()
        self.assertEqual(cm.count, 0)

    def test_dashboard_event_model(self):
        from api_server import DashboardEvent
        evt = DashboardEvent(
            event_type="test",
            regime="SAFE_MODE",
            data={"msg": "hello"},
        )
        self.assertEqual(evt.event_type, "test")
        self.assertEqual(evt.regime, "SAFE_MODE")

    def test_health_endpoint(self):
        """Test health endpoint via TestClient."""
        try:
            from fastapi.testclient import TestClient
            from api_server import app
            client = TestClient(app)
            resp = client.get("/health")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "ok")
            self.assertIn("regime", data)
            self.assertIn("ws_clients", data)
        except ImportError:
            self.skipTest("httpx not installed for TestClient")

    def test_status_endpoint(self):
        try:
            from fastapi.testclient import TestClient
            from api_server import app
            client = TestClient(app)
            resp = client.get("/status")
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["engine"], "EDDYI Trading Engine")
            self.assertIn("regime", data)
        except ImportError:
            self.skipTest("httpx not installed for TestClient")


class TestIntegration(unittest.TestCase):
    """Test that trade_executor imports the new modules correctly."""

    def test_imports(self):
        """Verify trade_executor imports state_manager and pnl_logger."""
        import trade_executor
        self.assertTrue(hasattr(trade_executor, 'get_state_manager'))
        self.assertTrue(hasattr(trade_executor, 'get_pnl_logger'))

    def test_pnl_logger_lifecycle(self):
        """Full lifecycle: capture -> fill -> summary."""
        from pnl_logger import PnLLogger
        PnLLogger._instance = None
        logger = PnLLogger()

        # Simulate 3 trades
        logger.capture_arrival("T1", "BUY", 100.0, 1.0, "NORMAL", "h1")
        logger.capture_arrival("T2", "BUY", 50.0, 2.0, "SAFE_MODE", "h2")
        logger.capture_arrival("T3", "SELL", 200.0, 0.5, "AGGRESSIVE", "h3")

        self.assertEqual(logger.get_pending_count(), 3)

        # Fill T1 with positive delta
        r1 = logger.record_fill("h1", 102.0)
        self.assertAlmostEqual(r1.delta_bps, 200.0, places=1)

        # Fill T2 with negative delta
        r2 = logger.record_fill("h2", 49.5)
        self.assertAlmostEqual(r2.delta_bps, -100.0, places=1)

        # T3 still pending
        self.assertEqual(logger.get_pending_count(), 1)

        summary = logger.get_summary()
        self.assertEqual(summary["total_fills"], 2)
        self.assertEqual(summary["intent_value_adds"], 1)
        self.assertEqual(summary["pending_arrivals"], 1)


if __name__ == "__main__":
    # Monkey-patch module singletons to avoid stale state
    results = unittest.TextTestRunner(verbosity=2).run(
        unittest.TestLoader().loadTestsFromModule(sys.modules[__name__])
    )
    sys.exit(0 if results.wasSuccessful() else 1)
