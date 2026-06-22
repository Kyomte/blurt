import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneHistory, isRealUserMessage } from '../../src/bot';
import type { Message } from '../../src/providers';

function userText(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input: {} }],
  };
}

function toolResult(id: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: id, content, isError: false }],
  };
}

test('isRealUserMessage: plain user text is real', () => {
  assert.equal(isRealUserMessage(userText('hi')), true);
});

test('isRealUserMessage: assistant turns are not real user input', () => {
  assert.equal(isRealUserMessage(assistantText('hello')), false);
});

test('isRealUserMessage: tool_result-bearing user turns are not real input', () => {
  assert.equal(isRealUserMessage(toolResult('t1', 'ok')), false);
});

test('pruneHistory: short history is returned unchanged', () => {
  const history = [userText('a'), assistantText('b')];
  assert.deepEqual(pruneHistory(history, 20), history);
});

test('pruneHistory: trims to the cap and starts on a real user turn', () => {
  // 8 messages, cap 4. A naive slice(-4) could begin on an assistant turn or a
  // tool_result — both are invalid first messages for the providers.
  const history: Message[] = [
    userText('1'),
    assistantText('r1'),
    userText('2'),
    assistantText('r2'),
    userText('3'),
    assistantText('r3'),
    userText('4'),
    assistantText('r4'),
  ];
  const pruned = pruneHistory(history, 4);
  assert.ok(pruned.length <= 4);
  assert.equal(pruned[0].role, 'user');
  assert.equal(isRealUserMessage(pruned[0]), true);
});

test('pruneHistory: never starts on an orphan tool_result', () => {
  // The naive tail of width 3 would be [assistant tool_use, tool_result, ...].
  // The trim must skip forward to the next real user turn so no tool_result is
  // left without its matching tool_use in the previous assistant turn.
  const history: Message[] = [
    userText('schedule a meeting'),
    assistantToolUse('tool-1', 'create_calendar_event'),
    toolResult('tool-1', '{"ok":true}'),
    assistantText('Done!'),
    userText('thanks'),
    assistantText('np'),
  ];
  const pruned = pruneHistory(history, 3);
  assert.equal(isRealUserMessage(pruned[0]), true);
  for (const m of pruned) {
    if (m.role === 'user' && m.content.some((b) => b.type === 'tool_result')) {
      assert.fail('pruned history must not start with / contain orphan tool_result');
    } else {
      break;
    }
  }
});

test('pruneHistory: keeps original when trim window has no real user turn', () => {
  // A degenerate window of only assistant + tool_result turns: bail out and keep
  // the original rather than emit an invalid conversation.
  const history: Message[] = [
    userText('start'),
    assistantToolUse('t1', 'list_calendar_events'),
    toolResult('t1', '[]'),
    assistantToolUse('t2', 'list_reminders'),
    toolResult('t2', '[]'),
  ];
  const pruned = pruneHistory(history, 2);
  // window of 2 = [assistant tool_use, tool_result] → no real user → original kept
  assert.deepEqual(pruned, history);
});
