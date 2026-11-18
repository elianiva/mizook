import { Context, Effect, Layer } from "effect";
import { BrowserError } from "./errors.ts";

export interface BrowserPage {
  readonly url: string;
  readonly title: string | undefined;
  readonly text: string;
  readonly screenshot: Uint8Array | undefined;
}

interface SnapshotBody {
  success: boolean;
  result?: { markdown?: string; screenshot?: string };
  errors?: Array<{ message: string }>;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Browser Rendering prefixes its markdown with a small YAML frontmatter; lift the title out. */
export const splitFrontmatter = (markdown: string): { title?: string; text: string } => {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { text: markdown.trim() };
  const title = /^title:\s*(.+)$/m
    .exec(match[1] ?? "")?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return {
    ...(title ? { title } : {}),
    text: markdown.slice(match[0].length).trim(),
  };
};

/** Refuse anything that is not a public web page; the browser runs outside this Worker. */
export const publicUrl = (input: string): URL => {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BrowserError({ url: input, reason: "not a URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserError({ url: input, reason: "only http and https" });
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.startsWith("169.254.") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal";
  if (privateHost) throw new BrowserError({ url: input, reason: "not a public host" });
  return url;
};

const decodeBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/** Read a JS-heavy page with Browser Rendering: markdown for the model, a screenshot for the user. */
export class Browser extends Context.Service<
  Browser,
  {
    read(url: string): Effect.Effect<BrowserPage, BrowserError>;
  }
>()("mizook/Browser") {
  static readonly layer = (binding: BrowserRun | undefined) =>
    Layer.succeed(
      Browser,
      Browser.of({
        read: (input) =>
          Effect.gen(function* () {
            if (!binding) {
              return yield* new BrowserError({
                url: input,
                reason: "Browser Rendering is not configured",
              });
            }
            const url = yield* Effect.try({
              try: () => publicUrl(input),
              catch: (cause) =>
                cause instanceof BrowserError
                  ? cause
                  : new BrowserError({ url: input, reason: String(cause) }),
            });
            const attempt = <A>(operation: string, f: () => Promise<A>) =>
              Effect.tryPromise({
                try: f,
                catch: (cause) =>
                  new BrowserError({ url: input, reason: `${operation}: ${String(cause)}` }),
              });
            const response = yield* attempt("open", () =>
              binding.quickAction("snapshot", {
                url: url.toString(),
                formats: ["markdown", "screenshot"],
                gotoOptions: { waitUntil: "networkidle0", timeout: 30_000 },
                screenshotOptions: { fullPage: false },
              }),
            );
            if (!response.ok) {
              const detail = yield* attempt("read error", () => response.text());
              return yield* new BrowserError({
                url: input,
                reason: `${response.status} ${detail.slice(0, 300)}`,
              });
            }
            const body = yield* attempt("parse", () => response.json() as Promise<SnapshotBody>);
            if (!body.success) {
              return yield* new BrowserError({
                url: input,
                reason: body.errors?.[0]?.message ?? "the page could not be read",
              });
            }
            const { title, text } = splitFrontmatter(body.result?.markdown ?? "");
            const screenshot = body.result?.screenshot;
            return {
              url: url.toString(),
              title,
              text,
              screenshot: screenshot ? decodeBase64(screenshot) : undefined,
            } satisfies BrowserPage;
          }),
      }),
    );
}
