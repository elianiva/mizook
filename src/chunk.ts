const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const HEADROOM_CHARS = 96;
const MAX_CHUNK_CHARS = TELEGRAM_MAX_MESSAGE_CHARS - HEADROOM_CHARS;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

const hardCutKeepingSurrogatePairs = (text: string, limit: number) =>
  limit > 1 && isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;

export const chunk = (text: string, limit = MAX_CHUNK_CHARS): string[] => {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const lastParagraphLineOrWordBreak = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(" "),
    );
    const breakKeepsAtLeastHalf = lastParagraphLineOrWordBreak > limit / 2;
    const at = breakKeepsAtLeastHalf
      ? lastParagraphLineOrWordBreak
      : hardCutKeepingSurrogatePairs(rest, limit);
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest !== "") parts.push(rest);
  return parts;
};
