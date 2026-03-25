import axios from 'axios';
import { logger } from '../core/logger';

const PLACEHOLDERS = new Set([
  '',
  'your_bot_token_here',
  'your_chat_id_here',
  'changeme',
  'none',
  'null',
]);

function isValidToken(token: string): boolean {
  if (PLACEHOLDERS.has(token.toLowerCase())) return false;
  if (!token.includes(':')) return false;
  if (/\s/.test(token)) return false;
  return true;
}

function isValidChatId(chatId: string): boolean {
  if (PLACEHOLDERS.has(chatId.toLowerCase())) return false;
  if (/\s/.test(chatId)) return false;
  return true;
}

export class TelegramNotifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  constructor(token?: string, chatId?: string) {
    this.token = (token ?? '').trim();
    this.chatId = (chatId ?? '').trim();
    this.enabled = isValidToken(this.token) && isValidChatId(this.chatId);

    if (!this.enabled) {
      logger.info('Telegram notifier disabled (missing or invalid TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async send(message: string): Promise<void> {
    if (!this.enabled) return;

    const payload = {
      chat_id: this.chatId,
      text: message,
      disable_web_page_preview: true,
    };

    try {
      const resp = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        payload,
        { timeout: 10_000 }
      );
      if (resp.status !== 200 || !resp.data?.ok) {
        logger.warn('Telegram notification rejected by API', {
          status: resp.status,
          response: resp.data,
        });
      }
    } catch (error) {
      logger.warn('Telegram notification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
