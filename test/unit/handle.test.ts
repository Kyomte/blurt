import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeHandle, decodeHandle } from '../../src/tools/handle';

test('encodeHandle round-trips a CalDAV object URL', () => {
  const url =
    'https://p36-caldav.icloud.com/123456789/calendars/AB12-CD34/event-uuid.ics';
  const handle = encodeHandle(url);
  assert.equal(decodeHandle(handle), url);
});

test('encoded handle is base64url (no +, /, or = padding)', () => {
  // A URL with characters that base64 would encode to +/= so we can prove the
  // url-safe variant is used (handles travel through the LLM and JSON unescaped).
  const url = 'https://example.com/a?b=c&d=e/f+g';
  const handle = encodeHandle(url);
  assert.doesNotMatch(handle, /[+/=]/);
  assert.equal(decodeHandle(handle), url);
});

test('decodeHandle reverses encodeHandle for unicode summaries in URLs', () => {
  const url = 'https://example.com/カレンダー/イベント.ics';
  assert.equal(decodeHandle(encodeHandle(url)), url);
});
