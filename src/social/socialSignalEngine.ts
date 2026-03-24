/**
 * ═══════════════════════════════════════════════════════════════
 *  SOCIAL SIGNAL NLP PIPELINE
 * ═══════════════════════════════════════════════════════════════
 * 
 * Implements:
 * 1. Twitter/CT sentiment analysis with wallet extraction
 * 2. KOL influence scoring and trade detection
 * 3. Telegram group velocity tracking
 * 4. Cross-platform confirmation signals
 * 5. Narrative trend detection
 * 6. Hype cycle classification
 */

import { bus } from '../core/eventBus';
import { logger } from '../core/logger';
import axios from 'axios';

// ── TYPES ─────────────────────────────────────────────────

export interface SocialSignal {
  tokenCA: string;
  platform: 'TWITTER' | 'TELEGRAM' | 'DISCORD';
  signalType: 'KOL_CALL' | 'MOMENTUM' | 'SENTIMENT' | 'ALERT' | 'RUG_WARNING';
  score: number;                  // 0-10
  confidence: number;             // 0-1
  details: SocialDetails;
  timestamp: Date;
}

export interface SocialDetails {
  // Twitter
  tweetCount: number;
  uniqueAuthors: number;
  kolMentions: KOLMention[];
  sentimentScore: number;         // -1 to 1
  velocityPerHour: number;        // mentions/hour acceleration

  // Telegram
  telegramChannels: number;
  telegramMessages: number;
  telegramVelocity: number;

  // Cross-platform
  crossPlatformConfirmed: boolean;
  platformsActive: string[];

  // Extracted data
  extractedAddresses: string[];   // wallet/contract addresses found
  narrativeKeywords: string[];

  // Hype cycle
  hypeCyclePhase: HypeCyclePhase;
}

export type HypeCyclePhase = 'DISCOVERY' | 'EARLY_MOMENTUM' | 'PEAK_HYPE' | 'PLATEAU' | 'DECLINE';

export interface KOLMention {
  handle: string;
  tier: 'MEGA' | 'MACRO' | 'MICRO' | 'NANO';
  followers: number;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  hasCallout: boolean;            // explicit "buy this" signal
  timestamp: Date;
}

export interface KOLProfile {
  handle: string;
  tier: KOLMention['tier'];
  followers: number;
  historicalAccuracy: number;     // 0-1 past callout win rate
  avgReturnOnCallout: number;     // % average return after callout
  totalCallouts: number;
  winningCallouts: number;
  lastActive: Date;
}

export interface NarrativeTrend {
  keyword: string;
  mentionCount: number;
  velocityChange: number;         // acceleration
  relatedTokens: string[];
  phase: HypeCyclePhase;
  detectedAt: Date;
}

// ── SOCIAL SIGNAL ENGINE ──────────────────────────────────

export class SocialSignalEngine {
  private kolProfiles: Map<string, KOLProfile> = new Map();
  private tokenMentions: Map<string, { timestamp: Date; platform: string; author: string }[]> = new Map();
  private narrativeTrends: Map<string, NarrativeTrend> = new Map();
  private signalHistory: SocialSignal[] = [];

  // Solana address pattern
  private readonly ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  // KOL tier thresholds
  private readonly KOL_TIERS = {
    MEGA: 100_000,
    MACRO: 25_000,
    MICRO: 5_000,
    NANO: 1_000,
  };

  constructor() {
    // Initialize known KOLs (can be loaded from file)
    this.initializeKnownKOLs();
  }

  /**
   * Process a tweet and extract signals
   */
  processTweet(tweet: {
    text: string;
    author: string;
    authorFollowers: number;
    timestamp: Date;
    likes: number;
    retweets: number;
    replies: number;
  }): SocialSignal | null {
    // 1. Extract contract addresses
    const addresses = this.extractAddresses(tweet.text);
    if (addresses.length === 0) return null;

    const tokenCA = addresses[0]; // primary CA

    // 2. Sentiment analysis
    const sentiment = this.analyzeSentiment(tweet.text);

    // 3. KOL detection
    const kolTier = this.getKOLTier(tweet.authorFollowers);
    const isCallout = this.detectCallout(tweet.text);

    // 4. Track mention velocity
    this.recordMention(tokenCA, 'TWITTER', tweet.author, tweet.timestamp);
    const velocity = this.calculateVelocity(tokenCA);

    // 5. Extract narrative keywords
    const keywords = this.extractNarrativeKeywords(tweet.text);

    // 6. Calculate signal score
    let score = 0;

    // KOL factor
    if (kolTier === 'MEGA') score += 4;
    else if (kolTier === 'MACRO') score += 3;
    else if (kolTier === 'MICRO') score += 2;
    else score += 0.5;

    // Explicit callout bonus
    if (isCallout) score += 2;

    // Sentiment factor
    if (sentiment > 0.5) score += 1;
    else if (sentiment < -0.3) score -= 2;

    // Engagement factor (viral threshold)
    const engagement = tweet.likes + tweet.retweets * 2 + tweet.replies * 0.5;
    if (engagement > 1000) score += 2;
    else if (engagement > 200) score += 1;

    // Velocity factor
    if (velocity > 10) score += 1;

    score = Math.max(0, Math.min(10, score));

    // Check cross-platform confirmation
    const telegramMentions = this.getTelegramMentionCount(tokenCA);
    const crossConfirmed = telegramMentions > 0;

    if (crossConfirmed) score = Math.min(10, score + 1.5);

    // Determine hype cycle phase
    const hypeCycle = this.classifyHypeCycle(tokenCA);

    const signal: SocialSignal = {
      tokenCA,
      platform: 'TWITTER',
      signalType: isCallout ? 'KOL_CALL' : velocity > 20 ? 'MOMENTUM' : 'SENTIMENT',
      score,
      confidence: Math.min(1, (tweet.authorFollowers / 50000) * 0.5 + (crossConfirmed ? 0.3 : 0) + 0.2),
      details: {
        tweetCount: this.getMentionCount(tokenCA, 'TWITTER'),
        uniqueAuthors: this.getUniqueAuthors(tokenCA, 'TWITTER'),
        kolMentions: [{
          handle: tweet.author,
          tier: kolTier,
          followers: tweet.authorFollowers,
          sentiment: sentiment > 0.2 ? 'BULLISH' : sentiment < -0.2 ? 'BEARISH' : 'NEUTRAL',
          hasCallout: isCallout,
          timestamp: tweet.timestamp,
        }],
        sentimentScore: sentiment,
        velocityPerHour: velocity,
        telegramChannels: telegramMentions,
        telegramMessages: 0,
        telegramVelocity: 0,
        crossPlatformConfirmed: crossConfirmed,
        platformsActive: crossConfirmed ? ['TWITTER', 'TELEGRAM'] : ['TWITTER'],
        extractedAddresses: addresses,
        narrativeKeywords: keywords,
        hypeCyclePhase: hypeCycle,
      },
      timestamp: tweet.timestamp,
    };

    this.signalHistory.push(signal);
    if (this.signalHistory.length > 1000) this.signalHistory.shift();

    // Update KOL profile
    this.updateKOLProfile(tweet.author, tweet.authorFollowers, isCallout);

    // Update narrative trends
    for (const keyword of keywords) {
      this.updateNarrativeTrend(keyword, tokenCA);
    }

    return signal;
  }

  /**
   * Process a Telegram message
   */
  processTelegramMessage(msg: {
    text: string;
    channel: string;
    channelMembers: number;
    timestamp: Date;
  }): SocialSignal | null {
    const addresses = this.extractAddresses(msg.text);
    if (addresses.length === 0) return null;

    const tokenCA = addresses[0];
    const sentiment = this.analyzeSentiment(msg.text);

    this.recordMention(tokenCA, 'TELEGRAM', msg.channel, msg.timestamp);
    const velocity = this.calculateVelocity(tokenCA);

    const twitterMentions = this.getMentionCount(tokenCA, 'TWITTER');
    const crossConfirmed = twitterMentions > 0;

    let score = 0;
    score += Math.min(3, msg.channelMembers / 10000); // larger channels = more signal
    if (sentiment > 0.3) score += 1;
    if (velocity > 15) score += 2;
    if (crossConfirmed) score += 2;

    score = Math.max(0, Math.min(10, score));

    return {
      tokenCA,
      platform: 'TELEGRAM',
      signalType: velocity > 20 ? 'MOMENTUM' : 'ALERT',
      score,
      confidence: Math.min(1, (msg.channelMembers / 20000) * 0.4 + (crossConfirmed ? 0.4 : 0) + 0.2),
      details: {
        tweetCount: twitterMentions,
        uniqueAuthors: this.getUniqueAuthors(tokenCA, 'TELEGRAM'),
        kolMentions: [],
        sentimentScore: sentiment,
        velocityPerHour: velocity,
        telegramChannels: this.getUniqueAuthors(tokenCA, 'TELEGRAM'),
        telegramMessages: this.getMentionCount(tokenCA, 'TELEGRAM'),
        telegramVelocity: velocity,
        crossPlatformConfirmed: crossConfirmed,
        platformsActive: crossConfirmed ? ['TWITTER', 'TELEGRAM'] : ['TELEGRAM'],
        extractedAddresses: addresses,
        narrativeKeywords: this.extractNarrativeKeywords(msg.text),
        hypeCyclePhase: this.classifyHypeCycle(tokenCA),
      },
      timestamp: msg.timestamp,
    };
  }

  /**
   * Get aggregate social score for a token
   */
  getTokenSocialScore(tokenCA: string): {
    score: number;
    confidence: number;
    signals: SocialSignal[];
    narrative: string;
    hypeCycle: HypeCyclePhase;
  } {
    const recentSignals = this.signalHistory.filter(
      s => s.tokenCA === tokenCA && s.timestamp.getTime() > Date.now() - 3_600_000
    );

    if (recentSignals.length === 0) {
      return { score: 0, confidence: 0, signals: [], narrative: 'UNKNOWN', hypeCycle: 'DISCOVERY' };
    }

    // Aggregate: weighted average of signal scores
    const totalWeight = recentSignals.reduce((s, sig) => s + sig.confidence, 0);
    const weightedScore = recentSignals.reduce((s, sig) => s + sig.score * sig.confidence, 0);
    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

    // Confidence: more signals from more sources = more confident
    const platforms = new Set(recentSignals.map(s => s.platform));
    const confidence = Math.min(1,
      recentSignals.length * 0.1 +
      platforms.size * 0.2 +
      (totalWeight / recentSignals.length) * 0.3
    );

    // Find dominant narrative
    const keywords = recentSignals.flatMap(s => s.details.narrativeKeywords);
    const keywordCounts = new Map<string, number>();
    for (const kw of keywords) {
      keywordCounts.set(kw, (keywordCounts.get(kw) ?? 0) + 1);
    }
    const topKeyword = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';

    return {
      score: Math.min(10, score),
      confidence,
      signals: recentSignals,
      narrative: topKeyword,
      hypeCycle: this.classifyHypeCycle(tokenCA),
    };
  }

  /**
   * Get trending narratives
   */
  getTrendingNarratives(): NarrativeTrend[] {
    return Array.from(this.narrativeTrends.values())
      .filter(t => t.detectedAt.getTime() > Date.now() - 3_600_000)
      .sort((a, b) => b.velocityChange - a.velocityChange)
      .slice(0, 10);
  }

  /**
   * Record KOL callout outcome for accuracy tracking
   */
  recordKOLOutcome(handle: string, won: boolean, returnPct: number): void {
    const profile = this.kolProfiles.get(handle.toLowerCase());
    if (!profile) return;

    if (won) profile.winningCallouts++;
    profile.historicalAccuracy = profile.totalCallouts > 0
      ? profile.winningCallouts / profile.totalCallouts : 0;
    profile.avgReturnOnCallout = profile.totalCallouts > 0
      ? ((profile.avgReturnOnCallout * (profile.totalCallouts - 1)) + returnPct) / profile.totalCallouts
      : returnPct;

    this.kolProfiles.set(handle.toLowerCase(), profile);
  }

  // ── PRIVATE METHODS ─────────────────────────────────────

  private extractAddresses(text: string): string[] {
    const matches = text.match(this.ADDRESS_REGEX) ?? [];
    // Filter to likely Solana addresses (base58, 32-44 chars)
    return [...new Set(matches.filter(a => a.length >= 32 && a.length <= 44))];
  }

  private analyzeSentiment(text: string): number {
    const lower = text.toLowerCase();

    // Bullish keywords
    const bullish = ['moon', 'pump', 'bullish', 'gem', 'alpha', 'ape', 'buy', 'long',
      'send it', 'LFG', 'based', 'chad', 'diamond hands', 'rocket', '100x', '10x',
      'early', 'degen', 'conviction', 'undervalued', 'breakout', 'trending'];
    const bearish = ['dump', 'rug', 'scam', 'sell', 'short', 'bear', 'dead', 'over',
      'avoid', 'honeypot', 'fraud', 'crash', 'rekt', 'down bad', 'exit liquidity',
      'fake', 'wash', 'manipulation'];

    let score = 0;
    for (const word of bullish) {
      if (lower.includes(word)) score += 0.15;
    }
    for (const word of bearish) {
      if (lower.includes(word)) score -= 0.2;
    }

    // Emoji sentiment boost
    const rocketCount = (text.match(/🚀/g) ?? []).length;
    const fireCount = (text.match(/🔥/g) ?? []).length;
    score += (rocketCount + fireCount) * 0.1;

    return Math.max(-1, Math.min(1, score));
  }

  private detectCallout(text: string): boolean {
    const lower = text.toLowerCase();
    const calloutPhrases = [
      'ape in', 'buy now', 'god candle', 'send it', 'just loaded',
      'new position', 'entry here', 'alerted at', 'my bag', 'accumulating',
      'don\'t miss', 'still early', 'CT is sleeping', 'NFA but', 'DYOR',
    ];
    return calloutPhrases.some(phrase => lower.includes(phrase));
  }

  private getKOLTier(followers: number): KOLMention['tier'] {
    if (followers >= this.KOL_TIERS.MEGA) return 'MEGA';
    if (followers >= this.KOL_TIERS.MACRO) return 'MACRO';
    if (followers >= this.KOL_TIERS.MICRO) return 'MICRO';
    return 'NANO';
  }

  private recordMention(tokenCA: string, platform: string, author: string, timestamp: Date): void {
    const mentions = this.tokenMentions.get(tokenCA) ?? [];
    mentions.push({ timestamp, platform, author });

    // Keep last 2 hours
    const cutoff = Date.now() - 7_200_000;
    const filtered = mentions.filter(m => m.timestamp.getTime() > cutoff);
    this.tokenMentions.set(tokenCA, filtered);
  }

  private calculateVelocity(tokenCA: string): number {
    const mentions = this.tokenMentions.get(tokenCA) ?? [];
    const lastHour = mentions.filter(m => m.timestamp.getTime() > Date.now() - 3_600_000);
    return lastHour.length; // mentions per hour
  }

  private getMentionCount(tokenCA: string, platform: string): number {
    const mentions = this.tokenMentions.get(tokenCA) ?? [];
    return mentions.filter(m => m.platform === platform && m.timestamp.getTime() > Date.now() - 3_600_000).length;
  }

  private getUniqueAuthors(tokenCA: string, platform: string): number {
    const mentions = this.tokenMentions.get(tokenCA) ?? [];
    const authors = new Set(
      mentions
        .filter(m => m.platform === platform && m.timestamp.getTime() > Date.now() - 3_600_000)
        .map(m => m.author)
    );
    return authors.size;
  }

  private getTelegramMentionCount(tokenCA: string): number {
    return this.getMentionCount(tokenCA, 'TELEGRAM');
  }

  private classifyHypeCycle(tokenCA: string): HypeCyclePhase {
    const mentions = this.tokenMentions.get(tokenCA) ?? [];
    if (mentions.length < 3) return 'DISCOVERY';

    const now = Date.now();
    const last15m = mentions.filter(m => m.timestamp.getTime() > now - 900_000).length;
    const last1h = mentions.filter(m => m.timestamp.getTime() > now - 3_600_000).length;
    const last2h = mentions.filter(m => m.timestamp.getTime() > now - 7_200_000).length;

    // Velocity increasing
    const recentVelocity = last15m * 4; // annualized to hourly
    const hourlyVelocity = last1h;

    if (last1h <= 3) return 'DISCOVERY';
    if (recentVelocity > hourlyVelocity * 1.5) return 'EARLY_MOMENTUM';
    if (last1h > 20 && recentVelocity >= hourlyVelocity * 0.8) return 'PEAK_HYPE';
    if (recentVelocity < hourlyVelocity * 0.5 && last1h > 10) return 'DECLINE';
    return 'PLATEAU';
  }

  private extractNarrativeKeywords(text: string): string[] {
    const lower = text.toLowerCase();
    const narrativeKeywords = [
      'ai', 'dog', 'cat', 'meme', 'defi', 'gaming', 'nft', 'metaverse',
      'trump', 'elon', 'politics', 'rwa', 'desci', 'depin', 'social',
      'pepe', 'wojak', 'frog', 'degen', 'culture', 'music', 'art',
      'yield', 'staking', 'lending', 'governance', 'L2', 'bridge',
    ];

    return narrativeKeywords.filter(kw => lower.includes(kw));
  }

  private updateKOLProfile(handle: string, followers: number, isCallout: boolean): void {
    const key = handle.toLowerCase();
    const existing = this.kolProfiles.get(key);

    if (existing) {
      existing.followers = followers;
      existing.lastActive = new Date();
      if (isCallout) existing.totalCallouts++;
      this.kolProfiles.set(key, existing);
    } else {
      this.kolProfiles.set(key, {
        handle,
        tier: this.getKOLTier(followers),
        followers,
        historicalAccuracy: 0,
        avgReturnOnCallout: 0,
        totalCallouts: isCallout ? 1 : 0,
        winningCallouts: 0,
        lastActive: new Date(),
      });
    }
  }

  private updateNarrativeTrend(keyword: string, tokenCA: string): void {
    const existing = this.narrativeTrends.get(keyword);

    if (existing) {
      existing.mentionCount++;
      const prevVelocity = existing.velocityChange;
      existing.velocityChange = existing.mentionCount; // simplified
      if (!existing.relatedTokens.includes(tokenCA)) {
        existing.relatedTokens.push(tokenCA);
        if (existing.relatedTokens.length > 50) existing.relatedTokens.shift();
      }
    } else {
      this.narrativeTrends.set(keyword, {
        keyword,
        mentionCount: 1,
        velocityChange: 1,
        relatedTokens: [tokenCA],
        phase: 'DISCOVERY',
        detectedAt: new Date(),
      });
    }
  }

  private initializeKnownKOLs(): void {
    // Placeholder — in production, load from file
    // Known CT influencers with historical accuracy tracking
  }
}
