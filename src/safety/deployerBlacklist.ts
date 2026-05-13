/**
 * Phase B: deployer blacklist check.
 *
 * v2 baseline: stub-pass. No curated blacklist data yet — the architecture
 * has the hook so we can wire real data later without touching Phase B.
 *
 * Future implementation will read a JSON file of known scam deployer addresses
 * at startup and check membership. For now, returns { passed: true } always.
 *
 * Async signature for future-proofing: the real version will likely load the
 * file lazily or check a remote service.
 */

export interface DeployerBlacklistResult {
  passed: boolean;
  reason?: string;
}

export async function checkDeployerBlacklist(
  _deployer: string,
): Promise<DeployerBlacklistResult> {
  // TODO: implement actual blacklist lookup. See POST_BUILD_CLEANUP.md.
  return { passed: true };
}
