/**
 * Opaque UID handles exposed to the LLM.
 *
 * A handle is the base64url encoding of a CalDAV object URL (e.g.
 * `https://p36-caldav.icloud.com/.../calendars/<uuid>/<event-uuid>.ics`).
 * Encoding the full URL means update/delete don't need a second lookup to map
 * UID → URL, and `findCalendarForObjectUrl()` can resolve the owning collection
 * by prefix match. Shared by both the event (VEVENT) and reminder (VTODO) tools.
 */

export function encodeHandle(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeHandle(handle: string): string {
  return Buffer.from(handle, 'base64url').toString('utf8');
}
