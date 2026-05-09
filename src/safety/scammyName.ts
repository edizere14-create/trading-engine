/**
 * Phase A: scammy-name regex check.
 *
 * Permissive by design — only catches obviously injected scam markers.
 * Memecoin names are wild; aggressive filtering rejects legitimate launches.
 * Tune the patterns from soak data, don't preemptively expand them.
 *
 * Returns { passed: false } only if the name matches a known scam pattern.
 * Empty/missing names pass — absence of a name is a data-pipeline gap, not
 * evidence of a scam.
 */

const SCAM_PATTERNS: RegExp[] = [
  /\brug/i,        // matches "RUGTOKEN", "rug pull", "the rug" — not "Frugal", "Drugstore"
  /\bscam/i,       // matches "SCAMCOIN", "scam token" — not "Scampi"
  /\bfake/i,       // matches "FAKEDOGE", "fake pepe" — not "Faker.js"
  /honeypot/i,     // no boundary needed — no legitimate token contains this substring
  /\btest\s*token/i,
  /do\s*not\s*buy/i,
];

export interface ScammyNameResult {
  passed: boolean;
  matchedPattern?: string;
}

export function checkScammyName(name: string | undefined | null): ScammyNameResult {
  if (!name || name.trim().length === 0) {
    return { passed: true };
  }

  for (const pattern of SCAM_PATTERNS) {
    if (pattern.test(name)) {
      return {
        passed: false,
        matchedPattern: pattern.source,
      };
    }
  }

  return { passed: true };
}