import { MAX_MESSAGE_BYTES, TOOL_OUTPUT_MAX_CHARS } from "./constants.ts";

const MIN_PAGE_FILL_BEFORE_LINE_BREAK_CUT = 0.8;

const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

export function takeBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let endOnCharacterBoundary = 0;
  for (const char of text) {
    const next = bytes + byteLength(char);
    if (next > maxBytes) break;
    bytes = next;
    endOnCharacterBoundary += char.length;
  }
  return text.slice(0, endOnCharacterBoundary);
}

function endAtLineBreakNearEnd(page: string): string {
  const lineBreak = page.lastIndexOf("\n");
  const nearEnd = lineBreak >= page.length * MIN_PAGE_FILL_BEFORE_LINE_BREAK_CUT;
  return nearEnd ? page.slice(0, lineBreak + 1) : page;
}

export function paginate(text: string, maxBytesPerPage: number = MAX_MESSAGE_BYTES): string[] {
  if (byteLength(text) <= maxBytesPerPage) return [text];
  const pagesThatJoinBackToText: string[] = [];
  let rest = text;
  while (byteLength(rest) > maxBytesPerPage) {
    const page = endAtLineBreakNearEnd(takeBytes(rest, maxBytesPerPage));
    pagesThatJoinBackToText.push(page);
    rest = rest.slice(page.length);
  }
  if (rest.length > 0) pagesThatJoinBackToText.push(rest);
  return pagesThatJoinBackToText;
}

export function clipToolOutput(
  text: string,
  maxCharsHeadAndTail: number = TOOL_OUTPUT_MAX_CHARS,
): string {
  if (text.length <= maxCharsHeadAndTail) return text;
  const half = Math.floor(maxCharsHeadAndTail / 2);
  const clippedChars = text.length - 2 * half;
  return `${text.slice(0, half)}\n[... ${clippedChars} characters clipped ...]\n${text.slice(text.length - half)}`;
}
