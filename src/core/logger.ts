import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { SignalVector } from './types';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  winston.format.json()
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  defaultMeta: { service: 'trading-engine' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'engine.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB per file
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
      tailable: true,
    }),
  ],
});

export interface TradeLogContext {
  tokenCA: string;
  signal: SignalVector;
  decision: string;
  sizeUSD?: number;
  executionMode?: string;
  reason?: string;
  [key: string]: unknown;
}

export function tradeLogger(context: TradeLogContext): void {
  logger.info('TRADE_DECISION', {
    ...context,
    timestamp: new Date().toISOString(),
  });
}
