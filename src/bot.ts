import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { processMessage } from './agent';
import { toTelegramMarkdown } from './telegram-format';
import type { Message } from './providers';

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES ?? '20', 10);

const ALLOWED_CHAT_IDS: Set<number> | null = (() => {
  const raw = process.env.ALLOWED_CHAT_IDS?.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n)),
  );
})();

const conversationHistory = new Map<number, Message[]>();

function getHistory(chatId: number): Message[] {
  const existing = conversationHistory.get(chatId);
  if (existing) return existing;
  const fresh: Message[] = [];
  conversationHistory.set(chatId, fresh);
  return fresh;
}

export function isRealUserMessage(m: Message): boolean {
  if (m.role !== 'user') return false;
  // A "real" user input contains no tool_result blocks. tool_result-bearing
  // messages are replies to assistant tool_use and can't appear without a
  // preceding tool_use turn.
  return !m.content.some((b) => b.type === 'tool_result');
}

export function pruneHistory(messages: Message[], maxHistory: number = MAX_HISTORY): Message[] {
  if (messages.length <= maxHistory) return messages;
  const trimmed = messages.slice(messages.length - maxHistory);
  // Find first message that's a real user input — guarantees the Anthropic
  // API invariant that the conversation starts with a user turn AND that any
  // tool_result block has its matching tool_use in the previous assistant turn.
  const firstRealUserIdx = trimmed.findIndex(isRealUserMessage);
  if (firstRealUserIdx === -1) {
    // Trim window contained no real user input — keep the original to be safe.
    return messages;
  }
  return trimmed.slice(firstRealUserIdx);
}

/**
 * Send a reply as Telegram MarkdownV2, falling back to plain text if Telegram
 * rejects the formatted version (a malformed-entity 400). The fallback means a
 * formatting edge case can never swallow the actual answer.
 */
async function sendFormatted(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  text: string,
): Promise<void> {
  try {
    await ctx.reply(toTelegramMarkdown(text), { parse_mode: 'MarkdownV2' });
  } catch (err: unknown) {
    const e = err as { description?: string; response?: { description?: string } };
    const desc = e.description ?? e.response?.description ?? '';
    if (/can't parse entities|parse entities|MARKDOWN/i.test(desc)) {
      await ctx.reply(text);
    } else {
      throw err;
    }
  }
}

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      if (ALLOWED_CHAT_IDS && !ALLOWED_CHAT_IDS.has(chatId)) {
        console.warn(`[auth] Rejected message from chat ${chatId}`);
        await ctx.reply(
          `Unauthorized chat. Your chat ID is ${chatId} — add it to ALLOWED_CHAT_IDS in .env if this is you.`,
        );
        return;
      }
      if (!ALLOWED_CHAT_IDS) {
        console.log(`[auth] Open mode — message from chat ${chatId}`);
      }
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Hi! I\'m Blurt — I manage your Apple Calendar.\n\n' +
        'Try things like:\n' +
        '• "What\'s on my calendar today?"\n' +
        '• "Schedule a coffee chat tomorrow at 3pm for 30 min"\n' +
        '• "Move my dentist appointment to 11am"\n' +
        '• "Cancel my 4pm meeting"\n\n' +
        'Use /clear to reset our conversation.',
    );
  });

  bot.command('clear', async (ctx) => {
    const chatId = ctx.chat.id;
    conversationHistory.delete(chatId);
    await ctx.reply('Conversation history cleared.');
  });

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    console.log(`[${chatId}] user: ${userText}`);

    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
      const history = getHistory(chatId);
      const { responseText, updatedHistory } = await processMessage(userText, history);
      conversationHistory.set(chatId, pruneHistory(updatedHistory));
      console.log(`[${chatId}] blurt: ${responseText.slice(0, 200)}`);
      await sendFormatted(ctx, responseText);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      console.error(`[${chatId}] error:`, err);
      let userMessage: string;
      if (e.status === 529 || e.status === 503) {
        userMessage = 'The model API is overloaded right now. Try again in a minute.';
      } else if (e.status === 429) {
        userMessage = 'Rate limited by the model API. Give it a moment and try again.';
      } else if (e.status === 401 || e.status === 403) {
        userMessage = 'Auth failed talking to the model API — check your provider API key.';
      } else if (typeof e.message === 'string' && e.message.includes('AppleScript')) {
        userMessage = `Calendar error: ${e.message}`;
      } else {
        userMessage = `Sorry, something went wrong: ${e.message ?? String(err)}`;
      }
      await ctx.reply(userMessage);
    } finally {
      clearInterval(typingInterval);
    }
  });

  return bot;
}
