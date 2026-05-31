/**
 * Provider-neutral LLM types. Nothing in here imports a vendor SDK — the
 * agentic loop (src/agent.ts) and the bot's history (src/bot.ts) speak only
 * these shapes, and each provider adapter translates to/from its SDK at the
 * boundary. Adding a new backend means implementing LLMProvider, nothing else.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  /** Always a block array — the initial user turn is normalized to [{ type: 'text' }]. */
  content: ContentBlock[];
}

/**
 * Normalized stop reason. Providers collapse their native values:
 * - 'end_turn' — finished a normal text turn (Anthropic end_turn/stop_sequence, OpenAI 'stop')
 * - 'tool_use' — wants tools run (Anthropic tool_use, OpenAI 'tool_calls'/'function_call')
 * - 'other'    — anything else (max_tokens/length/content_filter/null); treated as terminal
 */
export type StopReason = 'end_turn' | 'tool_use' | 'other';

export interface ProviderResponse {
  /** Assistant output blocks (text and/or tool_use). */
  content: ContentBlock[];
  stopReason: StopReason;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Plain JSON Schema object describing the tool's input. */
  parameters: Record<string, unknown>;
}

export interface CreateMessageParams {
  system: string;
  tools: ToolDefinition[];
  messages: Message[];
  model: string;
  maxTokens: number;
}

export interface LLMProvider {
  /** Short label used in logs, e.g. 'anthropic' | 'openai'. */
  readonly name: string;
  /** Model id used when LLM_MODEL is unset. */
  readonly defaultModel: string;
  createMessage(params: CreateMessageParams): Promise<ProviderResponse>;
  /** Whether an error thrown by createMessage is worth retrying (per-provider status codes). */
  isRetryable(err: unknown): boolean;
}
