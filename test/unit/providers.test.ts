import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAnthropicMessages,
  toNeutralStopReason as anthropicStopReason,
} from '../../src/providers/anthropic';
import {
  toOpenAiMessages,
  toNeutralStopReason as openaiStopReason,
} from '../../src/providers/openai';
import { getProvider } from '../../src/providers';
import type { Message } from '../../src/providers';

const sample: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'schedule a meeting' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'tc-1', name: 'create_calendar_event', input: { title: 'X' } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', toolUseId: 'tc-1', content: '{"ok":true}', isError: false },
    ],
  },
];

// ---------- Anthropic mapping ----------

test('anthropic: tool_result maps tool_use_id + is_error (field rename)', () => {
  const out = toAnthropicMessages([
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'tc-9', content: 'boom', isError: true },
      ],
    },
  ]);
  const block = (out[0].content as any[])[0];
  assert.equal(block.type, 'tool_result');
  assert.equal(block.tool_use_id, 'tc-9');
  assert.equal(block.is_error, true);
  assert.equal(block.content, 'boom');
});

test('anthropic: tool_use block keeps id/name/input', () => {
  const out = toAnthropicMessages(sample);
  const assistant = out[1].content as any[];
  const toolUse = assistant.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.id, 'tc-1');
  assert.equal(toolUse.name, 'create_calendar_event');
  assert.deepEqual(toolUse.input, { title: 'X' });
});

test('anthropic stop reason: tool_use / end_turn / stop_sequence / max_tokens', () => {
  assert.equal(anthropicStopReason('tool_use'), 'tool_use');
  assert.equal(anthropicStopReason('end_turn'), 'end_turn');
  assert.equal(anthropicStopReason('stop_sequence'), 'end_turn');
  assert.equal(anthropicStopReason('max_tokens'), 'other');
  assert.equal(anthropicStopReason(null), 'other');
});

// ---------- OpenAI mapping ----------

test('openai: prepends a system message', () => {
  const out = toOpenAiMessages('SYS', sample);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'SYS');
});

test('openai: assistant tool_use becomes tool_calls with JSON-stringified args', () => {
  const out = toOpenAiMessages('SYS', sample);
  const assistant = out.find((m) => m.role === 'assistant') as any;
  assert.ok(Array.isArray(assistant.tool_calls));
  assert.equal(assistant.tool_calls[0].id, 'tc-1');
  assert.equal(assistant.tool_calls[0].type, 'function');
  assert.equal(assistant.tool_calls[0].function.name, 'create_calendar_event');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { title: 'X' });
});

test('openai: a tool_result user turn fans out to role:tool messages', () => {
  const out = toOpenAiMessages('SYS', [
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'a', content: 'r1', isError: false },
        { type: 'tool_result', toolUseId: 'b', content: 'r2', isError: true },
      ],
    },
  ]);
  const toolMsgs = out.filter((m) => m.role === 'tool') as any[];
  assert.equal(toolMsgs.length, 2);
  assert.equal(toolMsgs[0].tool_call_id, 'a');
  assert.equal(toolMsgs[1].tool_call_id, 'b');
  // is_error has no OpenAI field — error text still rides in content.
  assert.equal(toolMsgs[1].content, 'r2');
});

test('openai stop reason: tool_calls / function_call / stop / length', () => {
  assert.equal(openaiStopReason('tool_calls'), 'tool_use');
  assert.equal(openaiStopReason('function_call'), 'tool_use');
  assert.equal(openaiStopReason('stop'), 'end_turn');
  assert.equal(openaiStopReason('length'), 'other');
  assert.equal(openaiStopReason('content_filter'), 'other');
  assert.equal(openaiStopReason(null), 'other');
});

// ---------- getProvider() selection ----------

test('getProvider: unknown LLM_PROVIDER throws fast', async (t) => {
  const prev = process.env.LLM_PROVIDER;
  // getProvider memoizes per process; this test runs in its own worker so the
  // cache is fresh, but reset env afterwards regardless.
  t.after(() => {
    if (prev === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = prev;
  });
  process.env.LLM_PROVIDER = 'definitely-not-a-provider';
  assert.throws(() => getProvider(), /Unknown LLM_PROVIDER/);
});
