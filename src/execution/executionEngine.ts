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

import {
  Connection,
  Keypair,
  ParsedTransactionWithMeta,
  ParsedTransactionMeta,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { logger } from '../core/logger';
import axios from 'axios';
import bs58 from 'bs58';

// Helper: encode bytes to base58 string
function bs58Encode(buf: Uint8Array): string {
  return bs58.encode(buf);
}

// ── JITO TIP ACCOUNTS ─────────────────────────────────────
// Official Jito tip-payment addresses — pick one at random per bundle
const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey('9n3d1K5YD2vECAbRFhFFGYNNjiXtHXJWn9F31t89vsAV'),
  new PublicKey('aTtUk2DHgLhKZRDjePq6eiHRKC1XXFMBiSUfQ2JNDbN'),
  new PublicKey('B1mrQSpdeMU9gCvkJ6VsXVVoYjRGkNA7TtjMyqxrhecH'),
  new PublicKey('9ttgPBBhRYFuQccdR1DSnb7hydsWANoDsV3P9kaGMCEh'),
  new PublicKey('4xgEmT58RwTNsF5xm2RMYCnR1EVukdK8a1i2qFjnJFu3'),
  new PublicKey('EoW3SUQap7ZeynXQ2QJ847aerhxbPVr843uMeTfc9dxM'),
  new PublicKey('E2eSqe33tuhAHKTrwky5uEjaVqnb2T9ns6nHHUrN8588'),
  new PublicKey('ARTtviJkLLt6cHGQDydfo1Wyk6M4VGZdKZ2ZhdnJL336'),
];

// Dynamic tip boundaries
const JITO_MIN_TIP_LAMPORTS = 10_000;        // 0.00001 SOL floor
const JITO_DEFAULT_TIP_LAMPORTS = 100_000;   // 0.0001 SOL
const JITO_MAX_TIP_LAMPORTS = 10_000_000;    // 0.01 SOL cap
const JITO_TIP_PROFIT_SHARE = 0.05;          // give 5% of expected profit as tip
const JITO_BUNDLE_STATUS_POLL_MS = 2_000;
const JITO_BUNDLE_STATUS_TIMEOUT_MS = 30_000;

// ── TYPES ─────────────────────────────────────────────────

export interface ExecutionPlan {
  tokenCA: string;
  side: 'BUY' | 'SELL';
  amountSOL: number;
  strategy: ExecutionStrategy;
  maxSlippageBps: number;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  jitoProtection: boolean;
  forceJitoBundle: boolean;       // backrun trades MUST use Jito
  jitoTipLamports: number;        // dynamic tip amount
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
  expectedFillAmount?: number;
  fillRatio?: number;
  fillVerified?: boolean;
  verificationError?: string;
  error?: string;
}

export interface ExecutionEngineOptions {
  strictFillVerification?: boolean;
  minFillRatio?: number;
  txFetchTimeoutMs?: number;
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

interface FillVerificationResult {
  verified: boolean;
  actualOutAmount: number;
  fillRatio: number;
  executedPriceSOL: number;
  feeSOL: number;
  reason?: string;
}

// ── EXECUTION ENGINE ──────────────────────────────────────

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_API = 'https://lite-api.jup.ag/swap/v1';

export class ExecutionEngine {
  private connection: Connection;
  private backupConnection: Connection;
  private jitoEndpoint: string | null;
  private strictFillVerification: boolean;
  private minFillRatio: number;
  private txFetchTimeoutMs: number;
  private tcaHistory: TCAReport[] = [];
  private executionHistory: ExecutionResult[] = [];

  // Rolling execution quality metrics
  private avgSlippageBps: number = 0;
  private avgImpactBps: number = 0;
  private executionCount: number = 0;

  constructor(
    connection: Connection,
    backupConnection: Connection,
    jitoEndpoint?: string,
    options?: ExecutionEngineOptions
  ) {
    this.connection = connection;
    this.backupConnection = backupConnection;
    this.jitoEndpoint = jitoEndpoint ?? null;
    this.strictFillVerification = options?.strictFillVerification ?? true;
    this.minFillRatio = options?.minFillRatio ?? 0.7;
    this.txFetchTimeoutMs = options?.txFetchTimeoutMs ?? 15_000;
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

    // Default tip — overridden by dynamic calculation for backruns
    let jitoTipLamports = JITO_DEFAULT_TIP_LAMPORTS;
    let forceJitoBundle = false;

    return {
      tokenCA,
      side,
      amountSOL,
      strategy,
      maxSlippageBps: maxSlippage,
      priority: urgency,
      jitoProtection,
      forceJitoBundle,
      jitoTipLamports,
      simulation,
    };
  }

  /**
   * Create an execution plan specifically for backrun trades.
   * Forces Jito bundle with a dynamic tip sized to expected profit.
   */
  createBackrunPlan(
    tokenCA: string,
    side: 'BUY' | 'SELL',
    amountSOL: number,
    expectedProfitSOL: number,
    simulation: SimulationResult | null
  ): ExecutionPlan {
    // Dynamic tip: 5% of expected profit, bounded by min/max
    const tipFromProfit = Math.round(expectedProfitSOL * JITO_TIP_PROFIT_SHARE * 1e9);
    const jitoTipLamports = Math.max(
      JITO_MIN_TIP_LAMPORTS,
      Math.min(JITO_MAX_TIP_LAMPORTS, tipFromProfit)
    );

    return {
      tokenCA,
      side,
      amountSOL,
      strategy: 'IMMEDIATE',
      maxSlippageBps: 200, // wider for fast backrun entry
      priority: 'HIGH',
      jitoProtection: true,
      forceJitoBundle: true,
      jitoTipLamports,
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
        fillRatio: 0,
        fillVerified: false,
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

    if ((plan.forceJitoBundle || plan.jitoProtection) && this.jitoEndpoint) {
      txSignature = await this.sendViaJito(tx, wallet, plan.jitoTipLamports);
    } else {
      txSignature = await this.sendWithRetry(tx);
    }

    const expectedFillAmount = parseInt(quoteResp.data.outAmount ?? '0', 10) || 0;
    const verification = await this.verifyFill({
      txSignature,
      side: plan.side,
      walletAddress: wallet.publicKey.toBase58(),
      outputMint,
      expectedOutAmount: expectedFillAmount,
      expectedInSOL: plan.amountSOL,
    });

    if (this.strictFillVerification && !verification.verified) {
      throw new Error(
        `Fill verification failed (${plan.tokenCA}): ${verification.reason ?? 'unknown reason'}`
      );
    }

    const elapsed = Date.now() - startTime;
    const priceImpact = parseFloat(quoteResp.data.priceImpactPct ?? '0');

    return {
      success: verification.verified || !this.strictFillVerification,
      txSignature,
      executedPrice: verification.executedPriceSOL,
      slippageBps: plan.maxSlippageBps,
      priceImpactBps: Math.round(priceImpact * 100),
      fillAmount: verification.actualOutAmount,
      expectedFillAmount,
      fillRatio: verification.fillRatio,
      fillVerified: verification.verified,
      verificationError: verification.reason,
      feeSOL: verification.feeSOL,
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

  /**
   * Build a Jito tip transaction that transfers lamports to a random
   * Jito tip account. Included as the last tx in the bundle.
   */
  private async buildTipTransaction(
    wallet: Keypair,
    tipLamports: number
  ): Promise<VersionedTransaction> {
    const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');

    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: tipAccount,
          lamports: tipLamports,
        }),
      ],
    }).compileToV0Message();

    const tipTx = new VersionedTransaction(message);
    tipTx.sign([wallet]);

    logger.debug('Jito tip tx built', {
      tipAccount: tipAccount.toBase58(),
      tipLamports,
      tipSOL: (tipLamports / 1e9).toFixed(6),
    });

    return tipTx;
  }

  /**
   * Submit a bundle of transactions to Jito Block Engine.
   * The bundle is atomic: all-or-nothing execution.
   * Includes a tip transaction as the final tx.
   */
  private async sendBundleViaJito(
    transactions: VersionedTransaction[],
    wallet: Keypair,
    tipLamports: number
  ): Promise<{ bundleId: string; txSignature: string }> {
    if (!this.jitoEndpoint) throw new Error('Jito endpoint not configured');

    // Build and append tip tx
    const tipTx = await this.buildTipTransaction(wallet, tipLamports);
    const allTxs = [...transactions, tipTx];

    const serializedTxs = allTxs.map(tx => bs58Encode(Buffer.from(tx.serialize())));

    const resp = await axios.post(this.jitoEndpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [serializedTxs],
    }, { timeout: 15_000 });

    const bundleId = resp.data.result;
    if (!bundleId) {
      throw new Error(`Jito sendBundle returned no bundleId: ${JSON.stringify(resp.data)}`);
    }

    logger.info('Jito bundle submitted', {
      bundleId,
      txCount: allTxs.length,
      tipLamports,
      tipSOL: (tipLamports / 1e9).toFixed(6),
    });

    // The first transaction's signature is our trade tx
    const tradeTxSig = await this.pollBundleStatus(bundleId);

    return { bundleId, txSignature: tradeTxSig };
  }

  /**
   * Legacy single-tx Jito submission (backwards compat for non-backrun trades).
   */
  private async sendViaJito(tx: VersionedTransaction, wallet: Keypair, tipLamports: number): Promise<string> {
    const { txSignature } = await this.sendBundleViaJito([tx], wallet, tipLamports);
    return txSignature;
  }

  /**
   * Poll Jito for bundle landing status.
   * Returns the first transaction signature once the bundle is confirmed.
   */
  private async pollBundleStatus(bundleId: string): Promise<string> {
    if (!this.jitoEndpoint) throw new Error('Jito endpoint not configured');

    const startedAt = Date.now();

    while (Date.now() - startedAt < JITO_BUNDLE_STATUS_TIMEOUT_MS) {
      try {
        const resp = await axios.post(this.jitoEndpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        }, { timeout: 5_000 });

        const statuses = resp.data?.result?.value;
        if (statuses && statuses.length > 0) {
          const status = statuses[0];
          const confirmationStatus = status.confirmation_status;

          if (confirmationStatus === 'confirmed' || confirmationStatus === 'finalized') {
            const txSig = status.transactions?.[0] ?? bundleId;
            logger.info('Jito bundle landed', {
              bundleId,
              status: confirmationStatus,
              slot: status.slot,
              txSignature: txSig,
              elapsedMs: Date.now() - startedAt,
            });
            return txSig;
          }

          if (confirmationStatus === 'failed' || status.err) {
            throw new Error(`Jito bundle failed: ${JSON.stringify(status.err ?? 'unknown')}`);
          }
        }
      } catch (err) {
        if ((err as Error).message.includes('Jito bundle failed')) throw err;
        // Network hiccup — keep polling
      }

      await new Promise(r => setTimeout(r, JITO_BUNDLE_STATUS_POLL_MS));
    }

    // Timeout — bundle may still land, return bundleId as fallback
    logger.warn('Jito bundle status poll timed out', { bundleId, timeoutMs: JITO_BUNDLE_STATUS_TIMEOUT_MS });
    return bundleId;
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

  private async verifyFill(params: {
    txSignature: string;
    side: 'BUY' | 'SELL';
    walletAddress: string;
    outputMint: string;
    expectedOutAmount: number;
    expectedInSOL: number;
  }): Promise<FillVerificationResult> {
    const parsed = await this.waitForParsedTransaction(params.txSignature);
    if (!parsed?.meta) {
      return {
        verified: false,
        actualOutAmount: 0,
        fillRatio: 0,
        executedPriceSOL: 0,
        feeSOL: 0,
        reason: 'transaction details unavailable',
      };
    }

    if (parsed.meta.err) {
      return {
        verified: false,
        actualOutAmount: 0,
        fillRatio: 0,
        executedPriceSOL: 0,
        feeSOL: (parsed.meta.fee ?? 0) / 1e9,
        reason: `transaction error: ${JSON.stringify(parsed.meta.err)}`,
      };
    }

    const accountKeys = parsed.transaction.message.accountKeys.map((key) => key.pubkey.toBase58());
    const walletIndex = accountKeys.findIndex((address) => address === params.walletAddress);
    const preLamports = walletIndex >= 0 ? parsed.meta.preBalances[walletIndex] ?? 0 : 0;
    const postLamports = walletIndex >= 0 ? parsed.meta.postBalances[walletIndex] ?? 0 : 0;
    const feeSOL = (parsed.meta.fee ?? 0) / 1e9;

    if (params.side === 'BUY') {
      const outRawBigInt = this.getTokenDeltaRaw(parsed.meta, params.walletAddress, params.outputMint);
      const actualOutAmount = this.bigintToNumber(outRawBigInt);
      const fillRatio = params.expectedOutAmount > 0
        ? actualOutAmount / params.expectedOutAmount
        : 0;
      const spentSOL = Math.max(0, (preLamports - postLamports) / 1e9);
      const executedPriceSOL = actualOutAmount > 0 ? spentSOL / actualOutAmount : 0;
      const verified = actualOutAmount > 0 && fillRatio >= this.minFillRatio;

      return {
        verified,
        actualOutAmount,
        fillRatio,
        executedPriceSOL,
        feeSOL,
        reason: verified
          ? undefined
          : `fillRatio ${fillRatio.toFixed(3)} below minimum ${this.minFillRatio}`,
      };
    }

    const outSOL = Math.max(0, (postLamports - preLamports) / 1e9);
    const fillRatio = params.expectedInSOL > 0 ? outSOL / params.expectedInSOL : 0;
    const verified = outSOL > 0;

    return {
      verified,
      actualOutAmount: Math.round(outSOL * 1e9),
      fillRatio,
      executedPriceSOL: params.expectedInSOL > 0 ? outSOL / params.expectedInSOL : 0,
      feeSOL,
      reason: verified ? undefined : 'no SOL received on sell execution',
    };
  }

  private async waitForParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.txFetchTimeoutMs) {
      const primary = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (primary?.meta) return primary;

      const backup = await this.backupConnection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (backup?.meta) return backup;

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return null;
  }

  private getTokenDeltaRaw(
    meta: ParsedTransactionMeta,
    walletAddress: string,
    mint: string
  ): bigint {
    const pre = this.sumOwnedTokenBalance(meta.preTokenBalances, walletAddress, mint);
    const post = this.sumOwnedTokenBalance(meta.postTokenBalances, walletAddress, mint);
    return post - pre;
  }

  private sumOwnedTokenBalance(
    balances: ParsedTransactionMeta['preTokenBalances'] | ParsedTransactionMeta['postTokenBalances'],
    walletAddress: string,
    mint: string
  ): bigint {
    if (!balances || balances.length === 0) return 0n;
    return balances.reduce((sum, entry) => {
      if (entry.mint !== mint) return sum;
      if (entry.owner !== walletAddress) return sum;
      try {
        return sum + BigInt(entry.uiTokenAmount.amount);
      } catch {
        return sum;
      }
    }, 0n);
  }

  private bigintToNumber(value: bigint): number {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (value > max) return Number.MAX_SAFE_INTEGER;
    if (value < min) return Number.MIN_SAFE_INTEGER;
    return Number(value);
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
