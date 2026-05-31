import type { LLMProvider } from './types';
import { AnthropicProvider } from './anthropic';
import { OpenAiProvider } from './openai';

export type {
  ContentBlock,
  CreateMessageParams,
  LLMProvider,
  Message,
  ProviderResponse,
  StopReason,
  TextBlock,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from './types';

let cached: LLMProvider | null = null;

/**
 * Resolve the active LLM backend from LLM_PROVIDER (default 'anthropic'),
 * constructed lazily and memoized for the process. Throws on an unknown value
 * so a typo fails fast at startup rather than silently defaulting.
 */
export function getProvider(): LLMProvider {
  if (cached) return cached;
  const name = (process.env.LLM_PROVIDER?.trim() || 'anthropic').toLowerCase();
  switch (name) {
    case 'anthropic':
      cached = new AnthropicProvider();
      break;
    case 'openai':
      cached = new OpenAiProvider();
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}". Supported values: anthropic, openai.`);
  }
  return cached;
}
