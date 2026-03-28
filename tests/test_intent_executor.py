"""Tests for IntentExecutor — Dutch Auction presets and intent creation."""
import os
import sys
import time

# Ensure project root is on the path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dynamic_tuner import MarketRegime
from intent_executor import IntentExecutor, get_executor, _PRESETS


# ── 1. Singleton accessor ──────────────────────────────────────────────────
def test_singleton():
    a = get_executor()
    b = get_executor()
    assert a is b, "get_executor() should return the same instance"
    print("PASS test_singleton")


# ── 2. SAFE_MODE preset (fast / 30s / 98%) ─────────────────────────────────
def test_safe_mode_preset():
    ex = get_executor()
    p = ex.get_intent_params(MarketRegime.SAFE_MODE)
    assert p["preset"] == "fast"
    assert p["auction_duration_s"] == 30
    assert p["min_return_pct"] == 98.0
    assert p["label"] == "PANIC SELL/SHIELD"
    print("PASS test_safe_mode_preset")


# ── 3. AGGRESSIVE preset (auction / 180s / 99.5%) ──────────────────────────
def test_aggressive_preset():
    ex = get_executor()
    p = ex.get_intent_params(MarketRegime.AGGRESSIVE)
    assert p["preset"] == "auction"
    assert p["auction_duration_s"] == 180
    assert p["min_return_pct"] == 99.5
    assert p["label"] == "MOON MISSION"
    print("PASS test_aggressive_preset")


# ── 4. NORMAL preset (fair / 60s / 99%) ────────────────────────────────────
def test_normal_preset():
    ex = get_executor()
    p = ex.get_intent_params(MarketRegime.NORMAL)
    assert p["preset"] == "fair"
    assert p["auction_duration_s"] == 60
    assert p["min_return_pct"] == 99.0
    assert p["label"] == "STANDARD"
    print("PASS test_normal_preset")


# ── 5. Unknown regime falls back to NORMAL ──────────────────────────────────
def test_unknown_regime_fallback():
    ex = get_executor()
    p = ex.get_intent_params("UNKNOWN_REGIME")
    assert p == ex.get_intent_params(MarketRegime.NORMAL)
    print("PASS test_unknown_regime_fallback")


# ── 6. create_onchain_intent — structure and fields ─────────────────────────
def test_create_onchain_intent_fields():
    ex = get_executor()
    intent = ex.create_onchain_intent(
        token_ca="0xABC",
        action="BUY",
        amount=1.5,
        expected_output=1000.0,
        regime=MarketRegime.SAFE_MODE,
    )
    assert intent["token"] == "0xABC"
    assert intent["action"] == "BUY"
    assert intent["amount"] == 1.5
    assert intent["min_return"] == 1000.0 * 0.98  # 98%
    assert intent["auction_preset"] == "fast"
    assert intent["auction_duration_s"] == 30
    assert intent["regime"] == MarketRegime.SAFE_MODE
    assert intent["label"] == "PANIC SELL/SHIELD"
    assert "deadline" in intent
    assert "created_at" in intent
    # No signed data supplied
    assert "eip712_signature" not in intent
    print("PASS test_create_onchain_intent_fields")


# ── 7. create_onchain_intent — with signed data ────────────────────────────
def test_create_onchain_intent_with_signature():
    ex = get_executor()
    signed = {"ok": True, "signature": "0xDEAD", "message": {"nonce": 1}}
    intent = ex.create_onchain_intent(
        token_ca="0xABC",
        action="BUY",
        amount=2.0,
        expected_output=500.0,
        regime=MarketRegime.AGGRESSIVE,
        signed_intent=signed,
    )
    assert intent["eip712_signature"] == "0xDEAD"
    assert intent["eip712_message"] == {"nonce": 1}
    assert intent["min_return"] == 500.0 * 0.995  # 99.5%
    assert intent["auction_preset"] == "auction"
    print("PASS test_create_onchain_intent_with_signature")


# ── 8. broadcast without resolver URL returns error ─────────────────────────
def test_broadcast_no_url():
    ex = IntentExecutor()
    ex._resolver_url = ""
    intent = {"token": "0xABC", "action": "BUY"}
    result = ex.broadcast_intent_to_resolver(intent)
    assert result["ok"] is False
    assert "not configured" in result["error"]
    print("PASS test_broadcast_no_url")


# ── 9. min_return calculation per regime ────────────────────────────────────
def test_min_return_per_regime():
    ex = get_executor()
    expected = 1000.0
    for regime, pct in [
        (MarketRegime.SAFE_MODE, 98.0),
        (MarketRegime.NORMAL, 99.0),
        (MarketRegime.AGGRESSIVE, 99.5),
    ]:
        intent = ex.create_onchain_intent("T", "BUY", 1.0, expected, regime)
        assert abs(intent["min_return"] - expected * (pct / 100.0)) < 0.01, f"Failed for {regime}"
    print("PASS test_min_return_per_regime")


# ── 10. status structure ───────────────────────────────────────────────────
def test_status():
    ex = get_executor()
    s = ex.status()
    assert "resolver_url_set" in s
    assert "broadcast_timeout" in s
    assert "arb_key_configured" in s
    assert "presets" in s
    assert len(s["presets"]) == 3
    print("PASS test_status")


if __name__ == "__main__":
    tests = [
        test_singleton,
        test_safe_mode_preset,
        test_aggressive_preset,
        test_normal_preset,
        test_unknown_regime_fallback,
        test_create_onchain_intent_fields,
        test_create_onchain_intent_with_signature,
        test_broadcast_no_url,
        test_min_return_per_regime,
        test_status,
    ]
    passed = 0
    for t in tests:
        try:
            t()
            passed += 1
        except Exception as e:
            print(f"FAIL {t.__name__}: {e}")
    print(f"\n{passed}/{len(tests)} tests passed")
