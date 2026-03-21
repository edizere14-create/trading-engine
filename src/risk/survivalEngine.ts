import { schedule, ScheduledTask } from 'node-cron';
import { SurvivalSnapshot, SurvivalState } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';

export class SurvivalEngine {
  private state: SurvivalState = 'NORMAL';
  private dailyPnLUSD = 0;
  private weeklyPnLUSD = 0;
  private consecutiveLosses = 0;
  private capitalUSD: number;
  private cronTask: ScheduledTask | null = null;

  constructor(initialCapitalUSD: number) {
    this.capitalUSD = initialCapitalUSD;
  }

  start(): void {
    // Reset daily PnL at midnight UTC
    this.cronTask = schedule('0 0 * * *', () => {
      logger.info('Daily PnL reset', { previousDailyPnL: this.dailyPnLUSD });
      this.dailyPnLUSD = 0;
      this.reevaluateState();
    }, { timezone: 'UTC' });

    logger.info('SurvivalEngine started', { capitalUSD: this.capitalUSD });
  }

  stop(): void {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
  }

  recordTrade(pnlUSD: number, currentCapitalUSD: number): void {
    this.capitalUSD = currentCapitalUSD;
    this.dailyPnLUSD += pnlUSD;
    this.weeklyPnLUSD += pnlUSD;

    if (pnlUSD < 0) {
      this.consecutiveLosses++;
    } else if (pnlUSD > 0) {
      this.consecutiveLosses = 0;
    }

    this.reevaluateState();

    logger.info('Survival trade recorded', {
      pnlUSD: pnlUSD.toFixed(2),
      dailyPnLUSD: this.dailyPnLUSD.toFixed(2),
      weeklyPnLUSD: this.weeklyPnLUSD.toFixed(2),
      consecutiveLosses: this.consecutiveLosses,
      state: this.state,
    });
  }

  resetWeeklyPnL(): void {
    logger.info('Weekly PnL reset', { previousWeeklyPnL: this.weeklyPnLUSD });
    this.weeklyPnLUSD = 0;
    this.reevaluateState();
  }

  private reevaluateState(): void {
    const prevState = this.state;
    const dailyPct = this.getDailyPnLPct();
    const weeklyPct = this.getWeeklyPnLPct();

    // HALT: daily loss >20% OR weekly loss >40% OR 4+ consecutive losses
    if (dailyPct < -20 || weeklyPct < -40 || this.consecutiveLosses >= 4) {
      this.state = 'HALT';

      if (prevState !== 'HALT') {
        const isWeeklyHalt = weeklyPct < -40;
        const resumeAt = new Date();
        if (isWeeklyHalt) {
          resumeAt.setDate(resumeAt.getDate() + 7);
        } else {
          resumeAt.setDate(resumeAt.getDate() + 1);
        }

        bus.emit('system:halt', {
          reason: `SURVIVAL_HALT: daily=${dailyPct.toFixed(1)}% weekly=${weeklyPct.toFixed(1)}% consLoss=${this.consecutiveLosses}`,
          resumeAt,
        });
      }
    }
    // DEFENSIVE: daily loss >15% OR 3 consecutive losses
    else if (dailyPct < -15 || this.consecutiveLosses >= 3) {
      this.state = 'DEFENSIVE';
    }
    // CAUTION: daily loss >10% OR 2 consecutive losses
    else if (dailyPct < -10 || this.consecutiveLosses >= 2) {
      this.state = 'CAUTION';
    }
    // NORMAL
    else {
      this.state = 'NORMAL';
    }

    if (prevState !== this.state) {
      const snapshot = this.getSnapshot();
      bus.emit('survival:stateChanged', snapshot);
      logger.warn('Survival state changed', {
        from: prevState,
        to: this.state,
        dailyPct: dailyPct.toFixed(1),
        weeklyPct: weeklyPct.toFixed(1),
        consecutiveLosses: this.consecutiveLosses,
        sizeMultiplier: this.getSizeMultiplier(),
      });
    }
  }

  private getDailyPnLPct(): number {
    if (this.capitalUSD <= 0) return -100;
    return (this.dailyPnLUSD / this.capitalUSD) * 100;
  }

  private getWeeklyPnLPct(): number {
    if (this.capitalUSD <= 0) return -100;
    return (this.weeklyPnLUSD / this.capitalUSD) * 100;
  }

  getSizeMultiplier(): number {
    switch (this.state) {
      case 'NORMAL':    return 1.0;
      case 'CAUTION':   return 0.75;
      case 'DEFENSIVE': return 0.5;
      case 'HALT':      return 0;
    }
  }

  isHighVarianceAllowed(): boolean {
    return this.state === 'NORMAL' || this.state === 'CAUTION';
  }

  getSnapshot(): SurvivalSnapshot {
    return {
      state: this.state,
      dailyPnLPct: this.getDailyPnLPct(),
      weeklyPnLPct: this.getWeeklyPnLPct(),
      consecutiveLosses: this.consecutiveLosses,
      sizeMultiplier: this.getSizeMultiplier(),
      highVarianceEnabled: this.isHighVarianceAllowed(),
      message: this.buildMessage(),
    };
  }

  private buildMessage(): string {
    const daily = this.getDailyPnLPct().toFixed(1);
    const weekly = this.getWeeklyPnLPct().toFixed(1);
    switch (this.state) {
      case 'NORMAL':
        return `NORMAL | daily:${daily}% weekly:${weekly}% | full size`;
      case 'CAUTION':
        return `CAUTION | daily:${daily}% weekly:${weekly}% | consLoss:${this.consecutiveLosses} | size×0.75`;
      case 'DEFENSIVE':
        return `DEFENSIVE | daily:${daily}% weekly:${weekly}% | consLoss:${this.consecutiveLosses} | size×0.5 | high-var OFF`;
      case 'HALT':
        return `HALT | daily:${daily}% weekly:${weekly}% | consLoss:${this.consecutiveLosses} | NO TRADES`;
    }
  }
}
