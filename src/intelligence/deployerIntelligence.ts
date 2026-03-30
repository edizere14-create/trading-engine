/**
 * ═══════════════════════════════════════════════════════════════
 *  AUTONOMOUS DEPLOYER INTELLIGENCE
 * ═══════════════════════════════════════════════════════════════
 * 
 * Replaces static JSON deployer registry with:
 * 1. On-chain deployer history analysis
 * 2. Automatic tier classification from launch outcomes
 * 3. Deployer wallet graph analysis (funding patterns)
 * 4. Launch success/failure tracking
 * 5. Fresh wallet detection
 * 6. Dynamic tier updates from trade outcomes
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { DeployerTier } from '../core/types';
import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import fs from 'fs';
import path from 'path';

// ── TYPES ─────────────────────────────────────────────────

export interface DeployerProfile {
  address: string;
  tier: DeployerTier;
  confidence: number;             // 0-1 how confident in tier
  
  // Historical stats
  totalLaunches: number;
  successfulLaunches: number;     // peaked above 2x
  ruggedLaunches: number;         // LP removed or >90% crash
  avgPeakMultiple: number;
  avgTimeToRug: number;           // ms, 0 if no rugs
  
  // On-chain analysis
  walletAgeDays: number;
  fundingSources: string[];       // wallets that funded this deployer
  isLinkedToKnownDeployer: boolean;
  linkedDeployers: string[];
  totalFundingSOL: number;
  
  // Safety metrics
  lpRemovalRate: number;          // % of launches where LP was removed
  mintAuthRevokeRate: number;     // % where mint auth was revoked
  freezeAuthRevokeRate: number;
  avgTopHolderPct: number;        // avg top 10 holder % at launch
  
  // Dynamic scoring
  reputationScore: number;        // 0-100 composite score
  lastUpdated: Date;
  lastLaunchTimestamp: Date | null;
}

export interface DeployerGraph {
  nodes: Map<string, DeployerProfile>;
  edges: Map<string, Set<string>>;    // deployer → connected deployers (shared funding)
}

// ── DEPLOYER INTELLIGENCE ENGINE ──────────────────────────

export class DeployerIntelligence {
  private profiles: Map<string, DeployerProfile> = new Map();
  private fundingGraph: Map<string, Set<string>> = new Map(); // deployer → funders
  private deployerClusters: Map<string, Set<string>> = new Map(); // cluster_id → deployers
  private connection: Connection;
  private readonly filePath: string;

  // Tier thresholds
  private readonly S_TIER_MIN_SCORE = 80;
  private readonly A_TIER_MIN_SCORE = 60;
  private readonly B_TIER_MIN_SCORE = 45;
  private readonly BLACKLIST_MAX_SCORE = 20;
  private readonly MIN_LAUNCHES_FOR_TIER = 3;

  constructor(connection: Connection, filePath: string = './data/deployer_intelligence.json') {
    this.connection = connection;
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<void> {
    if (!fs.existsSync(this.filePath)) {
      logger.info('Deployer intelligence DB not found — starting fresh');
      return;
    }

    const raw = fs.readFileSync(this.filePath, 'utf-8');
    const data = JSON.parse(raw);

    for (const profile of data.profiles ?? []) {
      profile.lastUpdated = new Date(profile.lastUpdated);
      if (profile.lastLaunchTimestamp) {
        profile.lastLaunchTimestamp = new Date(profile.lastLaunchTimestamp);
      }
      this.profiles.set(profile.address, profile);
    }

    // Rebuild funding graph
    for (const [deployer, funders] of Object.entries(data.fundingGraph ?? {})) {
      this.fundingGraph.set(deployer, new Set(funders as string[]));
    }

    logger.info('Deployer intelligence loaded', {
      profiles: this.profiles.size,
      graphEdges: this.fundingGraph.size,
    });
  }

  /**
   * Analyze a deployer on-chain — called when new pool detected
   */
  async analyzeDeployer(deployerAddress: string): Promise<DeployerProfile> {
    const existing = this.profiles.get(deployerAddress);

    // If recently analyzed (within 1 hour), return cached
    if (existing && (Date.now() - existing.lastUpdated.getTime()) < 3_600_000) {
      return existing;
    }

    logger.info('Analyzing deployer on-chain', { deployer: deployerAddress });

    try {
      const pubkey = new PublicKey(deployerAddress);

      // 1. Get account info (wallet age proxy)
      const accountInfo = await this.connection.getAccountInfo(pubkey);
      const balance = accountInfo?.lamports ?? 0;

      // 2. Get transaction history (limited)
      const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit: 100 });
      const txCount = signatures.length;

      // Estimate wallet age from oldest transaction
      const oldestTx = signatures.length > 0 ? signatures[signatures.length - 1] : null;
      const walletAgeDays = oldestTx?.blockTime
        ? (Date.now() / 1000 - oldestTx.blockTime) / 86400
        : 0;

      // 3. Detect fresh wallets (high risk)
      const isFreshWallet = walletAgeDays < 7;

      // 4. Analyze funding sources
      const fundingSources = await this.analyzeFundingSources(deployerAddress, signatures);

      // 5. Check for links to known deployers
      const { isLinked, linkedDeployers } = this.checkLinksToKnown(fundingSources);

      // Build or update profile
      const profile: DeployerProfile = {
        address: deployerAddress,
        tier: 'UNKNOWN',
        confidence: 0,
        totalLaunches: (existing?.totalLaunches ?? 0) + 1,
        successfulLaunches: existing?.successfulLaunches ?? 0,
        ruggedLaunches: existing?.ruggedLaunches ?? 0,
        avgPeakMultiple: existing?.avgPeakMultiple ?? 0,
        avgTimeToRug: existing?.avgTimeToRug ?? 0,
        walletAgeDays,
        fundingSources: Array.from(fundingSources),
        isLinkedToKnownDeployer: isLinked,
        linkedDeployers,
        totalFundingSOL: balance / 1e9,
        lpRemovalRate: existing?.lpRemovalRate ?? 0,
        mintAuthRevokeRate: existing?.mintAuthRevokeRate ?? 0,
        freezeAuthRevokeRate: existing?.freezeAuthRevokeRate ?? 0,
        avgTopHolderPct: existing?.avgTopHolderPct ?? 0,
        reputationScore: 0,
        lastUpdated: new Date(),
        lastLaunchTimestamp: new Date(),
      };

      // Calculate reputation score
      profile.reputationScore = this.calculateReputationScore(profile, isFreshWallet);
      profile.tier = this.scoreTier(profile.reputationScore, profile.totalLaunches);
      profile.confidence = this.calculateConfidence(profile);

      this.profiles.set(deployerAddress, profile);
      this.updateFundingGraph(deployerAddress, fundingSources);

      // Auto-save periodically
      if (this.profiles.size % 10 === 0) {
        this.save();
      }

      logger.info('Deployer analyzed', {
        address: deployerAddress.slice(0, 8) + '...',
        tier: profile.tier,
        score: profile.reputationScore,
        confidence: profile.confidence.toFixed(2),
        walletAgeDays: walletAgeDays.toFixed(1),
        isFresh: isFreshWallet,
        linkedToKnown: isLinked,
        totalLaunches: profile.totalLaunches,
      });

      return profile;
    } catch (err) {
      logger.error('Deployer analysis failed', {
        deployer: deployerAddress,
        error: (err as Error).message,
      });

      // Return existing or default
      return existing ?? this.createDefaultProfile(deployerAddress);
    }
  }

  /**
   * Record outcome of a launch for a deployer (called post-trade)
   */
  recordLaunchOutcome(
    deployerAddress: string,
    peakMultiple: number,
    wasRugged: boolean,
    lpRemoved: boolean,
    mintAuthRevoked: boolean,
    freezeAuthRevoked: boolean,
    topHolderPct: number,
    timeToEventMs: number
  ): void {
    const profile = this.profiles.get(deployerAddress) ?? this.createDefaultProfile(deployerAddress);

    if (peakMultiple > 2.0) {
      profile.successfulLaunches++;
    }
    if (wasRugged) {
      profile.ruggedLaunches++;
    }

    // Running averages
    const n = profile.totalLaunches;
    profile.avgPeakMultiple = ((profile.avgPeakMultiple * (n - 1)) + peakMultiple) / n;
    profile.lpRemovalRate = lpRemoved
      ? profile.lpRemovalRate + (1 - profile.lpRemovalRate) / n
      : profile.lpRemovalRate - profile.lpRemovalRate / n;
    profile.mintAuthRevokeRate = mintAuthRevoked
      ? profile.mintAuthRevokeRate + (1 - profile.mintAuthRevokeRate) / n
      : profile.mintAuthRevokeRate - profile.mintAuthRevokeRate / n;
    profile.freezeAuthRevokeRate = freezeAuthRevoked
      ? profile.freezeAuthRevokeRate + (1 - profile.freezeAuthRevokeRate) / n
      : profile.freezeAuthRevokeRate - profile.freezeAuthRevokeRate / n;
    profile.avgTopHolderPct = ((profile.avgTopHolderPct * (n - 1)) + topHolderPct) / n;

    if (wasRugged && timeToEventMs > 0) {
      profile.avgTimeToRug = ((profile.avgTimeToRug * (profile.ruggedLaunches - 1)) + timeToEventMs) / profile.ruggedLaunches;
    }

    // Recalculate tier
    profile.reputationScore = this.calculateReputationScore(profile, profile.walletAgeDays < 7);
    profile.tier = this.scoreTier(profile.reputationScore, profile.totalLaunches);
    profile.confidence = this.calculateConfidence(profile);
    profile.lastUpdated = new Date();

    this.profiles.set(deployerAddress, profile);

    logger.info('Deployer outcome recorded', {
      address: deployerAddress.slice(0, 8) + '...',
      peakMultiple: peakMultiple.toFixed(2),
      wasRugged,
      newTier: profile.tier,
      newScore: profile.reputationScore,
      successRate: profile.totalLaunches > 0
        ? ((profile.successfulLaunches / profile.totalLaunches) * 100).toFixed(0) + '%'
        : 'N/A',
    });
  }

  /**
   * Get tier for a deployer address
   */
  getTier(address: string): DeployerTier {
    return this.profiles.get(address)?.tier ?? 'UNKNOWN';
  }

  getProfile(address: string): DeployerProfile | null {
    return this.profiles.get(address) ?? null;
  }

  /**
   * Get deployers in the same funding cluster
   */
  getLinkedDeployers(address: string): string[] {
    const funders = this.fundingGraph.get(address);
    if (!funders) return [];

    const linked: Set<string> = new Set();
    for (const [deployer, deployerFunders] of this.fundingGraph) {
      if (deployer === address) continue;
      for (const funder of deployerFunders) {
        if (funders.has(funder)) {
          linked.add(deployer);
          break;
        }
      }
    }

    return Array.from(linked);
  }

  count(): number {
    return this.profiles.size;
  }

  getRankedDeployers(): DeployerProfile[] {
    return Array.from(this.profiles.values())
      .sort((a, b) => b.reputationScore - a.reputationScore);
  }

  // ── PRIVATE METHODS ─────────────────────────────────────

  private calculateReputationScore(profile: DeployerProfile, isFreshWallet: boolean): number {
    let score = 50; // baseline

    // Success rate (max +30)
    if (profile.totalLaunches >= this.MIN_LAUNCHES_FOR_TIER) {
      const successRate = profile.successfulLaunches / profile.totalLaunches;
      score += successRate * 30;

      // Rug penalty (max -40)
      const rugRate = profile.ruggedLaunches / profile.totalLaunches;
      score -= rugRate * 40;
    }

    // Peak multiple bonus (max +15)
    score += Math.min(15, profile.avgPeakMultiple * 3);

    // LP removal penalty (max -20)
    score -= profile.lpRemovalRate * 20;

    // Auth revocation bonus
    score += profile.mintAuthRevokeRate * 5;
    score += profile.freezeAuthRevokeRate * 5;

    // Top holder concentration penalty
    if (profile.avgTopHolderPct > 0.5) score -= 15;
    else if (profile.avgTopHolderPct > 0.3) score -= 8;

    // Fresh wallet penalty
    if (isFreshWallet) score -= 20;

    // Linked to known deployer bonus/penalty
    if (profile.isLinkedToKnownDeployer) {
      const linkedProfiles = profile.linkedDeployers
        .map(a => this.profiles.get(a))
        .filter((p): p is DeployerProfile => p !== undefined);

      const avgLinkedScore = linkedProfiles.length > 0
        ? linkedProfiles.reduce((s, p) => s + p.reputationScore, 0) / linkedProfiles.length
        : 50;

      // Inherit some reputation from linked deployers
      score = score * 0.7 + avgLinkedScore * 0.3;
    }

    // Wallet age bonus (log scale)
    if (profile.walletAgeDays > 180) score += 5;
    else if (profile.walletAgeDays > 30) score += 3;

    return Math.max(0, Math.min(100, score));
  }

  private scoreTier(score: number, totalLaunches: number): DeployerTier {
    // Need minimum launches for confident tiering
    if (totalLaunches < this.MIN_LAUNCHES_FOR_TIER) return 'UNKNOWN';

    if (score >= this.S_TIER_MIN_SCORE) return 'S';
    if (score >= this.A_TIER_MIN_SCORE) return 'A';
    if (score >= this.B_TIER_MIN_SCORE) return 'B';
    if (score <= this.BLACKLIST_MAX_SCORE) return 'BLACKLIST';
    return 'BLACKLIST';  // Below B threshold = blacklist, not default B
  }

  private calculateConfidence(profile: DeployerProfile): number {
    // More data = more confidence
    const launchConfidence = Math.min(1, profile.totalLaunches / 10);
    const ageConfidence = Math.min(1, profile.walletAgeDays / 90);

    return (launchConfidence * 0.5 + ageConfidence * 0.5);
  }

  private async analyzeFundingSources(
    deployerAddress: string,
    signatures: { signature: string; blockTime?: number | null }[]
  ): Promise<Set<string>> {
    const funders = new Set<string>();

    // Look at earliest transactions (likely funding transactions)
    const earlyTxs = signatures.slice(-10); // oldest 10

    for (const sig of earlyTxs.slice(0, 3)) { // Only check first 3 to save RPC calls
      try {
        const tx = await this.connection.getParsedTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
        });

        if (!tx?.transaction?.message?.accountKeys) continue;

        // Find SOL transfers into this deployer
        for (const key of tx.transaction.message.accountKeys) {
          const addr = key.pubkey.toBase58();
          if (addr !== deployerAddress && key.signer) {
            funders.add(addr);
          }
        }
      } catch {
        // Skip failed fetches
      }
    }

    return funders;
  }

  private checkLinksToKnown(fundingSources: Set<string>): { isLinked: boolean; linkedDeployers: string[] } {
    const linked: string[] = [];

    for (const [deployer, funders] of this.fundingGraph) {
      for (const source of fundingSources) {
        if (funders.has(source)) {
          linked.push(deployer);
          break;
        }
      }
    }

    return { isLinked: linked.length > 0, linkedDeployers: linked };
  }

  private updateFundingGraph(deployerAddress: string, fundingSources: Set<string>): void {
    const existing = this.fundingGraph.get(deployerAddress) ?? new Set();
    for (const source of fundingSources) {
      existing.add(source);
    }
    this.fundingGraph.set(deployerAddress, existing);
  }

  private createDefaultProfile(address: string): DeployerProfile {
    return {
      address,
      tier: 'UNKNOWN',
      confidence: 0,
      totalLaunches: 1,
      successfulLaunches: 0,
      ruggedLaunches: 0,
      avgPeakMultiple: 0,
      avgTimeToRug: 0,
      walletAgeDays: 0,
      fundingSources: [],
      isLinkedToKnownDeployer: false,
      linkedDeployers: [],
      totalFundingSOL: 0,
      lpRemovalRate: 0,
      mintAuthRevokeRate: 0,
      freezeAuthRevokeRate: 0,
      avgTopHolderPct: 0,
      reputationScore: 50,
      lastUpdated: new Date(),
      lastLaunchTimestamp: new Date(),
    };
  }

  save(): void {
    const data = {
      profiles: Array.from(this.profiles.values()),
      fundingGraph: Object.fromEntries(
        Array.from(this.fundingGraph.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      savedAt: new Date().toISOString(),
    };

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
