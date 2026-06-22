import { test } from 'node:test';
import assert from 'node:assert/strict';

// buildIcs/parseIcs read USER_TIMEZONE via getUserTimezone(). Pin it before the
// module is imported so all-day local-date math is deterministic on any host.
process.env.USER_TIMEZONE = 'America/Los_Angeles';

import { buildIcs, parseIcs } from '../../src/tools/calendar';

test('timed event: summary, times, location, notes survive a build → parse round-trip', () => {
  const start = new Date('2026-06-15T17:30:00.000Z'); // 10:30 PDT
  const end = new Date('2026-06-15T18:30:00.000Z');
  const ics = buildIcs({
    uid: 'uid-1',
    summary: 'Dentist',
    startUtc: start,
    endUtc: end,
    description: 'bring insurance card',
    location: '123 Main St',
  });
  assert.match(ics, /BEGIN:VEVENT/);
  const parsed = parseIcs(ics);
  assert.ok(parsed);
  assert.equal(parsed!.summary, 'Dentist');
  assert.equal(parsed!.startUtc.getTime(), start.getTime());
  assert.equal(parsed!.endUtc.getTime(), end.getTime());
  assert.equal(parsed!.location, '123 Main St');
  assert.equal(parsed!.description, 'bring insurance card');
  assert.equal(parsed!.allDay, false);
});

test('VALARM: reminder_minutes_before is emitted and read back, de-duped', () => {
  const start = new Date('2026-06-15T17:00:00.000Z');
  const ics = buildIcs({
    uid: 'uid-2',
    summary: 'Meeting',
    startUtc: start,
    endUtc: new Date(start.getTime() + 3600_000),
    reminderMinutesBefore: [60, 0, 60], // duplicate 60 should collapse
  });
  const alarmCount = (ics.match(/BEGIN:VALARM/g) ?? []).length;
  assert.equal(alarmCount, 2);
  const parsed = parseIcs(ics);
  assert.ok(parsed);
  // Order isn't guaranteed; compare as sets.
  assert.deepEqual(new Set(parsed!.reminderMinutesBefore), new Set([60, 0]));
});

test('all-day event uses VALUE=DATE and reads back as all-day', () => {
  // Midnight local on 2026-05-25, exclusive end next day.
  const startUtc = new Date('2026-05-25T07:00:00.000Z'); // 00:00 PDT
  const endUtc = new Date('2026-05-26T07:00:00.000Z');
  const ics = buildIcs({
    uid: 'uid-3',
    summary: 'Birthday',
    startUtc,
    endUtc,
    allDay: true,
  });
  assert.match(ics, /DTSTART;VALUE=DATE:20260525/);
  const parsed = parseIcs(ics);
  assert.ok(parsed);
  assert.equal(parsed!.allDay, true);
});

test('RRULE: recurring event round-trips through buildIcs/parseIcs', () => {
  const start = new Date('2026-06-15T17:00:00.000Z');
  const ics = buildIcs({
    uid: 'uid-4',
    summary: 'Standup',
    startUtc: start,
    endUtc: new Date(start.getTime() + 900_000),
    rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10',
  });
  assert.match(ics, /RRULE:/);
  const parsed = parseIcs(ics);
  assert.ok(parsed);
  assert.ok(parsed!.rrule);
  assert.match(parsed!.rrule!, /FREQ=WEEKLY/);
  assert.match(parsed!.rrule!, /BYDAY=MO,WE,FR/);
  assert.match(parsed!.rrule!, /COUNT=10/);
});

test('non-recurring event has null rrule', () => {
  const start = new Date('2026-06-15T17:00:00.000Z');
  const parsed = parseIcs(
    buildIcs({
      uid: 'uid-5',
      summary: 'One off',
      startUtc: start,
      endUtc: new Date(start.getTime() + 900_000),
    }),
  );
  assert.equal(parsed!.rrule, null);
});

test('parseIcs returns null on garbage input (does not throw)', () => {
  assert.equal(parseIcs('not an ics file'), null);
});
