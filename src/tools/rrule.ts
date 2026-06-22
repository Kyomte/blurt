/**
 * Recurrence (RFC 5545 RRULE) helpers.
 *
 * The LLM passes a small structured `recurrence` object rather than a raw RRULE
 * string — that is far less error-prone for a model to emit than hand-writing
 * `FREQ=WEEKLY;BYDAY=MO,WE;...`. We translate it to/from an RRULE string here so
 * calendar.ts (VEVENT) and reminders.ts (VTODO) stay focused on ICS assembly.
 */

import { DateTime } from 'luxon';

export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  /** How often the item repeats. */
  freq: RecurrenceFreq;
  /** Step between occurrences (every N units). Defaults to 1. */
  interval?: number;
  /** Total number of occurrences. Mutually exclusive with `until`. */
  count?: number;
  /**
   * Local date or datetime of the last occurrence (inclusive), same wall-clock
   * format the rest of the tools use (e.g. "2026-12-31" or "2026-12-31T09:00:00").
   * Mutually exclusive with `count`.
   */
  until?: string;
  /**
   * Days of week for WEEKLY recurrence, e.g. ["MO","WE","FR"]. Two-letter codes
   * SU MO TU WE TH FR SA.
   */
  byday?: Weekday[];
}

const FREQS: RecurrenceFreq[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

function normalizeWeekday(d: string): Weekday | null {
  const up = d.trim().toUpperCase().slice(0, 2) as Weekday;
  return WEEKDAYS.includes(up) ? up : null;
}

/**
 * Build an RFC 5545 RRULE string from a structured recurrence.
 * `untilToUtc` converts a local until-string to a UTC Date (callers pass their
 * existing parseLocalToUTC so timezone handling stays in one place).
 * Returns null for an invalid/empty recurrence (caller then omits RRULE).
 */
export function buildRrule(
  recurrence: Recurrence,
  untilToUtc: (iso: string) => Date,
): string | null {
  if (!recurrence || typeof recurrence !== 'object') return null;
  const freq = String(recurrence.freq || '').toUpperCase() as RecurrenceFreq;
  if (!FREQS.includes(freq)) return null;

  const parts: string[] = [`FREQ=${freq}`];

  const interval = recurrence.interval;
  if (typeof interval === 'number' && Number.isFinite(interval) && interval > 1) {
    parts.push(`INTERVAL=${Math.round(interval)}`);
  }

  if (Array.isArray(recurrence.byday) && recurrence.byday.length > 0) {
    const days = recurrence.byday
      .map((d) => normalizeWeekday(String(d)))
      .filter((d): d is Weekday => d !== null);
    if (days.length > 0) parts.push(`BYDAY=${days.join(',')}`);
  }

  // COUNT and UNTIL are mutually exclusive per the spec; COUNT wins if both given.
  if (typeof recurrence.count === 'number' && recurrence.count > 0) {
    parts.push(`COUNT=${Math.round(recurrence.count)}`);
  } else if (typeof recurrence.until === 'string' && recurrence.until.trim()) {
    const utc = untilToUtc(recurrence.until);
    // UTC form with Z suffix — the canonical UNTIL representation.
    const until = DateTime.fromJSDate(utc).toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
    parts.push(`UNTIL=${until}`);
  }

  return parts.join(';');
}

/**
 * Parse an RRULE string back into a structured recurrence for display when
 * listing. `untilToLocal` converts a UTC Date to a local wall-clock string.
 * Returns null if the string isn't a usable RRULE.
 */
export function parseRrule(
  rrule: string,
  untilToLocal: (d: Date) => string,
): Recurrence | null {
  if (!rrule || typeof rrule !== 'string') return null;
  const map = new Map<string, string>();
  for (const part of rrule.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) map.set(k.trim().toUpperCase(), v.trim());
  }
  const freqRaw = map.get('FREQ');
  if (!freqRaw) return null;
  const freq = freqRaw.toUpperCase() as RecurrenceFreq;
  if (!FREQS.includes(freq)) return null;

  const out: Recurrence = { freq };
  const interval = map.get('INTERVAL');
  if (interval && Number.isFinite(Number(interval))) out.interval = Number(interval);
  const count = map.get('COUNT');
  if (count && Number.isFinite(Number(count))) out.count = Number(count);
  const byday = map.get('BYDAY');
  if (byday) {
    const days = byday
      .split(',')
      .map((d) => normalizeWeekday(d))
      .filter((d): d is Weekday => d !== null);
    if (days.length > 0) out.byday = days;
  }
  const until = map.get('UNTIL');
  if (until) {
    // UNTIL is typically UTC (trailing Z). Fall back to floating if not.
    const dt = until.endsWith('Z')
      ? DateTime.fromFormat(until, "yyyyLLdd'T'HHmmss'Z'", { zone: 'utc' })
      : DateTime.fromFormat(until.replace(/Z$/, ''), "yyyyLLdd'T'HHmmss", { zone: 'utc' });
    const dateOnly = DateTime.fromFormat(until, 'yyyyLLdd', { zone: 'utc' });
    const parsed = dt.isValid ? dt : dateOnly;
    if (parsed.isValid) out.until = untilToLocal(parsed.toJSDate());
  }
  return out;
}

/** Compact human summary for confirmations, e.g. "every 2 weeks on Mon, Wed". */
export function describeRecurrence(r: Recurrence): string {
  const interval = r.interval && r.interval > 1 ? r.interval : 1;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  const dayNames: Record<Weekday, string> = {
    SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat',
  };
  let s = interval === 1 ? `every ${unit}` : `every ${interval} ${unit}s`;
  if (r.byday && r.byday.length > 0) {
    s += ` on ${r.byday.map((d) => dayNames[d]).join(', ')}`;
  }
  if (r.count) s += `, ${r.count} times`;
  else if (r.until) s += `, until ${r.until}`;
  return s;
}
