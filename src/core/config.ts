if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

import { Connection } from '@solana/web3.js';
import { z } from 'zod';

const envSchema = z.object({
  // Required
  HELIUS_API_KEY:          z.string().min(1, 'HELIUS_API_KEY is required'),
  PRIMARY_RPC:             z.string().url('PRIMARY_RPC must be a valid URL'),
  BACKUP_RPC:              z.string().url('BACKUP_RPC must be a valid URL'),
  PAPER_MODE:              z.enum(['true', 'false']).default('true'),
  INITIAL_CAPITAL_USD:     z.coerce.number().positive('INITIAL_CAPITAL_USD must be > 0'),
  MAX_TRADES_PER_DAY:      z.coerce.number().int().min(1).default(2),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().int().min(1).default(3),
  MAX_DAILY_LOSS_PCT:      z.coerce.number().min(1).max(100).default(20),
  MAX_WEEKLY_LOSS_PCT:     z.coerce.number().min(1).max(100).default(40),

  // Optional
  BIRDEYE_API_KEY:         z.string().optional(),
  DUNE_API_KEY:            z.string().optional(),
  RUGCHECK_API_KEY:        z.string().optional(),
  TWITTER_BEARER_TOKEN:    z.string().optional(),
  NITTER_INSTANCE:         z.string().optional(),
  TELEGRAM_API_ID:         z.string().optional(),
  TELEGRAM_API_HASH:       z.string().optional(),
  TELEGRAM_SESSION:        z.string().optional(),
  JITO_BLOCK_ENGINE_URL:   z.string().optional(),
  HELIUS_WEBHOOK_URL:      z.string().optional(),

  // File paths
  WEIGHTS_FILE:            z.string().default('./data/weights.json'),
  PAPER_TRADES_FILE:       z.string().default('./data/paperTrades.json'),
  DEPLOYERS_FILE:          z.string().default('./data/deployers.json'),
  WALLETS_FILE:            z.string().default('./data/wallets.json'),

  // Liquidity
  MIN_LIQUIDITY_SOL:       z.coerce.number().min(0).default(50),

  // Calibration
  MIN_PAPER_TRADES:        z.coerce.number().int().min(1).default(50),
  WP_CALIBRATION_AUC_MIN:  z.coerce.number().min(0).max(1).default(0.65),

  // Logging
  LOG_LEVEL:               z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig extends EnvConfig {
  PAPER_MODE: 'true' | 'false';
  connection: Connection;
  backupConnection: Connection;
  isPaperMode: boolean;
}

function createConnection(rpcUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 30_000,
  });
}

export const config = {
  load(): AppConfig {
    const parsed = envSchema.safeParse(process.env);

    if (!parsed.success) {
      const errors = parsed.error.issues
        .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      throw new Error(`CONFIG VALIDATION FAILED:\n${errors}`);
    }

    const env = parsed.data;
    const connection = createConnection(env.PRIMARY_RPC);
    const backupConnection = createConnection(env.BACKUP_RPC);

    return {
      ...env,
      connection,
      backupConnection,
      isPaperMode: env.PAPER_MODE === 'true',
    };
  },
};
