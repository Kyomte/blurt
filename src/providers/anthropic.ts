import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  CreateMessageParams,
  LLMProvider,
  Message,
  ProviderResponse,
  StopReason,
} from './types';

type AnthropicContentParam =
  | Anthropic.TextBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;

function toAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    const content: AnthropicContentParam[] = m.content.map((b) => {
      switch (b.type) {
        case 'text':
          return { type: 'text', text: b.text };
        case 'tool_use':
          return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
        case 'tool_result':
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.content,
            is_error: b.isError,
          };
      }
    });
    return { role: m.role, content };
  });
}

function toNeutralStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    default:
      // 'max_tokens' | null
      return 'other';
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly defaultModel = 'claude-sonnet-4-6';
  private readonly client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 2,
    });
  }

  async createMessage(params: CreateMessageParams): Promise<ProviderResponse> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      messages: toAnthropicMessages(params.messages),
    });

    const content: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return { content, stopReason: toNeutralStopReason(response.stop_reason) };
  }

  isRetryable(err: unknown): boolean {
    const status = (err as { status?: number }).status;
    return status === 529 || status === 503 || status === 502 || status === 500;
  }
}
