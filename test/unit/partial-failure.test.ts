import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolResultFailed, partialFailureNote } from '../../src/agent';

const ok = (content = '{"ok":true}') => ({ content, isError: false });
const thrown = (content = 'Error: boom') => ({ content, isError: true });
const softFail = () => ({ content: '{"ok":false,"message":"not found"}', isError: false });

test('toolResultFailed: isError flag counts as failure', () => {
  assert.equal(toolResultFailed(thrown()), true);
});

test('toolResultFailed: soft {"ok":false} counts as failure even without isError', () => {
  assert.equal(toolResultFailed(softFail()), true);
});

test('toolResultFailed: {"ok":true} and non-JSON success do not count', () => {
  assert.equal(toolResultFailed(ok()), false);
  assert.equal(toolResultFailed({ content: 'plain success text', isError: false }), false);
});

test('partialFailureNote: null for a single tool call', () => {
  assert.equal(
    partialFailureNote([{ name: 'create_calendar_event' }], [thrown()]),
    null,
  );
});

test('partialFailureNote: null when all succeed', () => {
  assert.equal(
    partialFailureNote(
      [{ name: 'create_calendar_event' }, { name: 'create_calendar_event' }],
      [ok(), ok()],
    ),
    null,
  );
});

test('partialFailureNote: null when all fail (uniform — isError covers it)', () => {
  assert.equal(
    partialFailureNote(
      [{ name: 'create_calendar_event' }, { name: 'create_calendar_event' }],
      [thrown(), thrown()],
    ),
    null,
  );
});

test('partialFailureNote: mixed batch produces a note with the right counts', () => {
  const note = partialFailureNote(
    [
      { name: 'create_calendar_event' },
      { name: 'create_calendar_event' },
      { name: 'create_calendar_event' },
    ],
    [ok(), thrown(), softFail()],
  );
  assert.ok(note);
  assert.match(note!, /1 of 3 tool call\(s\) in this batch succeeded and 2 failed/);
  assert.match(note!, /NOT automatically rolled back/);
  assert.match(note!, /do not claim the whole request succeeded/);
});

test('partialFailureNote: read-only mixed batch omits the rollback caveat', () => {
  const note = partialFailureNote(
    [{ name: 'list_calendar_events' }, { name: 'list_reminders' }],
    [ok('{"events":[]}'), thrown()],
  );
  assert.ok(note);
  assert.doesNotMatch(note!, /rolled back/);
});
