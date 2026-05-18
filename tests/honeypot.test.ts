import axios from 'axios';
import { checkHoneypot, checkHoneypotWithDeferredProbe } from '../src/safety/honeypot';
import { AntifragileEngine } from '../src/antifragile/antifragileEngine';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const TOKEN_CA = '6Aixvhgirbn8rHmAtFnwHNBqgxtenKDz8ycvHeQepump';
const TEST_AMOUNT = 1_000_000n;
const BUDGET_MS = 250;

function makeBreaker(canUse = true) {
  return {
    canUseJupiter: jest.fn().mockReturnValue(canUse),
    recordJupiterSuccess: jest.fn(),
    recordJupiterFailure: jest.fn(),
  } as unknown as AntifragileEngine;
}

function makeAxiosResponse(priceImpactPct: string) {
  return {
    data: {
      inputMint: TOKEN_CA,
      outputMint: 'So11111111111111111111111111111111111111112',
      inAmount: TEST_AMOUNT.toString(),
      outAmount: '950000',
      priceImpactPct,
    },
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as never,
  };
}

function makeAxiosError(status: number) {
  const err = new Error('Request failed') as Error & { response?: { status: number }; isAxiosError?: boolean };
  err.response = { status };
  err.isAxiosError = true;
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkHoneypot', () => {
  describe('classification: CLEAN', () => {
    it('passes on 200 with low priceImpactPct', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5.0'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(true);
      expect(result.classification).toBe('CLEAN');
      expect(result.sellQuoteSlippagePct).toBe(5);
    });

    it('passes on 200 with priceImpactPct just under threshold (49.9%)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('49.9'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(true);
      expect(result.classification).toBe('CLEAN');
    });
  });

  describe('classification: UNCONFIRMED', () => {
    it('rejects on 200 with priceImpactPct above threshold (51%)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('51'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('UNCONFIRMED');
      expect(result.sellQuoteSlippagePct).toBe(51);
    });

    it('rejects on extreme priceImpactPct (99%)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('99'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('UNCONFIRMED');
    });

    it('returns sellQuoteSlippagePct in UNCONFIRMED result', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('75.5'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.sellQuoteSlippagePct).toBe(75.5);
    });
  });

  describe('classification: INDEX_LAG', () => {
    it('rejects on 400 (pool not indexed)', async () => {
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(400));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('INDEX_LAG');
    });

    it('rejects on 404 (pool not found)', async () => {
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(404));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.classification).toBe('INDEX_LAG');
    });

    it('rejects on 429 (rate limit) without penalizing breaker', async () => {
      const breaker = makeBreaker();
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(429));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(result.classification).toBe('INDEX_LAG');
      expect(breaker.recordJupiterFailure).not.toHaveBeenCalled();
    });

    it('rejects on network error (no response)', async () => {
      const networkErr = new Error('connect ECONNREFUSED') as Error & { isAxiosError?: boolean };
      networkErr.isAxiosError = true;
      mockedAxios.get.mockRejectedValueOnce(networkErr);
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.classification).toBe('INDEX_LAG');
    });

    it('rejects on 500 server error', async () => {
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(500));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.classification).toBe('INDEX_LAG');
    });

    it('rejects on Promise.race timeout (slow Jupiter)', async () => {
      // axios call never resolves within budget — Promise.race fires TIMEOUT first
      mockedAxios.get.mockImplementationOnce(() => new Promise(() => { /* hang */ }));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, 50);
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('INDEX_LAG');
    });

    it('rejects on malformed response (NaN priceImpactPct)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('not-a-number'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('INDEX_LAG');
    });
  });

  describe('circuit breaker integration', () => {
    it('skips HTTP call when canUseJupiter returns false', async () => {
      const breaker = makeBreaker(false);
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(result.classification).toBe('INDEX_LAG');
      expect(mockedAxios.get).not.toHaveBeenCalled();
      expect(breaker.canUseJupiter).toHaveBeenCalled();
    });

    it('records success on 2xx response', async () => {
      const breaker = makeBreaker();
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5'));
      await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(breaker.recordJupiterSuccess).toHaveBeenCalledTimes(1);
      expect(breaker.recordJupiterFailure).not.toHaveBeenCalled();
    });

    it('does NOT record failure on 4xx response', async () => {
      const breaker = makeBreaker();
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(400));
      await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(breaker.recordJupiterFailure).not.toHaveBeenCalled();
      expect(breaker.recordJupiterSuccess).not.toHaveBeenCalled();
    });

    it('records failure on 5xx response', async () => {
      const breaker = makeBreaker();
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(503));
      await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(breaker.recordJupiterFailure).toHaveBeenCalledTimes(1);
    });

    it('records failure on network error', async () => {
      const breaker = makeBreaker();
      const networkErr = new Error('connect ECONNREFUSED') as Error & { isAxiosError?: boolean };
      networkErr.isAxiosError = true;
      mockedAxios.get.mockRejectedValueOnce(networkErr);
      await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker);
      expect(breaker.recordJupiterFailure).toHaveBeenCalledTimes(1);
    });

    it('does NOT record failure on Promise.race timeout', async () => {
      const breaker = makeBreaker();
      mockedAxios.get.mockImplementationOnce(() => new Promise(() => { /* hang */ }));
      await checkHoneypot(TOKEN_CA, TEST_AMOUNT, 50, breaker);
      expect(breaker.recordJupiterFailure).not.toHaveBeenCalled();
      expect(breaker.recordJupiterSuccess).not.toHaveBeenCalled();
    });

    it('works without antifragile param (optional)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.passed).toBe(true);
    });
  });

  describe('telemetry', () => {
    it('returns durationMs as a number on CLEAN path', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns durationMs on INDEX_LAG path', async () => {
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(400));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(typeof result.durationMs).toBe('number');
    });

    it('classification field is always present', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5'));
      const result = await checkHoneypot(TOKEN_CA, TEST_AMOUNT, BUDGET_MS);
      expect(result.classification).toBeDefined();
    });
  });
});

describe('checkHoneypotWithDeferredProbe', () => {
  const TEST_DEFERRED_DELAY = 10; // ms — small value avoids real 5s waits

  describe('non-route first-probe outcomes (no re-probe)', () => {
    it('CLEAN on 200 with low priceImpactPct (no re-probe)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('5.0'));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, undefined, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(true);
      expect(result.classification).toBe('CLEAN');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('UNCONFIRMED on 200 with high priceImpactPct (no re-probe)', async () => {
      mockedAxios.get.mockResolvedValueOnce(makeAxiosResponse('75'));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, undefined, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('UNCONFIRMED');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('INDEX_LAG on 5xx without re-probe', async () => {
      mockedAxios.get.mockRejectedValueOnce(makeAxiosError(503));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, undefined, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('INDEX_LAG');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('4xx first-probe triggers deferred re-probe', () => {
    it('NOT_ROUTABLE when re-probe also returns 4xx', async () => {
      const breaker = makeBreaker();
      mockedAxios.get
        .mockRejectedValueOnce(makeAxiosError(404))
        .mockRejectedValueOnce(makeAxiosError(404));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, breaker, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('NOT_ROUTABLE');
      expect(breaker.recordJupiterFailure).not.toHaveBeenCalled(); // 4xx never penalizes
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('CLEAN when re-probe returns valid quote (indexing caught up)', async () => {
      mockedAxios.get
        .mockRejectedValueOnce(makeAxiosError(404))
        .mockResolvedValueOnce(makeAxiosResponse('5.0'));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, undefined, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(true);
      expect(result.classification).toBe('CLEAN');
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('INDEX_LAG when re-probe returns 5xx', async () => {
      mockedAxios.get
        .mockRejectedValueOnce(makeAxiosError(404))
        .mockRejectedValueOnce(makeAxiosError(500));
      const result = await checkHoneypotWithDeferredProbe(
        TOKEN_CA, TEST_AMOUNT, BUDGET_MS, undefined, TEST_DEFERRED_DELAY,
      );
      expect(result.passed).toBe(false);
      expect(result.classification).toBe('INDEX_LAG');
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });
  });
});
