import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { DeployerTier } from '../core/types';
import { logger } from '../core/logger';

const launchResultSchema = z.object({
  tokenCA: z.string(),
  peakMultiple: z.number(),
  outcome: z.enum(['SUCCESS', 'RUG', 'NEUTRAL']),
  timestamp: z.coerce.date(),
});

const deployerRecordSchema = z.object({
  address: z.string().min(32).max(44),
  tier: z.enum(['S', 'A', 'B', 'BLACKLIST', 'UNKNOWN']),
  launches: z.array(launchResultSchema),
  successRate: z.number().min(0).max(1),
  rugRate: z.number().min(0).max(1),
  avgPeakMultiple: z.number(),
  lastActive: z.coerce.date(),
});

const deployersFileSchema = z.object({
  deployers: z.array(deployerRecordSchema),
  lastSync: z.coerce.date().nullable(),
  version: z.string(),
});

export type LaunchResult = z.infer<typeof launchResultSchema>;
export type DeployerRecord = z.infer<typeof deployerRecordSchema>;

const TIER_BONUS: Record<DeployerTier, number> = {
  S: 4,
  A: 2,
  B: 0.5,
  BLACKLIST: -20,
  UNKNOWN: 0,
};

export class DeployerRegistry {
  private deployers: Map<string, DeployerRecord>;

  private constructor(records: DeployerRecord[]) {
    this.deployers = new Map(records.map((d) => [d.address, d]));
  }

  static async load(filePath: string): Promise<DeployerRegistry> {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      logger.warn('deployers.json not found — creating empty registry', { path: resolved });
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const empty = { deployers: [], lastSync: null, version: '1.0' };
      fs.writeFileSync(resolved, JSON.stringify(empty, null, 2), 'utf-8');
      return new DeployerRegistry([]);
    }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = deployersFileSchema.parse(parsed);

    logger.info('Deployer registry loaded', { count: validated.deployers.length, path: resolved });
    return new DeployerRegistry(validated.deployers);
  }

  getTier(address: string): DeployerTier {
    const record = this.deployers.get(address);
    return record?.tier ?? 'UNKNOWN';
  }

  isBlacklisted(address: string): boolean {
    return this.getTier(address) === 'BLACKLIST';
  }

  getBonus(address: string): number {
    return TIER_BONUS[this.getTier(address)];
  }

  count(): number {
    return this.deployers.size;
  }

  getRecord(address: string): DeployerRecord | null {
    return this.deployers.get(address) ?? null;
  }

  addLaunch(address: string, result: LaunchResult): void {
    const existing = this.deployers.get(address);

    if (!existing) {
      const record: DeployerRecord = {
        address,
        tier: 'UNKNOWN',
        launches: [result],
        successRate: result.outcome === 'SUCCESS' ? 1 : 0,
        rugRate: result.outcome === 'RUG' ? 1 : 0,
        avgPeakMultiple: result.peakMultiple,
        lastActive: result.timestamp,
      };
      this.deployers.set(address, record);
      return;
    }

    existing.launches.push(result);
    existing.lastActive = result.timestamp;

    const total = existing.launches.length;
    existing.successRate = existing.launches.filter((l) => l.outcome === 'SUCCESS').length / total;
    existing.rugRate = existing.launches.filter((l) => l.outcome === 'RUG').length / total;
    existing.avgPeakMultiple =
      existing.launches.reduce((sum, l) => sum + l.peakMultiple, 0) / total;

    // Auto-tier based on history
    existing.tier = this.computeTier(existing);
    this.deployers.set(address, existing);
  }

  private computeTier(record: DeployerRecord): DeployerTier {
    if (record.rugRate > 0.5 && record.launches.length >= 3) return 'BLACKLIST';
    if (record.successRate >= 0.7 && record.avgPeakMultiple >= 5 && record.launches.length >= 5) return 'S';
    if (record.successRate >= 0.5 && record.avgPeakMultiple >= 3 && record.launches.length >= 3) return 'A';
    if (record.successRate >= 0.3 && record.launches.length >= 2) return 'B';
    return 'UNKNOWN';
  }

  async save(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    const data = {
      deployers: Array.from(this.deployers.values()),
      lastSync: new Date(),
      version: '1.0',
    };
    fs.writeFileSync(resolved, JSON.stringify(data, null, 2), 'utf-8');
    logger.info('Deployer registry saved', { count: this.count(), path: resolved });
  }
}
