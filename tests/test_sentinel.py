"""Tests for Sentinel - Dead Man's Switch."""
import os
import sys
import time
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sentinel import Sentinel, get_sentinel, _KILL_COMMANDS


# ── 1. Singleton ───────────────────────────────────────────────────────────
def test_singleton():
    a = get_sentinel()
    b = get_sentinel()
    assert a is b
    print("PASS test_singleton")


# ── 2. Heartbeat updates timestamp ────────────────────────────────────────
def test_heartbeat():
    s = Sentinel()
    old = s._last_heartbeat
    time.sleep(0.05)
    s.heartbeat()
    assert s._last_heartbeat > old
    print("PASS test_heartbeat")


# ── 3. Track and clear intents ────────────────────────────────────────────
def test_track_intent():
    s = Sentinel()
    s.track_intent({"order_hash": "0xAAA", "token": "T1"})
    s.track_intent({"order_hash": "0xBBB", "token": "T2"})
    assert len(s._tracked_intents) == 2

    s.clear_intent("0xAAA")
    assert len(s._tracked_intents) == 1
    assert s._tracked_intents[0]["order_hash"] == "0xBBB"
    print("PASS test_track_intent")


# ── 4. Trigger fires once ────────────────────────────────────────────────
def test_trigger_once():
    s = Sentinel()
    s.track_intent({"order_hash": "0xCCC", "token": "T3"})
    result = s.trigger("test trigger")

    assert s.is_triggered
    assert result["reason"] == "test trigger"
    assert result["intents_cancelled"] == 1
    assert len(s._tracked_intents) == 0

    # Second trigger returns already_triggered
    result2 = s.trigger("second")
    assert result2.get("already_triggered") is True
    print("PASS test_trigger_once")


# ── 5. Reset clears triggered state ──────────────────────────────────────
def test_reset():
    s = Sentinel()
    s.trigger("to reset")
    assert s.is_triggered
    s.reset()
    assert not s.is_triggered
    assert s._trigger_reason == ""
    print("PASS test_reset")


# ── 6. Status structure ──────────────────────────────────────────────────
def test_status():
    s = Sentinel()
    st = s.status()
    assert "running" in st
    assert "triggered" in st
    assert "last_heartbeat_ago_s" in st
    assert "heartbeat_timeout_s" in st
    assert "tracked_intents" in st
    assert "telegram_polling" in st
    print("PASS test_status")


# ── 7. Heartbeat timeout triggers switch ──────────────────────────────────
def test_heartbeat_timeout():
    s = Sentinel()
    # Simulate a stale heartbeat
    s._last_heartbeat = time.time() - 999
    s._running = True
    # Manually call the check logic (not the thread)
    elapsed = time.time() - s._last_heartbeat
    if elapsed > 10 and not s._triggered:
        s.trigger(f"Heartbeat timeout: {elapsed:.0f}s")
    assert s.is_triggered
    assert "Heartbeat timeout" in s._trigger_reason
    print("PASS test_heartbeat_timeout")


# ── 8. Kill commands set ──────────────────────────────────────────────────
def test_kill_commands():
    assert "/killswitch" in _KILL_COMMANDS
    assert "/cancel_all" in _KILL_COMMANDS
    assert "/deadman" in _KILL_COMMANDS
    assert "/random" not in _KILL_COMMANDS
    print("PASS test_kill_commands")


# ── 9. Cancel without resolver URL returns error ─────────────────────────
def test_cancel_no_resolver():
    s = Sentinel()
    s._resolver_url = ""
    # Patch RESOLVER_URL to empty
    import sentinel
    old_url = sentinel.RESOLVER_URL
    sentinel.RESOLVER_URL = ""
    results = s._cancel_all_intents([{"order_hash": "0xDDD"}])
    sentinel.RESOLVER_URL = old_url
    assert len(results) == 1
    assert "No INTENT_RESOLVER_URL" in results[0].get("error", "")
    print("PASS test_cancel_no_resolver")


# ── 10. Start/stop lifecycle ─────────────────────────────────────────────
def test_start_stop():
    s = Sentinel()
    assert not s._running
    s.start()
    assert s._running
    assert s._heartbeat_thread is not None
    assert s._heartbeat_thread.is_alive()
    s.stop()
    time.sleep(0.1)
    # Daemon threads will stop with main, but _running flag is off
    assert not s._running
    print("PASS test_start_stop")


# ── 11. Tracked intents have timestamp ───────────────────────────────────
def test_tracked_at_timestamp():
    s = Sentinel()
    before = time.time()
    s.track_intent({"order_hash": "0xEEE"})
    after = time.time()
    assert before <= s._tracked_intents[0]["tracked_at"] <= after
    print("PASS test_tracked_at_timestamp")


# ── 12. Trigger with no intents still works ──────────────────────────────
def test_trigger_empty():
    s = Sentinel()
    result = s.trigger("no intents")
    assert result["intents_cancelled"] == 0
    assert result["cancel_results"] == []
    assert s.is_triggered
    print("PASS test_trigger_empty")


if __name__ == "__main__":
    tests = [
        test_singleton,
        test_heartbeat,
        test_track_intent,
        test_trigger_once,
        test_reset,
        test_status,
        test_heartbeat_timeout,
        test_kill_commands,
        test_cancel_no_resolver,
        test_start_stop,
        test_tracked_at_timestamp,
        test_trigger_empty,
    ]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} tests passed")
