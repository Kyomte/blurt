import { calendarTools } from './tools/definitions';
import { dispatchTool } from './tools/dispatcher';
import {
  getCalendarNames,
  getReminderListNames,
  getAccountCapabilities,
} from './tools/caldav';
import { getProvider } from './providers';
import type { Message, TextBlock, ToolResultBlock, ToolUseBlock } from './providers';

export type { Message } from './providers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithBackoff<T>(
  fn: () => Promise<T>,
  label: string,
  isRetryable: (err: unknown) => boolean,
): Promise<T> {
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const status = (err as { status?: number }).status;
      const waitMs = Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 500;
      console.warn(
        `[${label}] HTTP ${status} (attempt ${attempt + 1}/${maxAttempts}) — retrying in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 8;

/** Tools that mutate state — relevant to partial-failure reporting. */
const WRITE_TOOLS = new Set([
  'create_calendar_event',
  'update_calendar_event',
  'delete_calendar_event',
  'create_reminder',
  'update_reminder',
  'delete_reminder',
]);

/**
 * A tool result counts as a failure if it threw (isError) OR if it returned a
 * structured soft-failure ({"ok":false,...}). The soft-failure case matters:
 * update/delete return `{ok:false, message:"...not found"}` instead of throwing,
 * so a batch can be "partially failed" without any isError flag set.
 */
export function toolResultFailed(result: { content: string; isError: boolean }): boolean {
  if (result.isError) return true;
  try {
    const parsed = JSON.parse(result.content);
    return parsed && typeof parsed === 'object' && parsed.ok === false;
  } catch {
    return false;
  }
}

/**
 * When a single assistant turn fired multiple tool calls and the batch is mixed
 * (at least one succeeded AND at least one failed), the model needs an explicit
 * heads-up — otherwise it tends to report blanket success. Returns a note to
 * append to the tool-results turn, or null if the batch was all-success or
 * all-failure (the per-result isError flags already cover the uniform cases).
 *
 * We can't atomically roll back CalDAV writes, so the honest behavior is to make
 * the partial state loud and let the model relay exactly what did and didn't
 * happen to the user.
 */
export function partialFailureNote(
  blocks: { name: string }[],
  results: { content: string; isError: boolean }[],
): string | null {
  if (blocks.length < 2) return null;
  const failed = results.filter((r) => toolResultFailed(r)).length;
  const succeeded = results.length - failed;
  if (failed === 0 || succeeded === 0) return null;

  const anyWrite = blocks.some((b) => WRITE_TOOLS.has(b.name));
  const writeCaveat = anyWrite
    ? ' These changes are NOT automatically rolled back.'
    : '';
  return (
    `PARTIAL FAILURE: ${succeeded} of ${results.length} tool call(s) in this batch ` +
    `succeeded and ${failed} failed.${writeCaveat} Tell the user specifically which ` +
    `actions succeeded and which failed — do not claim the whole request succeeded.`
  );
}

function todayString(): string {
  const tz = process.env.USER_TIMEZONE?.trim() || 'UTC';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${fmt.format(now)} (${tz})`;
}

/**
 * The events-vs-reminders guidance block. Built dynamically from the detected
 * account capability so the hardcoded "default to events" assumption is only
 * applied when it actually holds:
 * - hasReminderLists === false → the account has NO CalDAV VTODO collections at
 *   all (typical of accounts migrated to modern CloudKit Reminders). Writing a
 *   reminder would silently fail, so the model must ALWAYS use calendar events.
 * - hasReminderLists === true → reminder lists exist, but writes to legacy
 *   CalDAV reminders may still not surface in the modern Reminders app. Keep the
 *   "default to events, use reminders only when explicitly asked" heuristic.
 */
export function eventsVsRemindersBlock(hasReminderLists: boolean): string {
  if (!hasReminderLists) {
    return `=== ALWAYS USE EVENTS — this account has no usable Apple Reminders lists ===
This iCloud account exposes NO CalDAV reminder (VTODO) lists — it has been migrated to modern CloudKit Reminders, which this bot can't write to. So NEVER use create_reminder; it would fail. For every "remind me / add a task" request, create a calendar event instead:
- "Remind me to X at <time>" → create_calendar_event, 15-minute duration, reminder_minutes_before=[0] (alarm at start). Title = "X".
- "Remind me to X tomorrow / Friday / next week" (no specific time) → ask what time the alarm should fire, then create an event.
- "Remind me to X" with no day/time at all → ask for both day and time.

=== Calendar events (technical detail) ===
- Apple Calendar EVENTS (create_calendar_event etc): time-blocked items with start AND end times. "Meeting at 3pm for 1 hr", "Workout 7-8am", "Dentist Friday at 2pm".`;
  }
  return `=== DEFAULT TO EVENTS for "remind me to ..." ===
Apple Reminders (VTODO) doesn't sync reliably to this user's Reminders app due to iCloud's legacy/CloudKit split. So:
- "Remind me to X at <time>" → CREATE A CALENDAR EVENT, not a reminder. Use create_calendar_event with a 15-minute duration and reminder_minutes_before=[0] (alarm at start). Title = "X".
- "Remind me to X tomorrow / Friday / next week" (no specific time) → Ask the user what time they want the reminder/alarm to fire, then create an event.
- "Remind me to X" with no day/time at all → Ask for both day and time.
- Use create_reminder (VTODO) only if the user EXPLICITLY says "add to my reminders list", "add a task", or "in Apple Reminders". Otherwise default to events.

=== Calendar events vs Apple Reminders (technical distinction, mostly for advanced cases) ===
- Apple Calendar EVENTS (create_calendar_event etc): time-blocked items with start AND end times. "Meeting at 3pm for 1 hr", "Workout 7-8am", "Dentist Friday at 2pm".
- Apple REMINDERS / tasks (create_reminder etc): a to-do, optionally with a due time. Stored separately. May not show in the modern Reminders app for this account.`;
}

async function buildSystemPrompt(): Promise<string> {
  const tz = process.env.USER_TIMEZONE?.trim() || 'UTC';
  let calendarsBlock = '';
  let remindersBlock = '';
  let hasReminderLists = false;
  try {
    const caps = await getAccountCapabilities();
    hasReminderLists = caps.hasReminderLists;
  } catch (err) {
    // On a probe failure, fall back to the conservative "lists may exist"
    // heuristic — never silently lock the user out of reminders they have.
    console.warn('[blurt] Could not detect account capabilities:', err);
    hasReminderLists = true;
  }
  try {
    const names = await getCalendarNames();
    if (names.length > 0) {
      calendarsBlock = `\nAvailable event calendars (use the exact name in calendar_name):\n${names.map((n) => `- ${n}`).join('\n')}\n`;
    }
  } catch (err) {
    console.warn('[blurt] Could not load calendar list:', err);
  }
  if (hasReminderLists) {
    try {
      const names = await getReminderListNames();
      if (names.length > 0) {
        remindersBlock = `\nAvailable reminder lists (use the exact name in list_name):\n${names.map((n) => `- ${n}`).join('\n')}\n`;
      }
    } catch (err) {
      console.warn('[blurt] Could not load reminder lists:', err);
    }
  }

  return `You are Blurt, a helpful assistant managing the user's iCloud / Apple Calendar AND Apple Reminders via CalDAV tools.

Right now it is ${todayString()}. The user's timezone is ${tz}.
${calendarsBlock}${remindersBlock}
${eventsVsRemindersBlock(hasReminderLists)}

Choosing an event calendar (create_calendar_event):
- HARD RULES (always follow these first):
  • Climbing, bouldering, gym session, or any climbing/bouldering-related activity → "Workouts"
  • Lunch, dinner, breakfast, shower, or other daily routine/meal activities → "NA"
- General inference (if no hard rule matches): Workout/run/exercise → "Workouts"; class/lecture/exam → "School"; team standup/work meeting → "Work"; family/shared event → "Personal"; otherwise pick the most fitting one.
- If unsure, omit calendar_name.

Event alerts (reminder_minutes_before on an event, NOT a reminder list):
- Use reminder_minutes_before to attach Apple Calendar alerts to an event (VALARM). Common: 0 (at start), 5, 10, 15, 30, 60, 120, 1440 (1 day).
- "Remind me 1 hour before the meeting" → set reminder_minutes_before [60] on the event, NOT a separate reminder.
${hasReminderLists ? '- "Remind me to ..." with no event context → use create_reminder.\n' : ''}${hasReminderLists ? `Choosing a reminder list (create_reminder):
- If unsure, omit list_name and the default list is used. Use list_name only when the user explicitly references a list ("add to my Groceries list").

` : ''}Recurring items (events and reminders):
- For anything that repeats ("every Monday", "every weekday", "every other week", "monthly", "daily until the end of the month"), pass the recurrence object on create_calendar_event / create_reminder. Examples: weekly on Mon/Wed → {freq:"WEEKLY", byday:["MO","WE"]}; every 2 weeks → {freq:"WEEKLY", interval:2}; daily until a date → {freq:"DAILY", until:"2026-12-31"}; 6 monthly occurrences → {freq:"MONTHLY", count:6}.
- Create ONE recurring item, not many one-off copies. To stop a series repeating, update it with recurrence=null.

Locations (events):
- Pass concrete strings like "Starbucks Shibuya", "Conference Room 3", "Zoom: <link>". Apple Calendar geocodes addresses.

All-day events:
- When the user says "all day", "all-day event", "for the whole day", "block out tomorrow", or names just a date with no time ("birthday on June 15"), set all_day=true.
- For all-day events, pass dates as "YYYY-MM-DD" (no time portion). For a single-day all-day event, start_datetime and end_datetime should be the SAME date.
- For a multi-day all-day span (e.g. "trip from May 25 to May 28"), set start_datetime="2026-05-25" and end_datetime="2026-05-28" — the bot handles iCal's exclusive-end convention.

Formatting your replies (Telegram markdown):
- Telegram renders a small set of markdown. Use it to make replies scannable:
  • **bold** for event/reminder titles and confirmations.
  • _italic_ for the calendar / list name and other secondary detail.
  • \`inline code\` for exact times or dates when it helps them stand out.
  • A "- " bulleted list when showing more than one item.
- Reminder priority: when listing reminders, show priority visually. RFC 5545 priority maps to: 1-4 = high (prefix the title with 🔴 **!High**), 5 = medium (🟡 Medium), 6-9 = low (🔵 Low), 0/unset = no marker. Only surface priority when it's set.
- Surface the calendar/list each item belongs to, and note recurring items (e.g. "_repeats weekly_") and alarms.
- Keep it concise — a couple of lines or a short list, not a wall of text.

Other guidelines:
- When the user mentions schedule, meetings, events, or appointments, use the calendar tools.
- All datetimes you pass to tools must be ISO 8601 in the user's LOCAL time (no timezone suffix), e.g. 2026-06-15T14:30:00.
- For "today", "tomorrow", "this week", etc., compute the actual dates relative to today (above).
- When listing events for a day or range, use a full-day range: start at T00:00:00 and end at T23:59:59. By default list_calendar_events searches ALL calendars.
- When updating event times, always provide BOTH start_datetime and end_datetime together.
- Event UIDs come from list_calendar_events results — use them when updating or deleting.
- If the user asks to edit or delete an event without giving a UID, first list events in the relevant range to find it.
- When confirming a created event, mention which calendar it went into.
- Be concise and friendly.`;
}

export interface ProcessResult {
  responseText: string;
  updatedHistory: Message[];
}

export async function processMessage(
  userText: string,
  history: Message[],
): Promise<ProcessResult> {
  const provider = getProvider();
  const model = process.env.LLM_MODEL?.trim() || provider.defaultModel;

  const messages: Message[] = [
    ...history,
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ];

  const systemPrompt = await buildSystemPrompt();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callWithBackoff(
      () =>
        provider.createMessage({
          system: systemPrompt,
          tools: calendarTools,
          messages,
          model,
          maxTokens: MAX_TOKENS,
        }),
      provider.name,
      (err) => provider.isRetryable(err),
    );

    messages.push({ role: 'assistant', content: response.content });

    // 'end_turn' or 'other' (max_tokens/length/content_filter) are both terminal —
    // return whatever text we have rather than throwing on an unexpected stop.
    if (response.stopReason !== 'tool_use') {
      const textBlocks = response.content.filter(
        (b): b is TextBlock => b.type === 'text',
      );
      const responseText = textBlocks.map((b) => b.text).join('\n\n').trim() || '(no response)';
      return { responseText, updatedHistory: messages };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: ToolResultBlock[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let result: string;
        let isError = false;
        try {
          result = await dispatchTool(block.name, block.input);
        } catch (err: unknown) {
          const e = err as { message?: string };
          result = `Error: ${e.message ?? String(err)}`;
          isError = true;
        }
        console.log(
          `[tool] ${block.name}(${JSON.stringify(block.input)}) => ${result.slice(0, 200)}`,
        );
        return {
          type: 'tool_result' as const,
          toolUseId: block.id,
          content: result,
          isError,
        };
      }),
    );

    // If the parallel batch partially failed, make it loud: both providers
    // reliably deliver tool_result content, so we ride the note inside the last
    // result rather than adding a stray text block (which the OpenAI adapter
    // would drop from a tool-results turn).
    const note = partialFailureNote(toolUseBlocks, toolResults);
    if (note && toolResults.length > 0) {
      const last = toolResults[toolResults.length - 1];
      last.content = `${last.content}\n\n[blurt:${note}]`;
      console.warn(`[tool] ${note}`);
    }

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`Exceeded ${MAX_TOOL_ROUNDS} tool rounds without final response.`);
}
