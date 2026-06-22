import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsVsRemindersBlock } from '../../src/agent';

test('with reminder lists: keeps the "default to events, reminders on request" heuristic', () => {
  const block = eventsVsRemindersBlock(true);
  assert.match(block, /DEFAULT TO EVENTS/);
  // create_reminder is still offered for explicit requests.
  assert.match(block, /create_reminder/);
  assert.doesNotMatch(block, /has no usable Apple Reminders/);
});

test('without reminder lists: forbids create_reminder and mandates events', () => {
  const block = eventsVsRemindersBlock(false);
  assert.match(block, /has no usable Apple Reminders/);
  assert.match(block, /NEVER use create_reminder/);
  assert.match(block, /ALWAYS USE EVENTS/);
});
