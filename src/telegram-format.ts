/**
 * Convert the LLM's lightweight markdown into Telegram MarkdownV2.
 *
 * Telegram's MarkdownV2 is strict: every one of `_*[]()~`>#+-=|{}.!` is reserved
 * and must be backslash-escaped unless it's part of an intended entity, or the
 * whole message fails to parse. Models naturally emit GitHub-flavored markdown
 * (`**bold**`, `*italic*`, `` `code` ``, `- bullets`), so we:
 *   1. pull intended entities (bold / italic / inline code) out into placeholders
 *   2. escape every reserved char in the remaining plain text
 *   3. re-insert the entities using MarkdownV2's syntax (`*bold*`, `_italic_`)
 *
 * bot.ts sends the result with parse_mode 'MarkdownV2' and falls back to plain
 * text if Telegram still rejects it, so a formatting edge case can never drop a
 * reply.
 */

// Reserved characters that MUST be escaped in MarkdownV2 body text.
const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

// Private-use sentinels wrapping a placeholder index. They never appear in real
// text and are not reserved, so they survive escapeReserved untouched.
const SENTINEL_OPEN = '';
const SENTINEL_CLOSE = '';

function escapeReserved(text: string): string {
  return text.replace(RESERVED, (ch) => `\\${ch}`);
}

interface Entity {
  placeholder: string;
  render: string;
}

export function toTelegramMarkdown(input: string): string {
  const entities: Entity[] = [];
  let work = input;

  const stash = (render: string): string => {
    const placeholder = `${SENTINEL_OPEN}${entities.length}${SENTINEL_CLOSE}`;
    entities.push({ placeholder, render });
    return placeholder;
  };

  // Inline code first (its contents are literal — no nested formatting).
  work = work.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    // Inside code spans only backtick and backslash need escaping.
    const escaped = code.replace(/([`\\])/g, '\\$1');
    return stash(`\`${escaped}\``);
  });

  // Bold: **text** or __text__ → *text*
  work = work.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) =>
    stash(`*${escapeReserved(t)}*`),
  );
  work = work.replace(/__([^_\n]+)__/g, (_m, t: string) =>
    stash(`*${escapeReserved(t)}*`),
  );

  // Italic: *text* → _text_  and  _text_ → _text_ (not mid-word, to avoid
  // mangling snake_case / file_names).
  work = work.replace(/\*([^*\n]+)\*/g, (_m, t: string) =>
    stash(`_${escapeReserved(t)}_`),
  );
  work = work.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, (_m, t: string) =>
    stash(`_${escapeReserved(t)}_`),
  );

  // Escape everything that's left, then restore entities.
  let out = escapeReserved(work);
  for (const e of entities) {
    out = out.replace(e.placeholder, () => e.render);
  }
  return out;
}
