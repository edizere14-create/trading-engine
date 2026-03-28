# auto_graduation.py — The "Prove It" Logic
#
# Monitors paper trade performance and graduates the engine from PAPER → LIVE
# only when provable edge is demonstrated. No manual key-flipping allowed.
#
# Requirements for graduation:
#   1. MIN_PAPER_TRADES completed with new signal quality gates
#   2. Profit Factor >= REQUIRED_PROFIT_FACTOR (gross_wins / gross_losses)
#   3. Max drawdown from peak < MAX_DRAWDOWN_ALLOWED (% of capital)
#   4. Win rate above minimum threshold
#
# On graduation:
#   - Writes data/graduation.json with timestamp + proof metrics
#   - Broadcasts GRADUATION event to dashboard via Redis
#   - The TS engine reads graduation.json on next startup to unlock live mode
#   - ARB_PRIVATE_KEY is NEVER touched at runtime (security)

import asyncio
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("AutoGraduation")

# ── Config ──────────────────────────────────────────────────────────────────
MIN_PAPER_TRADES = int(os.getenv("GRAD_MIN_TRADES", 10))
REQUIRED_PROFIT_FACTOR = float(os.getenv("GRAD_PROFIT_FACTOR", 1.5))
MAX_DRAWDOWN_ALLOWED = float(os.getenv("GRAD_MAX_DRAWDOWN", 0.05))  # 5% of capital
MIN_WIN_RATE = float(os.getenv("GRAD_MIN_WIN_RATE", 0.35))  # At least 35% wins
INITIAL_CAPITAL = float(os.getenv("INITIAL_CAPITAL_USD", 1000))
CHECK_INTERVAL = int(os.getenv("GRAD_CHECK_INTERVAL", 120))  # seconds

PAPER_TRADES_FILE = os.getenv("PAPER_TRADES_FILE", "data/paperTrades.json")
GRADUATION_FILE = os.getenv("GRADUATION_FILE", "data/graduation.json")


# ── Graduation Status ──────────────────────────────────────────────────────

class GraduationStatus:
    """Immutable result of a graduation check."""

    __slots__ = (
        "verdict", "reason", "total_trades", "wins", "losses",
        "win_rate", "profit_factor", "total_pnl_usd", "max_drawdown_pct",
        "gross_profit", "gross_loss", "checked_at",
    )

    def __init__(
        self,
        verdict: str,
        reason: str,
        total_trades: int = 0,
        wins: int = 0,
        losses: int = 0,
        win_rate: float = 0.0,
        profit_factor: float = 0.0,
        total_pnl_usd: float = 0.0,
        max_drawdown_pct: float = 0.0,
        gross_profit: float = 0.0,
        gross_loss: float = 0.0,
    ) -> None:
        self.verdict = verdict
        self.reason = reason
        self.total_trades = total_trades
        self.wins = wins
        self.losses = losses
        self.win_rate = win_rate
        self.profit_factor = profit_factor
        self.total_pnl_usd = total_pnl_usd
        self.max_drawdown_pct = max_drawdown_pct
        self.gross_profit = gross_profit
        self.gross_loss = gross_loss
        self.checked_at = time.time()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "verdict": self.verdict,
            "reason": self.reason,
            "total_trades": self.total_trades,
            "wins": self.wins,
            "losses": self.losses,
            "win_rate": round(self.win_rate, 4),
            "profit_factor": round(self.profit_factor, 4),
            "total_pnl_usd": round(self.total_pnl_usd, 4),
            "max_drawdown_pct": round(self.max_drawdown_pct, 4),
            "gross_profit": round(self.gross_profit, 4),
            "gross_loss": round(self.gross_loss, 4),
            "checked_at": self.checked_at,
        }


# ── Core Graduation Logic ──────────────────────────────────────────────────

def load_paper_trades(filepath: str = PAPER_TRADES_FILE) -> List[Dict[str, Any]]:
    """Load paper trades from the JSON journal."""
    path = Path(filepath)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            trades = json.load(f)
        return [t for t in trades if t.get("mode") == "PAPER" and t.get("outcome")]
    except (json.JSONDecodeError, IOError) as exc:
        logger.warning("Failed to load paper trades: %s", exc)
        return []


def check_graduation(trades: Optional[List[Dict[str, Any]]] = None) -> GraduationStatus:
    """
    Evaluate paper trade performance against graduation thresholds.

    Returns GraduationStatus with verdict = "ACTIVE" or "PASSIVE".
    """
    if trades is None:
        trades = load_paper_trades()

    if len(trades) < MIN_PAPER_TRADES:
        remaining = MIN_PAPER_TRADES - len(trades)
        return GraduationStatus(
            verdict="PASSIVE",
            reason=f"Need {remaining} more paper trades ({len(trades)}/{MIN_PAPER_TRADES})",
            total_trades=len(trades),
        )

    # Separate wins and losses
    wins = [t for t in trades if t.get("outcome") == "WIN"]
    losses = [t for t in trades if t.get("outcome") == "LOSS"]

    gross_profit = sum(t.get("realizedPnLUSD", 0) for t in wins)
    gross_loss = abs(sum(t.get("realizedPnLUSD", 0) for t in losses))

    win_rate = len(wins) / len(trades) if trades else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else gross_profit
    total_pnl = gross_profit - gross_loss

    # Max drawdown: walk the equity curve
    peak = 0.0
    equity = 0.0
    max_dd = 0.0
    for t in trades:
        equity += t.get("realizedPnLUSD", 0)
        if equity > peak:
            peak = equity
        dd = (peak - equity) / INITIAL_CAPITAL if INITIAL_CAPITAL > 0 else 0
        if dd > max_dd:
            max_dd = dd

    # Build common kwargs
    stats = dict(
        total_trades=len(trades),
        wins=len(wins),
        losses=len(losses),
        win_rate=win_rate,
        profit_factor=profit_factor,
        total_pnl_usd=total_pnl,
        max_drawdown_pct=max_dd,
        gross_profit=gross_profit,
        gross_loss=gross_loss,
    )

    # Gate 1: Win rate
    if win_rate < MIN_WIN_RATE:
        return GraduationStatus(
            verdict="PASSIVE",
            reason=f"Win rate {win_rate:.1%} below {MIN_WIN_RATE:.0%} minimum",
            **stats,
        )

    # Gate 2: Profit factor
    if profit_factor < REQUIRED_PROFIT_FACTOR:
        return GraduationStatus(
            verdict="PASSIVE",
            reason=f"Profit factor {profit_factor:.2f} below {REQUIRED_PROFIT_FACTOR:.1f}x required",
            **stats,
        )

    # Gate 3: Drawdown
    if max_dd > MAX_DRAWDOWN_ALLOWED:
        return GraduationStatus(
            verdict="PASSIVE",
            reason=f"Max drawdown {max_dd:.1%} exceeds {MAX_DRAWDOWN_ALLOWED:.0%} limit",
            **stats,
        )

    # All gates passed
    return GraduationStatus(
        verdict="ACTIVE",
        reason="PERFORMANCE MET: All graduation gates passed",
        **stats,
    )


# ── Graduation File Management ─────────────────────────────────────────────

def is_graduated() -> bool:
    """Check if the engine has already graduated (file exists with ACTIVE verdict)."""
    path = Path(GRADUATION_FILE)
    if not path.exists():
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data.get("verdict") == "ACTIVE"
    except (json.JSONDecodeError, IOError):
        return False


def write_graduation(status: GraduationStatus) -> None:
    """Write graduation proof to disk. Only writes on ACTIVE verdict."""
    if status.verdict != "ACTIVE":
        return

    path = Path(GRADUATION_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)

    proof = status.to_dict()
    proof["graduated_at"] = time.time()
    proof["thresholds"] = {
        "min_trades": MIN_PAPER_TRADES,
        "required_profit_factor": REQUIRED_PROFIT_FACTOR,
        "max_drawdown": MAX_DRAWDOWN_ALLOWED,
        "min_win_rate": MIN_WIN_RATE,
    }

    with open(path, "w", encoding="utf-8") as f:
        json.dump(proof, f, indent=2)

    logger.info("GRADUATION PROOF written to %s", path)


def revoke_graduation() -> None:
    """Revoke graduation if performance degrades after promotion."""
    path = Path(GRADUATION_FILE)
    if path.exists():
        path.unlink()
        logger.warning("GRADUATION REVOKED — graduation.json removed")


# ── Background Monitor ──────────────────────────────────────────────────────

class GraduationMonitor:
    """
    Background thread that periodically checks paper trade performance
    and graduates the engine when thresholds are met.
    """

    _instance: Optional["GraduationMonitor"] = None

    def __init__(self) -> None:
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_status: Optional[GraduationStatus] = None
        self._broadcast_fn = None  # Set by main.py to push to Redis

    @classmethod
    def get_instance(cls) -> "GraduationMonitor":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def start(self, broadcast_fn=None) -> None:
        """Start the graduation monitor background thread."""
        if self._running:
            return
        self._broadcast_fn = broadcast_fn
        self._running = True
        self._thread = threading.Thread(
            target=self._monitor_loop, daemon=True, name="graduation-monitor"
        )
        self._thread.start()
        logger.info(
            "Graduation monitor started (check every %ds, need %d trades, PF >= %.1f, DD < %.0f%%)",
            CHECK_INTERVAL, MIN_PAPER_TRADES, REQUIRED_PROFIT_FACTOR, MAX_DRAWDOWN_ALLOWED * 100,
        )

    def stop(self) -> None:
        self._running = False

    def get_status(self) -> Dict[str, Any]:
        """Return current graduation status for dashboard/health check."""
        if self._last_status:
            return self._last_status.to_dict()
        return {"verdict": "PASSIVE", "reason": "Not yet checked", "total_trades": 0}

    def _monitor_loop(self) -> None:
        """Background loop — checks graduation every CHECK_INTERVAL seconds."""
        while self._running:
            try:
                # Skip if already graduated
                if is_graduated():
                    if self._last_status is None or self._last_status.verdict != "ACTIVE":
                        self._last_status = check_graduation()
                        logger.info("Engine already graduated — ACTIVE")
                    time.sleep(CHECK_INTERVAL)
                    continue

                status = check_graduation()
                self._last_status = status

                if status.verdict == "ACTIVE":
                    logger.info(
                        "GRADUATION EARNED: PF=%.2f, WR=%.1f%%, DD=%.1f%%, PnL=$%.2f (%d trades)",
                        status.profit_factor,
                        status.win_rate * 100,
                        status.max_drawdown_pct * 100,
                        status.total_pnl_usd,
                        status.total_trades,
                    )
                    write_graduation(status)
                    self._try_broadcast("GRADUATION", status.to_dict())
                else:
                    logger.info(
                        "Graduation check: %s [trades=%d PF=%.2f WR=%.1f%% DD=%.1f%%]",
                        status.reason,
                        status.total_trades,
                        status.profit_factor,
                        status.win_rate * 100,
                        status.max_drawdown_pct * 100,
                    )

            except Exception as exc:
                logger.warning("Graduation check error: %s", exc)

            time.sleep(CHECK_INTERVAL)

    def _try_broadcast(self, event_type: str, data: Dict[str, Any]) -> None:
        """Try to broadcast via the registered callback."""
        if self._broadcast_fn:
            try:
                self._broadcast_fn(event_type, data)
            except Exception:
                pass  # Non-fatal


def get_graduation_monitor() -> GraduationMonitor:
    """Module-level singleton accessor."""
    return GraduationMonitor.get_instance()
