import OpenAI from 'openai';
import type {
  ContentBlock,
  CreateMessageParams,
  LLMProvider,
  Message,
  ProviderResponse,
  StopReason,
  ToolResultBlock,
  ToolUseBlock,
} from './types';

// We target the Chat Completions API (not the newer Responses API) on purpose:
// it is the de-facto standard implemented by every OpenAI-compatible endpoint
// (Groq, Together, OpenRouter, Azure OpenAI, Ollama, ...), so pointing
// OPENAI_BASE_URL at one of those Just Works. Its tools/tool_calls/role:'tool'
// model also maps near-mechanically to our neutral tool_use/tool_result blocks.

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatToolCall = OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall;

function safeJsonParse(raw: string): Record<string, unknown> {
  // OpenAI returns tool-call arguments as a JSON string the model generated —
  // it is not guaranteed to be valid JSON. Fall back to {} so a malformed arg
  // surfaces as a tool error downstream rather than throwing out of the loop.
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
}

export function toOpenAiMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      const toolCalls: ChatToolCall[] = m.content
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const assistant: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      out.push(assistant);
      continue;
    }

    // A user turn is either real text input or a batch of tool results. OpenAI
    // requires one role:'tool' message per preceding tool_call, in order — so we
    // fan the batch out. (The is_error flag has no OpenAI field and is dropped;
    // the error text still rides in content.)
    const toolResults = m.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
    if (toolResults.length > 0) {
      for (const r of toolResults) {
        out.push({ role: 'tool', tool_call_id: r.toolUseId, content: r.content });
      }
    } else {
      out.push({ role: 'user', content: textOf(m.content) });
    }
  }

  return out;
}

export function toNeutralStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'stop':
      return 'end_turn';
    default:
      // 'length' | 'content_filter' | null
      return 'other';
  }
}

export class OpenAiProvider implements LLMProvider {
  readonly name = 'openai';
  readonly defaultModel = 'gpt-4o';
  private readonly client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL?.trim() || undefined,
      maxRetries: 2,
    });
  }

  async createMessage(params: CreateMessageParams): Promise<ProviderResponse> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages: toOpenAiMessages(params.system, params.messages),
      tools: params.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
    });

    const choice = response.choices[0];
    const msg = choice.message;
    const content: ContentBlock[] = [];
    if (typeof msg.content === 'string' && msg.content.length > 0) {
      content.push({ type: 'text', text: msg.content });
    }
    for (const tc of msg.tool_calls ?? []) {
      if (tc.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: safeJsonParse(tc.function.arguments),
      });
    }

    return { content, stopReason: toNeutralStopReason(choice.finish_reason) };
  }

  isRetryable(err: unknown): boolean {
    const status = (err as { status?: number }).status;
    return status === 429 || status === 500 || status === 503;
  }
}
