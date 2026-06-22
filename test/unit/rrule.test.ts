import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import ICAL from 'ical.js';
import {
  buildRrule,
  parseRrule,
  describeRecurrence,
  type Recurrence,
} from '../../src/tools/rrule';

// Interpret a local-time string in a fixed zone so the test is deterministic
// regardless of the host TZ.
const ZONE = 'America/Los_Angeles';
const toUtc = (iso: string): Date =>
  DateTime.fromISO(iso, { zone: ZONE }).toUTC().toJSDate();
const toLocal = (d: Date): string =>
  DateTime.fromJSDate(d).setZone(ZONE).toFormat("yyyy-LL-dd'T'HH:mm:ss");

test('buildRrule: simple weekly with byday', () => {
  const r: Recurrence = { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'] };
  assert.equal(buildRrule(r, toUtc), 'FREQ=WEEKLY;BYDAY=MO,WE,FR');
});

test('buildRrule: interval > 1 is emitted, interval 1 is omitted', () => {
  assert.equal(buildRrule({ freq: 'WEEKLY', interval: 2 }, toUtc), 'FREQ=WEEKLY;INTERVAL=2');
  assert.equal(buildRrule({ freq: 'DAILY', interval: 1 }, toUtc), 'FREQ=DAILY');
});

test('buildRrule: count', () => {
  assert.equal(buildRrule({ freq: 'MONTHLY', count: 6 }, toUtc), 'FREQ=MONTHLY;COUNT=6');
});

test('buildRrule: until is converted to UTC Z form', () => {
  const out = buildRrule({ freq: 'DAILY', until: '2026-12-31T09:00:00' }, toUtc);
  // 09:00 PST on 2026-12-31 = 17:00 UTC.
  assert.equal(out, 'FREQ=DAILY;UNTIL=20261231T170000Z');
});

test('buildRrule: count wins over until when both supplied (spec: mutually exclusive)', () => {
  const out = buildRrule({ freq: 'DAILY', count: 3, until: '2026-12-31' }, toUtc);
  assert.equal(out, 'FREQ=DAILY;COUNT=3');
});

test('buildRrule: invalid freq returns null', () => {
  assert.equal(buildRrule({ freq: 'HOURLY' as any }, toUtc), null);
  assert.equal(buildRrule({} as any, toUtc), null);
});

test('buildRrule: lowercase/odd weekday codes are normalized', () => {
  const out = buildRrule({ freq: 'WEEKLY', byday: ['mo', 'Tuesday' as any] }, toUtc);
  assert.equal(out, 'FREQ=WEEKLY;BYDAY=MO,TU');
});

test('parseRrule: round-trips freq/interval/byday', () => {
  const r = parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', toLocal);
  assert.equal(r?.freq, 'WEEKLY');
  assert.equal(r?.interval, 2);
  assert.deepEqual(r?.byday, ['MO', 'WE']);
});

test('parseRrule: UNTIL is converted back to local wall-clock', () => {
  const r = parseRrule('FREQ=DAILY;UNTIL=20261231T170000Z', toLocal);
  assert.equal(r?.until, '2026-12-31T09:00:00');
});

test('parseRrule: missing FREQ returns null', () => {
  assert.equal(parseRrule('INTERVAL=2', toLocal), null);
  assert.equal(parseRrule('', toLocal), null);
});

test('round-trip survives ICAL.Recur (the on-the-wire representation)', () => {
  // calendar.ts/reminders.ts store the rrule via ICAL.Recur.fromString(...).
  // Prove a build → ICAL.Recur → toString → parse cycle is stable.
  const built = buildRrule({ freq: 'WEEKLY', interval: 2, byday: ['TU', 'TH'], count: 10 }, toUtc);
  assert.ok(built);
  const viaIcal = ICAL.Recur.fromString(built!).toString();
  const reparsed = parseRrule(viaIcal, toLocal);
  assert.equal(reparsed?.freq, 'WEEKLY');
  assert.equal(reparsed?.interval, 2);
  assert.equal(reparsed?.count, 10);
  assert.deepEqual(reparsed?.byday, ['TU', 'TH']);
});

test('describeRecurrence: human-readable summaries', () => {
  assert.equal(describeRecurrence({ freq: 'DAILY' }), 'every day');
  assert.equal(describeRecurrence({ freq: 'WEEKLY', interval: 2 }), 'every 2 weeks');
  assert.equal(
    describeRecurrence({ freq: 'WEEKLY', byday: ['MO', 'WE'] }),
    'every week on Mon, Wed',
  );
  assert.equal(describeRecurrence({ freq: 'MONTHLY', count: 6 }), 'every month, 6 times');
});
