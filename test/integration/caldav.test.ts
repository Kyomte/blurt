import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Integration tests hit the REAL iCloud CalDAV server, so they are gated behind
 * live credentials. They run only when ICLOUD_USERNAME + ICLOUD_APP_PASSWORD are
 * present (and USER_TIMEZONE for deterministic time handling). Without them the
 * suite skips cleanly instead of failing — so `npm test` stays green on a fresh
 * checkout while `npm run test:integration` exercises the full create → list →
 * update → delete round-trip on a real account.
 *
 * Run: ICLOUD_USERNAME=... ICLOUD_APP_PASSWORD=... USER_TIMEZONE=America/Los_Angeles \
 *      npm run test:integration
 */
const HAS_CREDS =
  !!process.env.ICLOUD_USERNAME?.trim() &&
  !!process.env.ICLOUD_APP_PASSWORD?.trim();

if (!process.env.USER_TIMEZONE?.trim()) {
  // Keep timezone math deterministic if the caller forgot to set one.
  process.env.USER_TIMEZONE = 'UTC';
}

test('CalDAV event lifecycle: create → list → update → delete', { skip: !HAS_CREDS }, async () => {
  // Imported lazily so the module's env reads happen after the skip check.
  const { createCalendarEvent, listCalendarEvents, updateCalendarEvent, deleteCalendarEvent } =
    await import('../../src/tools/calendar');

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  const title = `__blurt_itest_${stamp}`;

  // Schedule it ~2 days out at a fixed local time to avoid colliding with today.
  const day = new Date();
  day.setDate(day.getDate() + 2);
  const date = day.toISOString().slice(0, 10);
  const start = `${date}T09:00:00`;
  const end = `${date}T09:30:00`;

  // CREATE
  const created = JSON.parse(await createCalendarEvent({ title, start_datetime: start, end_datetime: end }));
  assert.ok(created.uid, 'create should return a uid handle');
  const uid: string = created.uid;

  try {
    // LIST — the new event should appear in that day's range.
    const listed = JSON.parse(
      await listCalendarEvents({ start_date: `${date}T00:00:00`, end_date: `${date}T23:59:59` }),
    );
    const found = listed.events.find((e: { title: string }) => e.title === title);
    assert.ok(found, 'created event should be listed');
    assert.equal(found.all_day, false);

    // UPDATE — move 30 min later.
    const updated = JSON.parse(
      await updateCalendarEvent({
        event_uid: uid,
        start_datetime: `${date}T09:30:00`,
        end_datetime: `${date}T10:00:00`,
      }),
    );
    assert.equal(updated.ok, true, 'update should succeed');
  } finally {
    // DELETE — always clean up the test artifact.
    const deleted = JSON.parse(await deleteCalendarEvent({ event_uid: uid }));
    assert.equal(deleted.ok, true, 'delete should succeed');
  }
});

test('CalDAV recurring event round-trips RRULE', { skip: !HAS_CREDS }, async () => {
  const { createCalendarEvent, listCalendarEvents, deleteCalendarEvent } =
    await import('../../src/tools/calendar');

  const stamp = Date.now();
  const title = `__blurt_itest_recur_${stamp}`;
  const day = new Date();
  day.setDate(day.getDate() + 1);
  const date = day.toISOString().slice(0, 10);

  const created = JSON.parse(
    await createCalendarEvent({
      title,
      start_datetime: `${date}T08:00:00`,
      end_datetime: `${date}T08:30:00`,
      recurrence: { freq: 'WEEKLY', byday: ['MO', 'WE', 'FR'], count: 4 },
    }),
  );
  const uid: string = created.uid;
  try {
    const listed = JSON.parse(
      await listCalendarEvents({ start_date: `${date}T00:00:00`, end_date: `${date}T23:59:59` }),
    );
    const found = listed.events.find((e: { title: string }) => e.title === title);
    assert.ok(found, 'recurring event should be listed');
    assert.ok(found.recurrence, 'recurrence should round-trip on read');
    assert.equal(found.recurrence.freq, 'WEEKLY');
    assert.deepEqual(found.recurrence.byday, ['MO', 'WE', 'FR']);
  } finally {
    await deleteCalendarEvent({ event_uid: uid });
  }
});
