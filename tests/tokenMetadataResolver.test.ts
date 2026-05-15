import { TokenMetadataResolver, type HeliusClient } from '../src/safety/tokenMetadataResolver';

function makeMockHelius(getAssetImpl: jest.Mock): HeliusClient {
  return { getAsset: getAssetImpl } as unknown as HeliusClient;
}

describe('TokenMetadataResolver', () => {
  describe('resolution outcomes', () => {
    it('returns the name when Helius returns metadata', async () => {
      const helius = makeMockHelius(
        jest.fn().mockResolvedValue({
          content: { metadata: { name: 'Real Token' } },
        }),
      );
      const resolver = new TokenMetadataResolver(helius);

      const result = await resolver.resolveName('mint1');

      expect(result).toBe('Real Token');
    });

    it('returns null when Helius returns no content (asset has no metadata)', async () => {
      const helius = makeMockHelius(
        jest.fn().mockResolvedValue({}),
      );
      const resolver = new TokenMetadataResolver(helius);

      const result = await resolver.resolveName('mint1');

      expect(result).toBeNull();
    });

    it('returns undefined when Helius throws (network error)', async () => {
      const helius = makeMockHelius(
        jest.fn().mockRejectedValue(new Error('econnreset')),
      );
      const resolver = new TokenMetadataResolver(helius);

      const result = await resolver.resolveName('mint1');

      expect(result).toBeUndefined();
    });

    it('returns undefined on timeout (>2s)', async () => {
      jest.useFakeTimers();
      const helius = makeMockHelius(
        jest.fn().mockImplementation(() => new Promise(() => { /* hang */ })),
      );
      const resolver = new TokenMetadataResolver(helius);

      const promise = resolver.resolveName('mint1');
      jest.advanceTimersByTime(2001);

      const result = await promise;
      expect(result).toBeUndefined();
      jest.useRealTimers();
    });
  });

  describe('caching', () => {
    it('serves repeat lookups from cache (no second Helius call)', async () => {
      const mock = jest.fn().mockResolvedValue({
        content: { metadata: { name: 'Cached Token' } },
      });
      const resolver = new TokenMetadataResolver(makeMockHelius(mock));

      await resolver.resolveName('mint1');
      await resolver.resolveName('mint1');

      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('caches null results (no re-fetch for tokens without metadata)', async () => {
      const mock = jest.fn().mockResolvedValue({});
      const resolver = new TokenMetadataResolver(makeMockHelius(mock));

      await resolver.resolveName('mint1');
      await resolver.resolveName('mint1');

      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('does NOT cache failures (next call retries)', async () => {
      const mock = jest
        .fn()
        .mockRejectedValueOnce(new Error('network'))
        .mockResolvedValueOnce({
          content: { metadata: { name: 'Recovered' } },
        });
      const resolver = new TokenMetadataResolver(makeMockHelius(mock));

      const first = await resolver.resolveName('mint1');
      const second = await resolver.resolveName('mint1');

      expect(first).toBeUndefined();
      expect(second).toBe('Recovered');
      expect(mock).toHaveBeenCalledTimes(2);
    });
  });
});
