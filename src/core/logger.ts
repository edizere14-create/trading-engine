import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { SignalVector } from './types';

const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Scrub api-key query params from all logged strings (URLs like ?api-key=xxx)
const redactSecrets = winston.format((info) => {
  const scrub = (s: string) =>
    s.replace(/([?&]api[-_]key=)[^&"'\s)]+/gi, '$1REDACTED');
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v))       return v.map(deep);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v as Record<string,unknown>).map(([k,u]) => [k, deep(u)]));
    return v;
  };
  if (typeof info.message === 'string') info.message = scrub(info.message);
  for (const key of Object.keys(info)) {
    if (key !== 'level' && key !== 'message' && key !== 'timestamp' && key !== 'service')
      (info as Record<string,unknown>)[key] = deep(info[key as keyof typeof info]);
  }
  return info;
})();

const consoleFormat = winston.format.combine(
  redactSecrets,
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} ${level}: ${message}${metaStr}`;
  })
);

const fileFormat = winston.format.combine(
  redactSecrets,
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
