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

const YAML_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export const splitFrontmatter = (markdown: string): { title?: string; text: string } => {
  const match = YAML_FRONTMATTER.exec(markdown);
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

const isPrivateIpv4 = ([a = 0, b = 0]: ReadonlyArray<number>) =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168);

const IPV6_GROUPS = 8;

const ipv6Groups = (host: string): number[] | undefined => {
  if (!host.includes(":")) return undefined;
  const [head = "", tail] = host.split("::");
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const front = parse(head);
  const back = tail === undefined ? [] : parse(tail);
  const zeros = Array<number>(IPV6_GROUPS - front.length - back.length).fill(0);
  return [...front, ...zeros, ...back];
};

const ipv4OfGroups = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff];

const isPrivateIpv6 = (groups: ReadonlyArray<number>) => {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const embedsIpv4 =
    (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) ||
    (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0);
  const uniqueLocal = (g0 & 0xfe00) === 0xfc00;
  const linkLocal = (g0 & 0xffc0) === 0xfe80;
  return uniqueLocal || linkLocal || (embedsIpv4 && isPrivateIpv4(ipv4OfGroups(g6, g7)));
};

const isPrivateAddress = (host: string) => {
  const groups = ipv6Groups(host);
  if (groups) return isPrivateIpv6(groups);
  const octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split(".").map(Number) : undefined;
  return octets !== undefined && isPrivateIpv4(octets);
};

export const publicUrl = (input: string): Effect.Effect<URL, BrowserError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(input),
      catch: () => new BrowserError({ url: input, reason: "not a URL" }),
    });
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return yield* new BrowserError({ url: input, reason: "only http and https" });
    }
    const host = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/, "");
    const isPrivateOrLocalHost =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      isPrivateAddress(host);
    if (isPrivateOrLocalHost) {
      return yield* new BrowserError({ url: input, reason: "not a public host" });
    }
    return url;
  });

const decodeBase64 = (text: string): Uint8Array => {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const PAGE_LOAD_TIMEOUT_MS = 30_000;
const MAX_ERROR_DETAIL_CHARS = 300;

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
            const url = yield* publicUrl(input);
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
                gotoOptions: { waitUntil: "networkidle0", timeout: PAGE_LOAD_TIMEOUT_MS },
                screenshotOptions: { fullPage: false },
              }),
            );
            if (!response.ok) {
              const detail = yield* attempt("read error", () => response.text());
              return yield* new BrowserError({
                url: input,
                reason: `${response.status} ${detail.slice(0, MAX_ERROR_DETAIL_CHARS)}`,
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
