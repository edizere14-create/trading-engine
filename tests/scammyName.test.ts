import { checkScammyName } from '../src/safety/scammyName';

describe('checkScammyName', () => {
  describe('clean names pass', () => {
    it('passes generic memecoin names', () => {
      expect(checkScammyName('PEPE').passed).toBe(true);
      expect(checkScammyName('Doge Killer').passed).toBe(true);
      expect(checkScammyName('Moonshot').passed).toBe(true);
      expect(checkScammyName('🚀ROCKET🚀').passed).toBe(true);
    });

    it('passes empty / null / undefined / whitespace names', () => {
      expect(checkScammyName('').passed).toBe(true);
      expect(checkScammyName(null).passed).toBe(true);
      expect(checkScammyName(undefined).passed).toBe(true);
      expect(checkScammyName('   ').passed).toBe(true);
    });

    it('does NOT reject legitimate words containing scam patterns as substrings', () => {
      expect(checkScammyName('Frugal').passed).toBe(true);     // contains "rug"
      expect(checkScammyName('Drugstore').passed).toBe(true);  // contains "rug"
      expect(checkScammyName('Scampi').passed).toBe(true);     // contains "scam"
      expect(checkScammyName('Faker.js').passed).toBe(true);   // contains "fake"
    });
  });

  describe('scam patterns reject', () => {
    it('rejects standalone "rug" as a word', () => {
      expect(checkScammyName('rug pull coin').passed).toBe(false);
      expect(checkScammyName('THE RUG').passed).toBe(false);
    });

    it('rejects standalone "scam" as a word', () => {
      expect(checkScammyName('SCAM TOKEN').passed).toBe(false);
      expect(checkScammyName('Scam Pepe').passed).toBe(false);
    });

    it('rejects standalone "fake" as a word', () => {
      expect(checkScammyName('fake DOGE').passed).toBe(false);
      expect(checkScammyName('Fake Pepe').passed).toBe(false);
    });

    it('rejects "honeypot" anywhere in name', () => {
      expect(checkScammyName('honeypot').passed).toBe(false);
      expect(checkScammyName('MyHoneypotCoin').passed).toBe(false);
      expect(checkScammyName('THE HONEYPOT').passed).toBe(false);
    });

    it('rejects "test token" with optional spacing', () => {
      expect(checkScammyName('Test Token').passed).toBe(false);
      expect(checkScammyName('TESTTOKEN').passed).toBe(false);
      expect(checkScammyName('my test  token').passed).toBe(false);
    });

    it('rejects "do not buy" variants', () => {
      expect(checkScammyName('DONOTBUY').passed).toBe(false);
      expect(checkScammyName('Do Not Buy This').passed).toBe(false);
      expect(checkScammyName('do  not  buy').passed).toBe(false);
    });
  });

  describe('case insensitivity', () => {
    it('matches all casings of standalone "rug"', () => {
      expect(checkScammyName('rug pull').passed).toBe(false);
      expect(checkScammyName('RUG PULL').passed).toBe(false);
      expect(checkScammyName('Rug Pull').passed).toBe(false);
    });
  });

  describe('matchedPattern returned on rejection', () => {
    it('returns matched pattern source for "rug"', () => {
      const result = checkScammyName('rug pull');
      expect(result.passed).toBe(false);
      expect(result.matchedPattern).toBeDefined();
      expect(result.matchedPattern).toContain('rug');
    });

    it('does not return matchedPattern when passed', () => {
      const result = checkScammyName('PEPE');
      expect(result.passed).toBe(true);
      expect(result.matchedPattern).toBeUndefined();
    });
  });

  describe('known limitations: compound names slip through', () => {
    // Word boundaries on both sides mean "RUGCOIN" / "SCAMCOIN" / "FAKEDOGE" don't match.
    // Trade-off: we avoid false positives like "Scampi" / "Faker.js" / "Drugstore" but
    // also miss obvious compound scams. Soak data will tell us if this matters; other
    // safety checks (holder concentration, LP lock, mint/freeze authority) catch most
    // real scams independent of name.
    it('does NOT reject compound forms like RUGCOIN, SCAMCOIN, FAKEDOGE', () => {
      expect(checkScammyName('RUGCOIN').passed).toBe(true);
      expect(checkScammyName('SCAMCOIN').passed).toBe(true);
      expect(checkScammyName('FAKEDOGE').passed).toBe(true);
      expect(checkScammyName('RUGTOKEN').passed).toBe(true);
      expect(checkScammyName('rugcoin').passed).toBe(true);
    });
  });
});