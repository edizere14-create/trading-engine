# sentinel.py - Dead Man's Switch for Intent Cancellation
#
# Two independent triggers:
#   1. HEARTBEAT TIMEOUT  - Main bot must call sentinel.heartbeat() every N seconds.
#                           If the heartbeat goes stale, all open intents are cancelled.
#   2. TELEGRAM COMMAND   - Sending /killswitch to the bot triggers immediate cancellation.
#
# On activation the sentinel will:
#   - POST cancel requests to the solver network for every tracked intent
#   - Activate trade_executor's runtime kill-switch (blocks all new trades)
#   - Send a Telegram alert with the cancellation summary
#   - Write a sentinel_event.json audit log

import asyncio
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

# ── Config ──────────────────────────────────────────────────────────────────
HEARTBEAT_TIMEOUT = int(os.getenv("SENTINEL_HEARTBEAT_TIMEOUT", 120))  # seconds
SENTINEL_POLL_INTERVAL = int(os.getenv("SENTINEL_POLL_INTERVAL", 5))   # Telegram poll
SENTINEL_LOG_FILE = Path(os.getenv("SENTINEL_LOG_FILE", "data/sentinel_events.json"))
TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TELEGRAM_CHAT_ID = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
RESOLVER_URL = (os.getenv("INTENT_RESOLVER_URL") or "").strip()
INTENT_API_KEY = (os.getenv("INTENT_API_KEY") or "").strip()

# Telegram commands that trigger the kill-switch
_KILL_COMMANDS = frozenset({"/killswitch", "/cancel_all", "/deadman"})


class Sentinel:
    """
    Dead Man's Switch — monitors bot health and Telegram commands.
    Cancels all open intents and activates kill-switch on failure.
    """

    _instance: Optional["Sentinel"] = None

    def __init__(self) -> None:
        self._last_heartbeat: float = time.time()
        self._tracked_intents: List[Dict[str, Any]] = []
        self._lock = threading.Lock()
        self._triggered = False
        self._trigger_reason = ""
        self._heartbeat_thread: Optional[threading.Thread] = None
        self._telegram_thread: Optional[threading.Thread] = None
        self._running = False
        self._telegram_offset: int = 0

    # ── Singleton ───────────────────────────────────────────────────────
    @classmethod
    def get_instance(cls) -> "Sentinel":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Heartbeat API (called by main bot) ──────────────────────────────
    def heartbeat(self) -> None:
        """Reset the dead man's timer. Call this from the main loop."""
        self._last_heartbeat = time.time()

    def track_intent(self, intent: Dict[str, Any]) -> None:
        """Register an intent so sentinel can cancel it if needed."""
        with self._lock:
            self._tracked_intents.append({
                **intent,
                "tracked_at": time.time(),
            })

    def clear_intent(self, order_hash: str) -> None:
        """Remove a filled/expired intent from tracking."""
        with self._lock:
            self._tracked_intents = [
                i for i in self._tracked_intents
                if i.get("order_hash") != order_hash
            ]

    # ── Start / Stop ────────────────────────────────────────────────────
    def start(self) -> None:
        """Launch heartbeat monitor and Telegram listener as daemon threads."""
        if self._running:
            return
        self._running = True
        self._last_heartbeat = time.time()

        self._heartbeat_thread = threading.Thread(
            target=self._heartbeat_loop, name="sentinel-heartbeat", daemon=True
        )
        self._heartbeat_thread.start()

        if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID:
            self._telegram_thread = threading.Thread(
                target=self._telegram_poll_loop, name="sentinel-telegram", daemon=True
            )
            self._telegram_thread.start()

        print(
            f"[SENTINEL] Started: heartbeat_timeout={HEARTBEAT_TIMEOUT}s, "
            f"telegram={'ON' if self._telegram_thread else 'OFF'}"
        )

    def stop(self) -> None:
        """Signal threads to stop."""
        self._running = False

    # ── Core: Trigger the Dead Man's Switch ─────────────────────────────
    def trigger(self, reason: str) -> Dict[str, Any]:
        """
        Fire the dead man's switch.
        Cancels all tracked intents and activates the kill-switch.
        Returns a summary dict.
        """
        with self._lock:
            if self._triggered:
                return {"already_triggered": True, "reason": self._trigger_reason}

            self._triggered = True
            self._trigger_reason = reason
            intents_to_cancel = list(self._tracked_intents)
            self._tracked_intents.clear()

        print(f"[SENTINEL] DEAD MAN'S SWITCH ACTIVATED: {reason}")

        # 1. Cancel intents on the solver network
        cancel_results = self._cancel_all_intents(intents_to_cancel)

        # 2. Activate trade_executor kill-switch
        kill_switch_ok = self._activate_kill_switch(reason)

        # 3. Build summary
        summary = {
            "triggered_at": time.time(),
            "reason": reason,
            "intents_cancelled": len(intents_to_cancel),
            "cancel_results": cancel_results,
            "kill_switch_activated": kill_switch_ok,
        }

        # 4. Audit log
        self._write_event_log(summary)

        # 5. Telegram alert
        self._send_alert(summary)

        return summary

    @property
    def is_triggered(self) -> bool:
        return self._triggered

    def reset(self) -> None:
        """Reset after manual intervention. Does NOT re-enable trading."""
        with self._lock:
            self._triggered = False
            self._trigger_reason = ""
            self._last_heartbeat = time.time()

    def status(self) -> Dict[str, Any]:
        """Return sentinel health overview."""
        now = time.time()
        return {
            "running": self._running,
            "triggered": self._triggered,
            "trigger_reason": self._trigger_reason or None,
            "last_heartbeat_ago_s": round(now - self._last_heartbeat, 1),
            "heartbeat_timeout_s": HEARTBEAT_TIMEOUT,
            "tracked_intents": len(self._tracked_intents),
            "telegram_polling": self._telegram_thread is not None and self._telegram_thread.is_alive(),
        }

    # ── Internal: Heartbeat Monitor ─────────────────────────────────────
    def _heartbeat_loop(self) -> None:
        while self._running:
            elapsed = time.time() - self._last_heartbeat
            if elapsed > HEARTBEAT_TIMEOUT and not self._triggered:
                self.trigger(
                    f"Heartbeat timeout: no heartbeat for {elapsed:.0f}s "
                    f"(limit {HEARTBEAT_TIMEOUT}s) - bot likely crashed"
                )
            time.sleep(SENTINEL_POLL_INTERVAL)

    # ── Internal: Telegram Polling ──────────────────────────────────────
    def _telegram_poll_loop(self) -> None:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/getUpdates"
        while self._running:
            try:
                resp = requests.get(
                    url,
                    params={
                        "offset": self._telegram_offset,
                        "timeout": SENTINEL_POLL_INTERVAL,
                        "allowed_updates": json.dumps(["message"]),
                    },
                    timeout=SENTINEL_POLL_INTERVAL + 5,
                )
                if resp.status_code != 200:
                    time.sleep(SENTINEL_POLL_INTERVAL)
                    continue

                data = resp.json()
                for update in data.get("result", []):
                    self._telegram_offset = update["update_id"] + 1
                    msg = update.get("message", {})
                    chat_id = str(msg.get("chat", {}).get("id", ""))
                    text = (msg.get("text") or "").strip().lower()

                    # Only accept commands from the authorized chat
                    if chat_id != TELEGRAM_CHAT_ID:
                        continue

                    if text in _KILL_COMMANDS and not self._triggered:
                        self.trigger(f"Telegram command: {text} from chat {chat_id}")

            except requests.RequestException:
                time.sleep(SENTINEL_POLL_INTERVAL)

    # ── Internal: Cancel Intents on Solver ──────────────────────────────
    def _cancel_all_intents(self, intents: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not intents:
            return []
        if not RESOLVER_URL:
            return [{"error": "No INTENT_RESOLVER_URL configured", "skipped": len(intents)}]

        results = []
        cancel_url = f"{RESOLVER_URL}/cancel"
        headers = {
            "Content-Type": "application/json",
            "X-Api-Key": INTENT_API_KEY,
        }

        for intent in intents:
            order_hash = intent.get("order_hash", intent.get("eip712_signature", "unknown"))
            try:
                resp = requests.post(
                    cancel_url,
                    json={"orderHash": order_hash, "reason": "DEAD_MANS_SWITCH"},
                    headers=headers,
                    timeout=10,
                )
                results.append({
                    "order_hash": order_hash,
                    "status": resp.status_code,
                    "ok": resp.status_code in (200, 201, 204),
                })
            except requests.RequestException as exc:
                results.append({
                    "order_hash": order_hash,
                    "ok": False,
                    "error": str(exc) or type(exc).__name__,
                })
        return results

    # ── Internal: Activate Kill Switch ──────────────────────────────────
    def _activate_kill_switch(self, reason: str) -> bool:
        try:
            from trade_executor import _activate_runtime_kill_switch
            _activate_runtime_kill_switch(f"SENTINEL: {reason}")
            return True
        except Exception as exc:
            print(f"[SENTINEL] Failed to activate kill-switch: {exc}")
            return False

    # ── Internal: Audit Log ─────────────────────────────────────────────
    def _write_event_log(self, event: Dict[str, Any]) -> None:
        try:
            SENTINEL_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            existing: List[Dict[str, Any]] = []
            if SENTINEL_LOG_FILE.exists():
                try:
                    existing = json.loads(SENTINEL_LOG_FILE.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    existing = []
            existing.append(event)
            SENTINEL_LOG_FILE.write_text(
                json.dumps(existing, indent=2), encoding="utf-8"
            )
        except Exception as exc:
            print(f"[SENTINEL] Failed to write event log: {exc}")

    # ── Internal: Telegram Alert ────────────────────────────────────────
    def _send_alert(self, summary: Dict[str, Any]) -> None:
        if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
            return
        msg = (
            "[SENTINEL] DEAD MAN'S SWITCH ACTIVATED\n"
            f"Reason: {summary['reason']}\n"
            f"Intents cancelled: {summary['intents_cancelled']}\n"
            f"Kill-switch: {'ON' if summary['kill_switch_activated'] else 'FAILED'}\n"
            f"Time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(summary['triggered_at']))}"
        )
        try:
            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": msg},
                timeout=10,
            )
        except requests.RequestException:
            pass


# ── Module-level singleton ──────────────────────────────────────────────────
def get_sentinel() -> Sentinel:
    return Sentinel.get_instance()
