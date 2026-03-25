import 'dotenv/config';
import { Connection } from '@solana/web3.js';
import { z } from 'zod';

const envSchema = z.object({
  // Required
  HELIUS_API_KEY:          z.string().min(1, 'HELIUS_API_KEY is required'),
  PRIMARY_RPC:             z.string().url('PRIMARY_RPC must be a valid URL'),
  BACKUP_RPC:              z.string().url('BACKUP_RPC must be a valid URL'),
  PAPER_MODE:              z.enum(['true', 'false']).default('true'),
  AUTONOMOUS_ONLY:         z.enum(['true', 'false']).default('true'),
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
  TELEGRAM_BOT_TOKEN:      z.string().optional(),
  TELEGRAM_CHAT_ID:        z.string().optional(),
  JITO_BLOCK_ENGINE_URL:   z.string().optional(),
  HELIUS_WEBHOOK_URL:      z.string().optional(),

  // Private key for execution engine (base58 encoded)
  WALLET_PRIVATE_KEY:      z.string().optional(),

  // ML configuration
  ML_LEARNING_RATE:        z.coerce.number().min(0.0001).max(0.1).default(0.01),
  ML_MODEL_FILE:           z.string().default('./data/ml_model.json'),
  ML_HMM_FILE:             z.string().default('./data/hmm_regime.json'),

  // Execution configuration
  EXECUTION_MAX_RETRIES:   z.coerce.number().int().min(1).max(10).default(3),
  EXECUTION_TIMEOUT_MS:    z.coerce.number().int().min(5000).default(30_000),
  MEV_PROTECTION_ENABLED:  z.enum(['true', 'false']).default('true'),
  STRICT_FILL_VERIFICATION: z.enum(['true', 'false']).default('true'),
  EXECUTION_MIN_FILL_RATIO: z.coerce.number().min(0.1).max(1).default(0.70),

  // Deployer intelligence
  DEPLOYER_INTEL_FILE:     z.string().default('./data/deployer_intelligence.json'),
  DEPLOYER_MIN_REPUTATION: z.coerce.number().min(0).max(100).default(20),

  // Social signals
  SOCIAL_HYPE_THRESHOLD:   z.coerce.number().min(0).max(10).default(6),

  // Portfolio optimizer
  KELLY_FRACTION:          z.coerce.number().min(0.1).max(1.0).default(0.25),
  MAX_PORTFOLIO_HEAT:      z.coerce.number().min(0.1).max(1.0).default(0.80),
  MAX_NARRATIVE_EXPOSURE:  z.coerce.number().min(0.1).max(1.0).default(0.40),

  // File paths
  WEIGHTS_FILE:            z.string().default('./data/weights.json'),
  PAPER_TRADES_FILE:       z.string().default('./data/paperTrades.json'),
  DEPLOYERS_FILE:          z.string().default('./data/deployers.json'),
  WALLETS_FILE:            z.string().default('./data/wallets.json'),

  // Liquidity
  MIN_LIQUIDITY_SOL:       z.coerce.number().min(0).default(50),

  // Copy trade parameters
  MIN_COPY_SWAP_SOL:       z.coerce.number().min(0).default(0.05),   // ignore dust swaps
  MAX_COPY_SWAP_SOL:       z.coerce.number().min(0).default(50),     // ignore whale-only plays
  COPY_SIZE_PCT:           z.coerce.number().min(0.01).max(1).default(0.10), // % of capital per copy
  COPY_MAX_HOLD_MS:        z.coerce.number().int().min(10000).default(300_000), // 5 min default
  COPY_STOP_LOSS_PCT:      z.coerce.number().min(0.05).max(0.90).default(0.30), // -30%
  COPY_CLUSTER_BONUS_PCT:  z.coerce.number().min(0).max(1).default(0.50), // extra size on cluster
  WALLET_COOLDOWN_LOSSES:  z.coerce.number().int().min(1).default(3),  // consecutive loss cooldown  
  WALLET_COOLDOWN_HOURS:   z.coerce.number().min(0.5).max(72).default(6), // cooldown duration
  TOKEN_MAX_AGE_MS:        z.coerce.number().int().min(0).default(3_600_000), // skip tokens >1hr old
  REBUY_CONVICTION_EXTEND_MS: z.coerce.number().int().min(0).default(120_000), // extend hold on rebuy

  // Calibration
  MIN_PAPER_TRADES:        z.coerce.number().int().min(1).default(50),
  WP_CALIBRATION_AUC_MIN:  z.coerce.number().min(0).max(1).default(0.65),

  // Logging
  LOG_LEVEL:               z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig extends EnvConfig {
  PAPER_MODE: 'true' | 'false';
  AUTONOMOUS_ONLY: 'true' | 'false';
  connection: Connection;
  backupConnection: Connection;
  isPaperMode: boolean;
  isAutonomousOnly: boolean;
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
      isAutonomousOnly: env.AUTONOMOUS_ONLY === 'true',
    };
  },
};
