import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from '../core/logger';

const walletSchema = z.object({
  address: z.string().min(32).max(44),
  pnl30d: z.number(),
  tier: z.enum(['S', 'A', 'B']),
  tradeCount: z.number().int().min(0),
  lastActive: z.coerce.date(),
});

const walletsFileSchema = z.array(walletSchema);

export type WalletEntry = z.infer<typeof walletSchema>;

export interface WalletStats {
  pnl30d: number;
  tier: 'S' | 'A' | 'B';
}

export class WalletRegistry {
  private wallets: Map<string, WalletEntry>;

  private constructor(entries: WalletEntry[]) {
    this.wallets = new Map(entries.map((w) => [w.address, w]));
  }

  static async load(filePath: string): Promise<WalletRegistry> {
    const resolved = path.resolve(filePath);

    if (!fs.existsSync(resolved)) {
      logger.warn('wallets.json not found — creating empty registry', { path: resolved });
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolved, '[]', 'utf-8');
      return new WalletRegistry([]);
    }

    const raw = fs.readFileSync(resolved, 'utf-8');
    const parsed = JSON.parse(raw);
    const validated = walletsFileSchema.parse(parsed);

    logger.info('Wallet registry loaded', { count: validated.length, path: resolved });
    return new WalletRegistry(validated);
  }

  getAll(): WalletEntry[] {
    return Array.from(this.wallets.values());
  }

  count(): number {
    return this.wallets.size;
  }

  isSmartWallet(address: string): boolean {
    return this.wallets.has(address);
  }

  getWalletStats(address: string): WalletStats | null {
    const entry = this.wallets.get(address);
    if (!entry) return null;
    return { pnl30d: entry.pnl30d, tier: entry.tier };
  }

  addWallet(entry: WalletEntry): void {
    const validated = walletSchema.parse(entry);
    this.wallets.set(validated.address, validated);
  }

  removeWallet(address: string): boolean {
    return this.wallets.delete(address);
  }

  async save(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    const data = JSON.stringify(this.getAll(), null, 2);
    fs.writeFileSync(resolved, data, 'utf-8');
    logger.info('Wallet registry saved', { count: this.count(), path: resolved });
  }
}
