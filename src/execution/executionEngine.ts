/**
 * ═══════════════════════════════════════════════════════════════
 *  EXECUTION QUALITY ENGINE — Advanced Order Execution
 * ═══════════════════════════════════════════════════════════════
 * 
 * Implements:
 * 1. Pre-flight transaction simulation via Jupiter
 * 2. MEV exposure estimation (sandwich attack probability)
 * 3. Adaptive slippage based on real-time liquidity
 * 4. TWAP/VWAP splitting for larger positions
 * 5. Jito bundle integration for MEV protection
 * 6. Post-trade execution quality analysis (TCA)
 * 7. Unified TypeScript execution (replaces Python executor)
 */

import { Connection, PublicKey, VersionedTransaction, TransactionMessage, Keypair } from '@solana/web3.js';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import axios from 'axios';

// ── TYPES ─────────────────────────────────────────────────

export interface ExecutionPlan {
  tokenCA: string;
  side: 'BUY' | 'SELL';
  amountSOL: number;
  strategy: ExecutionStrategy;
  maxSlippageBps: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  jitoProtection: boolean;
  simulation: SimulationResult | null;
}

export type ExecutionStrategy = 'IMMEDIATE' | 'TWAP' | 'VWAP' | 'ICEBERG';

export interface SimulationResult {
  expectedOutputAmount: number;
  priceImpactPct: number;
  routePlan: RouteLeg[];
  estimatedFeeSOL: number;
  mevExposure: MEVExposure;
  liquidityDepth: LiquidityDepth;
  passed: boolean;
  failReason?: string;
}

export interface RouteLeg {
  dex: string;
  inputMint: string;
  outputMint: string;
  pct: number;
}

export interface MEVExposure {
  sandwichProbability: number;    // 0-1
  expectedSandwichCost: number;   // in SOL
  frontrunRisk: number;           // 0-10
  recommendation: 'JITO_BUNDLE' | 'NORMAL' | 'ABORT';
}

export interface LiquidityDepth {
  bid1Pct: number;                // depth at 1% price impact
  bid5Pct: number;                // depth at 5%
  bid10Pct: number;               // depth at 10%
  spreadBps: number;
  isThick: boolean;
}

export interface ExecutionResult {
  success: boolean;
  txSignature?: string;
  executedPrice: number;
  slippageBps: number;
  priceImpactBps: number;
  fillAmount: number;
  feeSOL: number;
  executionTimeMs: number;
  strategy: ExecutionStrategy;
  jitoUsed: boolean;
  error?: string;
}

export interface TCAReport {
  tokenCA: string;
  side: 'BUY' | 'SELL';
  plannedSizeSOL: number;
  executedSizeSOL: number;
  slippageCostSOL: number;
  timingCostSOL: number;
  impactCostSOL: number;
  totalCostSOL: number;
  totalCostBps: number;
  arrivalPrice: number;
  vwapPrice: number;
  executedPrice: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
}

// ── JUPITER QUOTE TYPES ───────────────────────────────────

interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: { swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; feeAmount: string }; percent: number }[];
}

// ── EXECUTION ENGINE ──────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';

export class ExecutionEngine {
  private connection: Connection;
  private backupConnection: Connection;
  private jitoEndpoint: string | null;
  private tcaHistory: TCAReport[] = [];
  private executionHistory: ExecutionResult[] = [];

  // Rolling execution quality metrics
  private avgSlippageBps: number = 0;
  private avgImpactBps: number = 0;
  private executionCount: number = 0;

  constructor(
    connection: Connection,
    backupConnection: Connection,
    jitoEndpoint?: string
  ) {
    this.connection = connection;
    this.backupConnection = backupConnection;
    this.jitoEndpoint = jitoEndpoint ?? null;
  }

  // ── PRE-FLIGHT SIMULATION ─────────────────────────────

  async simulate(
    tokenCA: string,
    side: 'BUY' | 'SELL',
    amountSOL: number
  ): Promise<SimulationResult> {
    const inputMint = side === 'BUY' ? SOL_MINT : tokenCA;
    const outputMint = side === 'BUY' ? tokenCA : SOL_MINT;
    const amountLamports = Math.round(amountSOL * 1e9);

    try {
      // Get Jupiter quote
      const quoteResponse = await axios.get<JupiterQuote>(`${JUPITER_API}/quote`, {
        params: {
          inputMint,
          outputMint,
          amount: amountLamports.toString(),
          slippageBps: 100, // temporary for simulation
        },
        timeout: 5000,
      });

      const quote = quoteResponse.data;
      const priceImpact = parseFloat(quote.priceImpactPct);

      // Build route plan
      const routePlan: RouteLeg[] = (quote.routePlan ?? []).map(r => ({
        dex: r.swapInfo.label,
        inputMint: r.swapInfo.inputMint,
        outputMint: r.swapInfo.outputMint,
        pct: r.percent,
      }));

      // Estimate MEV exposure
      const mev = this.estimateMEVExposure(amountSOL, priceImpact, routePlan);

      // Assess liquidity depth with multiple quote sizes
      const depth = await this.assessLiquidityDepth(inputMint, outputMint, amountSOL);

      // Pass/fail criteria
      const passed = priceImpact < 3.0 && mev.sandwichProbability < 0.5;

      return {
        expectedOutputAmount: parseInt(quote.outAmount),
        priceImpactPct: priceImpact,
        routePlan,
        estimatedFeeSOL: 0.000005, // base fee
        mevExposure: mev,
        liquidityDepth: depth,
        passed,
        failReason: !passed
          ? `Impact: ${priceImpact.toFixed(2)}%, MEV: ${(mev.sandwichProbability * 100).toFixed(0)}%`
          : undefined,
      };
    } catch (err) {
      logger.error('Simulation failed', { tokenCA, side, error: (err as Error).message });
      return {
        expectedOutputAmount: 0,
        priceImpactPct: 100,
        routePlan: [],
        estimatedFeeSOL: 0,
        mevExposure: { sandwichProbability: 1, expectedSandwichCost: 0, frontrunRisk: 10, recommendation: 'ABORT' },
        liquidityDepth: { bid1Pct: 0, bid5Pct: 0, bid10Pct: 0, spreadBps: 10000, isThick: false },
        passed: false,
        failReason: (err as Error).message,
      };
    }
  }

  // ── EXECUTION PLAN ────────────────────────────────────

  createExecutionPlan(
    tokenCA: string,
    side: 'BUY' | 'SELL',
    amountSOL: number,
    simulation: SimulationResult | null,
    urgency: 'HIGH' | 'MEDIUM' | 'LOW'
  ): ExecutionPlan {
    // Choose strategy based on size and liquidity
    let strategy: ExecutionStrategy = 'IMMEDIATE';
    let maxSlippage = 100; // 1% default
    let jitoProtection = false;

    if (simulation) {
      // Large positions relative to liquidity → split
      if (simulation.priceImpactPct > 2.0 && amountSOL > 1) {
        strategy = 'TWAP';
      } else if (simulation.priceImpactPct > 1.5 && amountSOL > 0.5) {
        strategy = 'ICEBERG';
      }

      // Adaptive slippage based on liquidity
      if (simulation.liquidityDepth.isThick) {
        maxSlippage = 50;  // tight for liquid markets
      } else if (simulation.priceImpactPct > 1.0) {
        maxSlippage = 200; // wider for illiquid
      }

      // MEV protection
      if (simulation.mevExposure.recommendation === 'JITO_BUNDLE' && this.jitoEndpoint) {
        jitoProtection = true;
      }
    }

    // Override for urgency
    if (urgency === 'HIGH') {
      strategy = 'IMMEDIATE';
      maxSlippage = Math.max(maxSlippage, 150);
    }

    return {
      tokenCA,
      side,
      amountSOL,
      strategy,
      maxSlippageBps: maxSlippage,
      priority: urgency,
      jitoProtection,
      simulation,
    };
  }

  // ── EXECUTE ───────────────────────────────────────────

  async execute(plan: ExecutionPlan, wallet: Keypair): Promise<ExecutionResult> {
    const startTime = Date.now();

    logger.info('Executing trade', {
      tokenCA: plan.tokenCA,
      side: plan.side,
      amountSOL: plan.amountSOL,
      strategy: plan.strategy,
      maxSlippage: plan.maxSlippageBps,
      jito: plan.jitoProtection,
    });

    try {
      let result: ExecutionResult;

      switch (plan.strategy) {
        case 'TWAP':
          result = await this.executeTWAP(plan, wallet, startTime);
          break;
        case 'ICEBERG':
          result = await this.executeIceberg(plan, wallet, startTime);
          break;
        case 'IMMEDIATE':
        default:
          result = await this.executeImmediate(plan, wallet, startTime);
          break;
      }

      // Record for TCA
      this.executionHistory.push(result);
      this.updateRollingMetrics(result);

      return result;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      logger.error('Execution failed', {
        tokenCA: plan.tokenCA,
        error: (err as Error).message,
        elapsed,
      });

      return {
        success: false,
        executedPrice: 0,
        slippageBps: 0,
        priceImpactBps: 0,
        fillAmount: 0,
        feeSOL: 0,
        executionTimeMs: elapsed,
        strategy: plan.strategy,
        jitoUsed: plan.jitoProtection,
        error: (err as Error).message,
      };
    }
  }

  // ── IMMEDIATE EXECUTION ─────────────────────────────

  private async executeImmediate(plan: ExecutionPlan, wallet: Keypair, startTime: number): Promise<ExecutionResult> {
    const inputMint = plan.side === 'BUY' ? SOL_MINT : plan.tokenCA;
    const outputMint = plan.side === 'BUY' ? plan.tokenCA : SOL_MINT;
    const amountLamports = Math.round(plan.amountSOL * 1e9);

    // Get swap transaction from Jupiter
    const quoteResp = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps: plan.maxSlippageBps,
      },
      timeout: 5000,
    });

    const swapResp = await axios.post(`${JUPITER_API}/swap`, {
      quoteResponse: quoteResp.data,
      userPublicKey: wallet.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }, { timeout: 10000 });

    const swapTxBuf = Buffer.from(swapResp.data.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(swapTxBuf);
    tx.sign([wallet]);

    let txSignature: string;

    if (plan.jitoProtection && this.jitoEndpoint) {
      txSignature = await this.sendViaJito(tx);
    } else {
      txSignature = await this.sendWithRetry(tx);
    }

    const elapsed = Date.now() - startTime;
    const priceImpact = parseFloat(quoteResp.data.priceImpactPct ?? '0');

    return {
      success: true,
      txSignature,
      executedPrice: plan.amountSOL, // simplified
      slippageBps: plan.maxSlippageBps,
      priceImpactBps: Math.round(priceImpact * 100),
      fillAmount: parseInt(quoteResp.data.outAmount),
      feeSOL: 0.000005,
      executionTimeMs: elapsed,
      strategy: 'IMMEDIATE',
      jitoUsed: plan.jitoProtection,
    };
  }

  // ── TWAP EXECUTION ──────────────────────────────────

  private async executeTWAP(plan: ExecutionPlan, wallet: Keypair, startTime: number): Promise<ExecutionResult> {
    const chunks = Math.ceil(plan.amountSOL / 0.5); // 0.5 SOL per chunk
    const chunkSize = plan.amountSOL / chunks;
    const intervalMs = 10_000; // 10s between chunks

    let totalFill = 0;
    let totalFee = 0;
    let lastTxSig = '';

    for (let i = 0; i < chunks; i++) {
      const chunkPlan: ExecutionPlan = {
        ...plan,
        amountSOL: chunkSize,
        strategy: 'IMMEDIATE',
      };

      const result = await this.executeImmediate(chunkPlan, wallet, startTime);
      if (!result.success) {
        logger.warn('TWAP chunk failed', { chunk: i + 1, total: chunks, error: result.error });
        break;
      }

      totalFill += result.fillAmount;
      totalFee += result.feeSOL;
      lastTxSig = result.txSignature ?? '';

      if (i < chunks - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    return {
      success: totalFill > 0,
      txSignature: lastTxSig,
      executedPrice: plan.amountSOL,
      slippageBps: plan.maxSlippageBps,
      priceImpactBps: 0,
      fillAmount: totalFill,
      feeSOL: totalFee,
      executionTimeMs: Date.now() - startTime,
      strategy: 'TWAP',
      jitoUsed: plan.jitoProtection,
    };
  }

  // ── ICEBERG EXECUTION ───────────────────────────────

  private async executeIceberg(plan: ExecutionPlan, wallet: Keypair, startTime: number): Promise<ExecutionResult> {
    // Show only 30% of the order at a time
    const visiblePct = 0.30;
    const visibleAmount = plan.amountSOL * visiblePct;
    const chunks = Math.ceil(1 / visiblePct);
    const intervalMs = 5_000;

    let totalFill = 0;
    let totalFee = 0;
    let lastTxSig = '';

    for (let i = 0; i < chunks; i++) {
      const remaining = plan.amountSOL - (visibleAmount * i);
      const thisChunk = Math.min(visibleAmount, remaining);
      if (thisChunk <= 0) break;

      const chunkPlan: ExecutionPlan = {
        ...plan,
        amountSOL: thisChunk,
        strategy: 'IMMEDIATE',
      };

      const result = await this.executeImmediate(chunkPlan, wallet, startTime);
      if (!result.success) break;

      totalFill += result.fillAmount;
      totalFee += result.feeSOL;
      lastTxSig = result.txSignature ?? '';

      if (i < chunks - 1) await new Promise(r => setTimeout(r, intervalMs));
    }

    return {
      success: totalFill > 0,
      txSignature: lastTxSig,
      executedPrice: plan.amountSOL,
      slippageBps: plan.maxSlippageBps,
      priceImpactBps: 0,
      fillAmount: totalFill,
      feeSOL: totalFee,
      executionTimeMs: Date.now() - startTime,
      strategy: 'ICEBERG',
      jitoUsed: plan.jitoProtection,
    };
  }

  // ── JITO BUNDLE SUBMISSION ──────────────────────────

  private async sendViaJito(tx: VersionedTransaction): Promise<string> {
    if (!this.jitoEndpoint) throw new Error('Jito endpoint not configured');

    const serialized = Buffer.from(tx.serialize()).toString('base64');

    const resp = await axios.post(this.jitoEndpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [[serialized]],
    }, { timeout: 15000 });

    logger.info('Jito bundle submitted', { bundleId: resp.data.result });
    return resp.data.result;
  }

  // ── SEND WITH RETRY ─────────────────────────────────

  private async sendWithRetry(tx: VersionedTransaction, retries = 3): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const conn = attempt === 0 ? this.connection : this.backupConnection;
        const sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
        });

        // Confirm
        const confirmation = await conn.confirmTransaction(sig, 'confirmed');
        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        return sig;
      } catch (err) {
        lastError = err as Error;
        logger.warn('Send attempt failed', { attempt: attempt + 1, error: lastError.message });
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error('All retry attempts failed');
  }

  // ── MEV ESTIMATION ──────────────────────────────────

  private estimateMEVExposure(
    amountSOL: number,
    priceImpactPct: number,
    routePlan: RouteLeg[]
  ): MEVExposure {
    // Larger trades and higher impact = more MEV opportunity
    let sandwichProb = 0;

    // Size factor: >2 SOL = meaningful target
    if (amountSOL > 5) sandwichProb += 0.3;
    else if (amountSOL > 2) sandwichProb += 0.15;
    else if (amountSOL > 1) sandwichProb += 0.05;

    // Impact factor: high impact = more extractable value
    sandwichProb += Math.min(0.4, priceImpactPct * 0.1);

    // Multi-hop routes are harder to sandwich
    if (routePlan.length > 2) sandwichProb *= 0.7;

    // Estimated cost
    const expectedCost = sandwichProb * amountSOL * priceImpactPct / 100;

    const frontrunRisk = Math.min(10, sandwichProb * 10 + priceImpactPct * 2);

    const recommendation: MEVExposure['recommendation'] =
      sandwichProb > 0.5 ? 'ABORT' :
      sandwichProb > 0.2 ? 'JITO_BUNDLE' :
      'NORMAL';

    return { sandwichProbability: sandwichProb, expectedSandwichCost: expectedCost, frontrunRisk, recommendation };
  }

  // ── LIQUIDITY DEPTH ─────────────────────────────────

  private async assessLiquidityDepth(
    inputMint: string,
    outputMint: string,
    baseAmount: number
  ): Promise<LiquidityDepth> {
    const amounts = [0.1, 0.5, 1.0]; // test at different sizes
    const impacts: number[] = [];

    for (const mult of amounts) {
      try {
        const testAmount = Math.round(baseAmount * mult * 1e9);
        const resp = await axios.get(`${JUPITER_API}/quote`, {
          params: {
            inputMint,
            outputMint,
            amount: testAmount.toString(),
            slippageBps: 500,
          },
          timeout: 3000,
        });
        impacts.push(parseFloat(resp.data.priceImpactPct ?? '0'));
      } catch {
        impacts.push(99);
      }
    }

    return {
      bid1Pct: impacts[0] ?? 99,
      bid5Pct: impacts[1] ?? 99,
      bid10Pct: impacts[2] ?? 99,
      spreadBps: Math.round(impacts[0] * 100),
      isThick: impacts[1] < 2.0,
    };
  }

  // ── TRADE COST ANALYSIS ─────────────────────────────

  generateTCA(
    tokenCA: string,
    side: 'BUY' | 'SELL',
    plannedSOL: number,
    arrivalPrice: number,
    executionResults: ExecutionResult[]
  ): TCAReport {
    const executedSOL = executionResults.reduce((s, r) => s + (r.success ? r.executedPrice : 0), 0);
    const avgSlippage = executionResults.reduce((s, r) => s + r.slippageBps, 0) / executionResults.length;
    const avgImpact = executionResults.reduce((s, r) => s + r.priceImpactBps, 0) / executionResults.length;

    const slippageCost = executedSOL * avgSlippage / 10000;
    const impactCost = executedSOL * avgImpact / 10000;
    const timingCost = 0; // Would need VWAP data

    const totalCost = slippageCost + impactCost + timingCost;
    const totalCostBps = executedSOL > 0 ? (totalCost / executedSOL) * 10000 : 0;

    // Grade
    let grade: TCAReport['grade'];
    if (totalCostBps < 30) grade = 'A';
    else if (totalCostBps < 75) grade = 'B';
    else if (totalCostBps < 150) grade = 'C';
    else if (totalCostBps < 300) grade = 'D';
    else grade = 'F';

    const report: TCAReport = {
      tokenCA,
      side,
      plannedSizeSOL: plannedSOL,
      executedSizeSOL: executedSOL,
      slippageCostSOL: slippageCost,
      timingCostSOL: timingCost,
      impactCostSOL: impactCost,
      totalCostSOL: totalCost,
      totalCostBps,
      arrivalPrice,
      vwapPrice: arrivalPrice, // simplified
      executedPrice: executedSOL,
      grade,
    };

    this.tcaHistory.push(report);
    if (this.tcaHistory.length > 500) this.tcaHistory.shift();

    logger.info('TCA Report', {
      tokenCA,
      grade,
      totalCostBps: totalCostBps.toFixed(1),
      slippageCost: slippageCost.toFixed(6),
    });

    return report;
  }

  // ── METRICS ─────────────────────────────────────────

  getExecutionQuality(): {
    avgSlippageBps: number;
    avgImpactBps: number;
    totalExecutions: number;
    avgGrade: string;
    recentGrades: string[];
  } {
    const recentTCA = this.tcaHistory.slice(-20);
    const gradeValues: Record<string, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
    const avgGradeVal = recentTCA.length > 0
      ? recentTCA.reduce((s, r) => s + gradeValues[r.grade], 0) / recentTCA.length
      : 0;

    const avgGrade = avgGradeVal >= 3.5 ? 'A' : avgGradeVal >= 2.5 ? 'B' : avgGradeVal >= 1.5 ? 'C' : 'D';

    return {
      avgSlippageBps: this.avgSlippageBps,
      avgImpactBps: this.avgImpactBps,
      totalExecutions: this.executionCount,
      avgGrade,
      recentGrades: recentTCA.map(r => r.grade),
    };
  }

  private updateRollingMetrics(result: ExecutionResult): void {
    this.executionCount++;
    const alpha = 0.1;
    this.avgSlippageBps = this.avgSlippageBps * (1 - alpha) + result.slippageBps * alpha;
    this.avgImpactBps = this.avgImpactBps * (1 - alpha) + result.priceImpactBps * alpha;
  }
}
