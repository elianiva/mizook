import { MAX_MESSAGE_BYTES, TOOL_OUTPUT_MAX_CHARS } from "./constants.ts";

const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest prefix of `text` that fits in `max` UTF-8 bytes, cut on a character boundary. */
export function takeBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const next = bytes + byteLength(char);
    if (next > max) break;
    bytes = next;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Split a long text into pages of at most `max` bytes. Nothing is cut: the pages joined are the
 * text. A page ends at a line break when one is near its end.
 */
export function paginate(text: string, max: number = MAX_MESSAGE_BYTES): string[] {
  if (byteLength(text) <= max) return [text];
  const pages: string[] = [];
  let rest = text;
  while (byteLength(rest) > max) {
    let page = takeBytes(rest, max);
    const lineBreak = page.lastIndexOf("\n");
    if (lineBreak >= page.length * 0.8) page = page.slice(0, lineBreak + 1);
    pages.push(page);
    rest = rest.slice(page.length);
  }
  if (rest.length > 0) pages.push(rest);
  return pages;
}

/** Clip a tool's output to its head and tail, `max` characters in all. */
export function clipToolOutput(text: string, max: number = TOOL_OUTPUT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const cut = text.length - 2 * half;
  return `${text.slice(0, half)}\n[... ${cut} characters clipped ...]\n${text.slice(text.length - half)}`;
}
