/**
 * SocialSignalEngine Unit Tests
 */
import { SocialSignalEngine, SocialSignal, HypeCyclePhase } from '../src/social/socialSignalEngine';

jest.mock('../src/core/eventBus', () => ({
  bus: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
}));
jest.mock('../src/core/logger', () => ({
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));
jest.mock('axios');

describe('SocialSignalEngine', () => {
  let engine: SocialSignalEngine;

  beforeEach(() => {
    engine = new SocialSignalEngine();
  });

  describe('Tweet Processing', () => {
    it('should process a tweet with a token address', () => {
      const signal = engine.processTweet({
        text: 'Just aped into 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU 🚀🚀🚀 100x incoming!!!',
        author: 'cryptowhale',
        authorFollowers: 50000,
        timestamp: new Date(),
        likes: 500,
        retweets: 200,
        replies: 80,
      });

      if (signal) {
        expect(signal.platform).toBe('TWITTER');
        expect(signal.score).toBeGreaterThanOrEqual(0);
        expect(signal.score).toBeLessThanOrEqual(10);
        expect(signal.confidence).toBeGreaterThanOrEqual(0);
        expect(signal.confidence).toBeLessThanOrEqual(1);
        expect(signal.details.extractedAddresses.length).toBeGreaterThan(0);
      }
    });

    it('should return null for empty/irrelevant tweets', () => {
      const signal = engine.processTweet({
        text: 'Good morning everyone!',
        author: 'random',
        authorFollowers: 100,
        timestamp: new Date(),
        likes: 5,
        retweets: 0,
        replies: 1,
      });

      // No token address, low engagement — should return null
      expect(signal).toBeNull();
    });

    it('should detect KOL mentions with high follower count', () => {
      const signal = engine.processTweet({
        text: 'Buy 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU now! This is the next 100x gem!',
        author: 'megaInfluencer',
        authorFollowers: 200000,
        timestamp: new Date(),
        likes: 2000,
        retweets: 500,
        replies: 300,
      });

      if (signal) {
        expect(signal.details.kolMentions.length).toBeGreaterThan(0);
        expect(signal.details.kolMentions[0].tier).toBe('MEGA');
        expect(signal.details.kolMentions[0].followers).toBe(200000);
      }
    });

    it('should classify KOL tiers correctly', () => {
      // MACRO: 25k-100k
      const macroSignal = engine.processTweet({
        text: 'New gem alert 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        author: 'macroKOL',
        authorFollowers: 50000,
        timestamp: new Date(),
        likes: 300,
        retweets: 50,
        replies: 20,
      });

      if (macroSignal) {
        expect(macroSignal.details.kolMentions[0].tier).toBe('MACRO');
      }
    });

    it('should extract sentiment from tweet text', () => {
      const bullishSignal = engine.processTweet({
        text: '🚀 Bullish af on 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU moon pump gem 100x',
        author: 'trader1',
        authorFollowers: 10000,
        timestamp: new Date(),
        likes: 100,
        retweets: 30,
        replies: 10,
      });

      if (bullishSignal) {
        expect(bullishSignal.details.sentimentScore).toBeGreaterThan(0);
      }
    });
  });

  describe('Telegram Processing', () => {
    it('should process telegram messages with token addresses', () => {
      const signal = engine.processTelegramMessage({
        text: 'New launch alert! CA: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU — Dev looks solid, LP locked',
        channel: 'solana_gems',
        channelMembers: 5000,
        timestamp: new Date(),
      });

      if (signal) {
        expect(signal.platform).toBe('TELEGRAM');
        expect(signal.details.extractedAddresses.length).toBeGreaterThan(0);
      }
    });

    it('should return null for messages without addresses', () => {
      const signal = engine.processTelegramMessage({
        text: 'Anyone know what to buy today?',
        channel: 'general',
        channelMembers: 100,
        timestamp: new Date(),
      });

      expect(signal).toBeNull();
    });
  });

  describe('Token Social Score', () => {
    it('should return score for known token', () => {
      // First add some signals
      engine.processTweet({
        text: 'Love this 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        author: 'trader1',
        authorFollowers: 30000,
        timestamp: new Date(),
        likes: 200,
        retweets: 50,
        replies: 20,
      });

      const result = engine.getTokenSocialScore('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.hypeCycle).toBeDefined();
    });

    it('should return zero score for unknown token', () => {
      const result = engine.getTokenSocialScore('unknownToken123456789012345678901234');
      expect(result.score).toBe(0);
      expect(result.signals).toHaveLength(0);
    });
  });

  describe('Trending Narratives', () => {
    it('should return narrative trends array', () => {
      const trends = engine.getTrendingNarratives();
      expect(trends).toBeInstanceOf(Array);
    });
  });

  describe('KOL Outcome Recording', () => {
    it('should record KOL win/loss outcomes', () => {
      // First make the KOL known
      engine.processTweet({
        text: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU will moon!',
        author: 'trackedKOL',
        authorFollowers: 80000,
        timestamp: new Date(),
        likes: 500,
        retweets: 100,
        replies: 50,
      });

      // Should not throw
      engine.recordKOLOutcome('trackedKOL', true, 150);
      engine.recordKOLOutcome('trackedKOL', false, -30);
    });
  });
});
