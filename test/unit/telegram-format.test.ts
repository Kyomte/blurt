import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTelegramMarkdown } from '../../src/telegram-format';

test('escapes MarkdownV2 reserved characters in plain text', () => {
  // A date like "June 15." has a reserved "." that must be escaped or Telegram
  // rejects the whole message.
  const out = toTelegramMarkdown('Booked for June 15. See you (soon)!');
  assert.match(out, /June 15\\\./);
  assert.match(out, /\\\(soon\\\)/);
  assert.match(out, /\\!/);
});

test('**bold** becomes *bold* (MarkdownV2 bold)', () => {
  const out = toTelegramMarkdown('**Dentist** appointment');
  assert.match(out, /\*Dentist\*/);
  // The literal ** must not survive.
  assert.doesNotMatch(out, /\*\*/);
});

test('*italic* becomes _italic_', () => {
  const out = toTelegramMarkdown('in *Work* calendar');
  assert.match(out, /_Work_/);
});

test('inline code is preserved and its reserved chars are NOT body-escaped', () => {
  const out = toTelegramMarkdown('at `3:00 PM` sharp');
  assert.match(out, /`3:00 PM`/);
});

test('snake_case is not turned into italic', () => {
  const out = toTelegramMarkdown('the create_calendar_event tool');
  // Underscores should be escaped, not interpreted as italic delimiters.
  assert.match(out, /create\\_calendar\\_event/);
  assert.doesNotMatch(out, /_calendar_/);
});

test('reserved chars inside bold are escaped within the entity', () => {
  const out = toTelegramMarkdown('**Lunch (1pm)**');
  // Result is *Lunch \(1pm\)* — entity markers raw, inner parens escaped.
  assert.match(out, /\*Lunch \\\(1pm\\\)\*/);
});

test('a realistic multi-line listing round-trips without raw reserved chars leaking', () => {
  const text =
    'You have 2 events today:\n' +
    '- **Daily standup** at `10:00` (_Work_)\n' +
    '- **Leg day** at `16:00` (_Workouts_) — alarm 15 min before';
  const out = toTelegramMarkdown(text);
  // Bold/italic/code render correctly.
  assert.match(out, /\*Daily standup\*/);
  assert.match(out, /_Work_/);
  assert.match(out, /`10:00`/);
  // The em dash and parens in body text are escaped.
  assert.match(out, /\\-/);
  // No stray unescaped "(" that isn't preceded by a backslash.
  const strayParen = /(?<!\\)\(/.test(out);
  assert.equal(strayParen, false);
});

test('priority emoji and markers pass through unharmed', () => {
  const out = toTelegramMarkdown('🔴 **!High** Call the dentist');
  assert.match(out, /🔴/);
  // The "!" is reserved even inside a bold entity, so it is escaped: *\!High*.
  assert.match(out, /\*\\!High\*/);
});
