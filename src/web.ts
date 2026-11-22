import { type Duration, Effect } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import { WebError } from "./errors.ts";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export const htmlToText = (html: string): string => {
  const mainContentOrWholePage = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(html)?.[2] ?? html;
  return mainContentOrWholePage
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
  readonly text: string;
  readonly truncated: boolean;
}

const DEFAULT_MAX_PAGE_BYTES = 1_000_000;
const DEFAULT_FETCH_TIMEOUT: Duration.Input = "15 seconds";

export const fetchPage = (
  url: string,
  options: { readonly maxBytes?: number; readonly timeout?: Duration.Input } = {},
): Effect.Effect<Page, WebError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (!/^https?:\/\//i.test(url))
      return yield* new WebError({ url, reason: "only http(s) urls" });
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES;
    const response = yield* HttpClient.get(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; Mizook/1.0)",
        accept: "text/html,*/*;q=0.5",
      },
    });
    const body = yield* response.text;
    const truncated = body.length > maxBytes;
    const text = truncated ? body.slice(0, maxBytes) : body;
    const contentType = response.headers["content-type"] ?? "";
    return {
      status: response.status,
      contentType,
      text: /html/i.test(contentType) ? htmlToText(text) : text,
      truncated,
    };
  }).pipe(
    Effect.timeout(options.timeout ?? DEFAULT_FETCH_TIMEOUT),
    Effect.mapError((cause) =>
      cause instanceof WebError
        ? cause
        : new WebError({ url, reason: String(cause.message ?? cause) }),
    ),
  );

export const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
