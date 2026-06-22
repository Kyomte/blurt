import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import ICAL from 'ical.js';
import {
  getClient,
  getAllCalendars,
  getCalendarByName,
  findCalendarForObjectUrl,
  getUserTimezone,
} from './caldav';
import { encodeHandle, decodeHandle } from './handle';
import { buildRrule, parseRrule, describeRecurrence, type Recurrence } from './rrule';

export interface CreateEventInput {
  title: string;
  start_datetime: string;
  end_datetime: string;
  calendar_name?: string;
  notes?: string;
  location?: string;
  reminder_minutes_before?: number[];
  all_day?: boolean;
  recurrence?: Recurrence;
}

export interface ListEventsInput {
  start_date: string;
  end_date: string;
  calendar_name?: string;
}

export interface UpdateEventInput {
  event_uid: string;
  title?: string;
  start_datetime?: string;
  end_datetime?: string;
  notes?: string;
  location?: string;
  reminder_minutes_before?: number[];
  all_day?: boolean;
  /** Pass a recurrence to set/replace; pass null to remove recurrence. Omit to keep. */
  recurrence?: Recurrence | null;
}

export interface DeleteEventInput {
  event_uid: string;
}

export interface CalendarEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  notes: string;
  location: string;
  calendar: string;
  reminders_minutes_before: number[];
  all_day: boolean;
  recurrence: Recurrence | null;
}

// ---------- Time helpers ----------

function parseLocalToUTC(localIso: string): Date {
  const tz = getUserTimezone();
  const dt = DateTime.fromISO(localIso, { zone: tz });
  if (!dt.isValid) {
    throw new Error(`Invalid datetime "${localIso}": ${dt.invalidReason}`);
  }
  return dt.toUTC().toJSDate();
}

function utcToLocalIso(date: Date): string {
  const tz = getUserTimezone();
  return DateTime.fromJSDate(date).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

// ---------- ICS building / parsing ----------

export interface VeventFields {
  uid: string;
  summary: string;
  startUtc: Date;
  endUtc: Date;
  description?: string;
  location?: string;
  reminderMinutesBefore?: number[];
  allDay?: boolean;
  /** Raw RFC 5545 RRULE string (without the "RRULE:" prefix), if recurring. */
  rrule?: string | null;
}

/** Parse a local date or datetime as a Luxon DateTime in the user's tz. */
function parseLocalDateOrDateTime(input: string): DateTime {
  const tz = getUserTimezone();
  return DateTime.fromISO(input, { zone: tz });
}

/** Returns true if the input looks like a date-only string (YYYY-MM-DD). */
function isDateOnly(input: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(input.trim());
}

function triggerStringFor(minutesBefore: number): string {
  if (minutesBefore === 0) return 'PT0S';
  const m = Math.max(0, Math.round(minutesBefore));
  return `-PT${m}M`;
}

function buildValarm(minutesBefore: number, summary: string): ICAL.Component {
  const valarm = new ICAL.Component('valarm');
  valarm.updatePropertyWithValue('action', 'DISPLAY');
  valarm.updatePropertyWithValue('description', summary || 'Reminder');
  valarm.updatePropertyWithValue(
    'trigger',
    ICAL.Duration.fromString(triggerStringFor(minutesBefore)),
  );
  return valarm;
}

export function buildIcs(fields: VeventFields): string {
  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('prodid', '-//Blurt//EN');
  vcalendar.updatePropertyWithValue('version', '2.0');

  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', fields.uid);
  vevent.updatePropertyWithValue('summary', fields.summary);
  vevent.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(), true),
  );

  if (fields.allDay) {
    // All-day event: use VALUE=DATE form (no time component, no timezone).
    // DTEND for all-day is EXCLUSIVE — must be the day after the last day.
    const tz = getUserTimezone();
    const startLocal = DateTime.fromJSDate(fields.startUtc).setZone(tz);
    const endLocal = DateTime.fromJSDate(fields.endUtc).setZone(tz);
    const startDate = ICAL.Time.fromDateString(startLocal.toFormat('yyyy-LL-dd'));
    startDate.isDate = true;
    const endDate = ICAL.Time.fromDateString(endLocal.toFormat('yyyy-LL-dd'));
    endDate.isDate = true;
    vevent.updatePropertyWithValue('dtstart', startDate);
    vevent.updatePropertyWithValue('dtend', endDate);
  } else {
    vevent.updatePropertyWithValue(
      'dtstart',
      ICAL.Time.fromJSDate(fields.startUtc, true),
    );
    vevent.updatePropertyWithValue(
      'dtend',
      ICAL.Time.fromJSDate(fields.endUtc, true),
    );
  }
  if (fields.description !== undefined && fields.description.length > 0) {
    vevent.updatePropertyWithValue('description', fields.description);
  }
  if (fields.location !== undefined && fields.location.length > 0) {
    vevent.updatePropertyWithValue('location', fields.location);
  }

  if (fields.rrule) {
    // RRULE is a structured "recur" value in iCalendar. ical.js accepts a recur
    // object built from the string; this also validates the rule shape.
    vevent.updatePropertyWithValue('rrule', ICAL.Recur.fromString(fields.rrule));
  }

  if (fields.reminderMinutesBefore && fields.reminderMinutesBefore.length > 0) {
    // De-dupe and sort largest-first (= earliest reminder first)
    const unique = Array.from(new Set(fields.reminderMinutesBefore.map((n) => Math.max(0, Math.round(n)))));
    unique.sort((a, b) => b - a);
    for (const m of unique) {
      vevent.addSubcomponent(buildValarm(m, fields.summary));
    }
  }

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}

export function parseIcs(ics: string): VeventFields | null {
  try {
    const jcal = ICAL.parse(ics);
    const vcal = new ICAL.Component(jcal);
    const vevent = vcal.getFirstSubcomponent('vevent');
    if (!vevent) return null;

    const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
    const dtend = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null;
    if (!dtstart || !dtend) return null;

    const reminders: number[] = [];
    for (const va of vevent.getAllSubcomponents('valarm')) {
      const trigger = va.getFirstPropertyValue('trigger');
      if (!trigger) continue;
      // Duration-typed trigger (relative). Skip absolute date-time triggers.
      if (trigger instanceof ICAL.Duration) {
        const totalSeconds = trigger.toSeconds(); // negative means "before"
        const minutesBefore = Math.round(-totalSeconds / 60);
        if (minutesBefore >= 0) reminders.push(minutesBefore);
      }
    }

    const rruleVal = vevent.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    // ical.js returns a Recur object; .toString() gives the canonical RRULE body.
    const rrule = rruleVal ? rruleVal.toString() : null;

    return {
      uid: (vevent.getFirstPropertyValue('uid') as string) ?? '',
      summary: (vevent.getFirstPropertyValue('summary') as string) ?? '',
      startUtc: dtstart.toJSDate(),
      endUtc: dtend.toJSDate(),
      description:
        (vevent.getFirstPropertyValue('description') as string | null) ?? undefined,
      location:
        (vevent.getFirstPropertyValue('location') as string | null) ?? undefined,
      reminderMinutesBefore: reminders,
      allDay: dtstart.isDate === true,
      rrule,
    };
  } catch (err) {
    console.warn('[caldav] Failed to parse ICS:', err);
    return null;
  }
}

// ---------- Operations ----------

export async function createCalendarEvent(input: CreateEventInput): Promise<string> {
  const client = await getClient();
  const calendar = await getCalendarByName(input.calendar_name);
  const calName =
    typeof calendar.displayName === 'string' ? calendar.displayName : 'calendar';

  const uid = randomUUID();

  // Auto-detect all-day if either input looks like a date-only string.
  const allDay =
    input.all_day === true ||
    isDateOnly(input.start_datetime) ||
    isDateOnly(input.end_datetime);

  // For all-day events, accept either YYYY-MM-DD or full ISO; parse as midnight in user's tz.
  const tz = getUserTimezone();
  const startDt = allDay
    ? DateTime.fromISO(input.start_datetime.slice(0, 10), { zone: tz }).startOf('day')
    : parseLocalDateOrDateTime(input.start_datetime);
  let endDt = allDay
    ? DateTime.fromISO(input.end_datetime.slice(0, 10), { zone: tz }).startOf('day')
    : parseLocalDateOrDateTime(input.end_datetime);

  // For all-day, if user gave the same date for start & end (a single-day event),
  // ensure DTEND is the next day (iCal all-day DTEND is exclusive).
  if (allDay && endDt <= startDt) {
    endDt = startDt.plus({ days: 1 });
  }

  if (!startDt.isValid || !endDt.isValid) {
    throw new Error(`Invalid datetime input: start=${input.start_datetime}, end=${input.end_datetime}`);
  }

  const startUtc = startDt.toUTC().toJSDate();
  const endUtc = endDt.toUTC().toJSDate();

  if (!allDay && endUtc.getTime() <= startUtc.getTime()) {
    throw new Error('end_datetime must be after start_datetime');
  }

  const rrule = input.recurrence
    ? buildRrule(input.recurrence, parseLocalToUTC)
    : null;

  const ics = buildIcs({
    uid,
    summary: input.title,
    startUtc,
    endUtc,
    description: input.notes,
    location: input.location,
    reminderMinutesBefore: input.reminder_minutes_before,
    allDay,
    rrule,
  });

  const filename = `${uid}.ics`;
  await client.createCalendarObject({
    calendar,
    filename,
    iCalString: ics,
  });

  const calendarUrl = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
  const objectUrl = `${calendarUrl}${filename}`;

  const recurrenceNote = rrule
    ? ` Repeats ${describeRecurrence(input.recurrence as Recurrence)}.`
    : '';

  return JSON.stringify({
    uid: encodeHandle(objectUrl),
    calendar: calName,
    message: `Created "${input.title}" in calendar "${calName}" from ${input.start_datetime} to ${input.end_datetime} (${getUserTimezone()}).${recurrenceNote}`,
  });
}

export async function listCalendarEvents(input: ListEventsInput): Promise<string> {
  const client = await getClient();

  const startUtc = parseLocalToUTC(input.start_date);
  const endUtc = parseLocalToUTC(input.end_date);

  const calendars = input.calendar_name
    ? [await getCalendarByName(input.calendar_name)]
    : await getAllCalendars();

  // Query each calendar in parallel.
  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: {
            start: startUtc.toISOString(),
            end: endUtc.toISOString(),
          },
          expand: false,
        });
        const calName =
          typeof cal.displayName === 'string' ? cal.displayName : '(unnamed)';
        const events: CalendarEvent[] = [];
        for (const obj of objects) {
          if (!obj.data) continue;
          const parsed = parseIcs(obj.data);
          if (!parsed) continue;
          // For one-off events, drop anything outside the queried window. For
          // recurring events we keep them even if the FIRST instance predates
          // the range — the server already returned them because an occurrence
          // falls inside it (expand:false sends the master VEVENT).
          if (!parsed.rrule && (parsed.endUtc < startUtc || parsed.startUtc > endUtc)) {
            continue;
          }
          const isAllDay = parsed.allDay === true;
          events.push({
            uid: encodeHandle(obj.url),
            title: parsed.summary,
            start: isAllDay
              ? DateTime.fromJSDate(parsed.startUtc).toUTC().toFormat('yyyy-LL-dd')
              : utcToLocalIso(parsed.startUtc),
            end: isAllDay
              ? DateTime.fromJSDate(parsed.endUtc).toUTC().toFormat('yyyy-LL-dd')
              : utcToLocalIso(parsed.endUtc),
            notes: parsed.description ?? '',
            location: parsed.location ?? '',
            calendar: calName,
            reminders_minutes_before: parsed.reminderMinutesBefore ?? [],
            all_day: isAllDay,
            recurrence: parsed.rrule
              ? parseRrule(parsed.rrule, utcToLocalIso)
              : null,
          });
        }
        return events;
      } catch (err) {
        console.warn(
          `[caldav] Failed to list events in calendar "${cal.displayName}":`,
          err,
        );
        return [];
      }
    }),
  );

  const events = perCalendar.flat();
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return JSON.stringify({
    events,
    count: events.length,
    timezone: getUserTimezone(),
  });
}

export async function updateCalendarEvent(input: UpdateEventInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.event_uid);

  const calendar = await findCalendarForObjectUrl(objectUrl);
  if (!calendar) {
    return JSON.stringify({
      ok: false,
      message: 'Event not found (could not match URL to any calendar).',
    });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing || !existing.data) {
    return JSON.stringify({ ok: false, message: 'Event not found.' });
  }

  const parsed = parseIcs(existing.data);
  if (!parsed) {
    return JSON.stringify({ ok: false, message: 'Could not parse existing event.' });
  }

  const newSummary = input.title ?? parsed.summary;
  const newStartUtc = input.start_datetime
    ? parseLocalToUTC(input.start_datetime)
    : parsed.startUtc;
  const newEndUtc = input.end_datetime
    ? parseLocalToUTC(input.end_datetime)
    : parsed.endUtc;
  const newDescription =
    input.notes !== undefined ? input.notes : parsed.description;
  const newLocation =
    input.location !== undefined ? input.location : parsed.location;
  const newReminders =
    input.reminder_minutes_before !== undefined
      ? input.reminder_minutes_before
      : parsed.reminderMinutesBefore;
  const newAllDay =
    input.all_day !== undefined ? input.all_day : parsed.allDay === true;
  // recurrence: undefined = keep existing, null = remove, object = set/replace.
  const newRrule =
    input.recurrence === undefined
      ? parsed.rrule
      : input.recurrence === null
        ? null
        : buildRrule(input.recurrence, parseLocalToUTC);

  if (!newAllDay && newEndUtc.getTime() <= newStartUtc.getTime()) {
    throw new Error('end_datetime must be after start_datetime');
  }

  const newIcs = buildIcs({
    uid: parsed.uid,
    summary: newSummary,
    startUtc: newStartUtc,
    endUtc: newEndUtc,
    description: newDescription,
    location: newLocation,
    reminderMinutesBefore: newReminders,
    allDay: newAllDay,
    rrule: newRrule,
  });

  await client.updateCalendarObject({
    calendarObject: {
      url: existing.url,
      etag: existing.etag,
      data: newIcs,
    },
  });

  return JSON.stringify({ ok: true, message: 'Event updated.' });
}

export async function deleteCalendarEvent(input: DeleteEventInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.event_uid);

  const calendar = await findCalendarForObjectUrl(objectUrl);
  if (!calendar) {
    return JSON.stringify({
      ok: false,
      message: 'Event not found (could not match URL to any calendar).',
    });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing) {
    return JSON.stringify({ ok: false, message: 'Event not found.' });
  }

  await client.deleteCalendarObject({
    calendarObject: {
      url: existing.url,
      etag: existing.etag,
    },
  });

  return JSON.stringify({ ok: true, message: 'Event deleted.' });
}
