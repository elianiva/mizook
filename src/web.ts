import { Effect } from "effect";
import { WebError } from "./errors.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** The readable text of an HTML page: no scripts or styles, one block per line. */
export const htmlToText = (html: string): string => {
  // Prefer the page's own main content when it names one.
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  return main
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/pre|\/blockquote)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
      if (code.startsWith("#x")) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith("#")) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
};

export interface Page {
  readonly status: number;
  readonly contentType: string;
  /** Readable text: HTML is converted, anything else is returned as is. */
  readonly text: string;
  /** The body was longer than `maxBytes` and was cut. */
  readonly truncated: boolean;
}

/** Fetch a page as text. Bounded in time and size; never follows more than 5 redirects. */
export const fetchPage = (
  url: string,
  options: { readonly maxBytes?: number; readonly timeoutMs?: number } = {},
): Effect.Effect<Page, WebError> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) urls");
      const maxBytes = options.maxBytes ?? 1_000_000;
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Mizook/1.0)",
          accept: "text/html,*/*;q=0.5",
        },
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size > maxBytes) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const part of chunks) {
        bytes.set(part, at);
        at += part.length;
      }
      const body = new TextDecoder().decode(bytes.subarray(0, maxBytes));
      const contentType = response.headers.get("content-type") ?? "";
      return {
        status: response.status,
        contentType,
        text: /html/i.test(contentType) ? htmlToText(body) : body,
        truncated,
      };
    },
    catch: (cause) =>
      new WebError({ url, reason: cause instanceof Error ? cause.message : String(cause) }),
  });

/** A hex SHA-256 of a text, to tell whether a page changed. */
export const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
