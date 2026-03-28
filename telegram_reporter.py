# telegram_reporter.py — Daily PnL Summary via Telegram
#
# Sends an evening summary of execution quality, regime, and survival status.
# Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.

import asyncio
import os
import time
from typing import Optional

import requests

from pnl_logger import get_pnl_logger
from dynamic_tuner import get_tuner
from sentinel import get_sentinel
from auto_graduation import get_graduation_monitor

TELEGRAM_BOT_TOKEN = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
TELEGRAM_CHAT_ID = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
REPORT_HOUR_UTC = int(os.getenv("REPORT_HOUR_UTC", 21))  # 9 PM UTC default


def _send_telegram(text: str) -> bool:
    """Send a message via Telegram Bot API. Returns True on success."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return False
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT_ID, "text": text},
            timeout=10,
        )
        return resp.status_code == 200
    except requests.RequestException:
        return False


def build_daily_report() -> str:
    """Build the daily PnL summary message."""
    summary = get_pnl_logger().get_summary()
    quality = summary.get("avg_improvement_bps", 0)
    regime = get_tuner().get_regime()
    sentinel = get_sentinel()
    grad = get_graduation_monitor().get_status()

    if quality > 5:
        mood = "\U0001f680"  # rocket
    elif quality > 0:
        mood = "\u2696\ufe0f"  # balance scale
    else:
        mood = "\u26a0\ufe0f"  # warning

    return (
        f"EDDYI v3.1 Daily Report {mood}\n"
        f"--------------------------\n"
        f"Regime: {regime}\n"
        f"Total Trades: {summary.get('count', 0)}\n"
        f"Execution Quality: {quality:.2f} bps\n"
        f"Win Rate: {summary.get('win_rate_pct', 0):.1f}%\n"
        f"Graduation: {grad.get('verdict', 'PENDING')}\n"
        f"Survival Halt: {'ACTIVE' if sentinel.is_triggered else 'Clear'}\n"
        f"Time: {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}"
    )


async def daily_report_loop():
    """
    Async loop that sends a Telegram summary once per day at REPORT_HOUR_UTC.
    Designed to run alongside signal_listener and health_check_loop in asyncio.gather.
    """
    sent_today: Optional[str] = None  # tracks the date string we already sent for

    while True:
        now = time.gmtime()
        today = time.strftime("%Y-%m-%d", now)

        if now.tm_hour >= REPORT_HOUR_UTC and sent_today != today:
            report = build_daily_report()
            ok = _send_telegram(report)
            if ok:
                print(f"[TELEGRAM] Daily report sent for {today}")
            else:
                print(f"[TELEGRAM] Daily report failed (token/chat_id configured? {bool(TELEGRAM_BOT_TOKEN)})")
            sent_today = today

        await asyncio.sleep(300)  # check every 5 minutes
