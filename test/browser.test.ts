import { Arbitrary, Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Browser, publicUrl, splitFrontmatter } from "../src/browser.ts";
import { property } from "./property.ts";

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const pick = <const A extends ReadonlyArray<string>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));

const titleText = Arbitrary.schema(
  Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9é😀][a-zA-Z0-9é😀 :#-]*[a-zA-Z0-9é😀]$/u),
    Schema.isMaxLength(30),
  ),
);

const bodyText = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9é😀 #:\n-]*$/u), Schema.isMaxLength(60)),
);

const yamlLine = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^(author|date|lang): [a-z0-9 ]+$/), Schema.isMaxLength(20)),
);

const octet = int(0, 255);

const port = Arbitrary.all([Arbitrary.schema(Schema.Boolean), int(1, 65_535)]).pipe(
  Arbitrary.map(([present, value]) => (present ? `:${value}` : "")),
);

const path = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^(\/[a-z0-9._-]*)*$/), Schema.isMaxLength(20)),
);

const scheme = pick(["http", "https", "HTTP"]);

const label = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-z0-9]+$/), Schema.isMaxLength(10)),
);

const privateHost = Arbitrary.all({
  form: pick(["loopback", "ten", "home", "carrier", "link", "name"]),
  a: octet,
  b: octet,
  c: octet,
  middle: int(16, 31),
  label,
  suffix: pick([".localhost", ".internal", ".local", ".LOCAL"]),
  named: pick(["localhost", "LOCALHOST", "0.0.0.0", "[::1]", "[::]", "metadata.google.internal"]),
  useNamed: Arbitrary.schema(Schema.Boolean),
}).pipe(
  Arbitrary.map(({ form, a, b, c, middle, label, suffix, named, useNamed }) => {
    switch (form) {
      case "loopback":
        return useNamed
          ? `${(127 * 2 ** 24 + a * 2 ** 16 + b * 2 ** 8 + c).toString()}`
          : `127.${a}.${b}.${c}`;
      case "ten":
        return useNamed ? `0xa.${a * 65_536 + b * 256 + c}` : `10.${a}.${b}.${c}`;
      case "home":
        return `192.168.${a}.${b}`;
      case "carrier":
        return `172.${middle}.${a}.${b}`;
      case "link":
        return `169.254.${a}.${b}`;
      case "name":
        return useNamed ? named : `${label}${suffix}`;
    }
  }),
);

const isPrivateIp = ([a, b]: ReadonlyArray<number>) =>
  a === 127 ||
  a === 10 ||
  (a === 192 && b === 168) ||
  (a === 172 && b! >= 16 && b! <= 31) ||
  (a === 169 && b === 254);

const publicIp = Arbitrary.all([pick(["", "172", "192", "169"]), octet, octet, octet, octet]).pipe(
  Arbitrary.map(([lead, a, b, c, d]) => [lead === "" ? a : Number(lead), b, c, d]),
  Arbitrary.filter((octets) => !isPrivateIp(octets) && octets.some((n) => n !== 0)),
  Arbitrary.map((octets) => octets.join(".")),
);

const publicName = Arbitrary.all([
  label,
  label,
  pick(["com", "org", "io", "dev", "localhostx", "internals"]),
]).pipe(
  Arbitrary.filter(([first]) => first !== ""),
  Arbitrary.map(([first, second, suffix]) =>
    second === "" ? `${first}.${suffix}` : `${first}.${second}.${suffix}`,
  ),
);

const page = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const fake = (respond: () => Response, opened: string[]) =>
  ({
    quickAction: async (_action: string, options: { url: string }) => {
      opened.push(options.url);
      return respond();
    },
  }) as unknown as BrowserRun;

const read = (binding: BrowserRun | undefined, url: string) =>
  Effect.exit(Effect.flatMap(Browser, (browser) => browser.read(url))).pipe(
    Effect.provide(Browser.layer(binding)),
  );

property(
  "the title is lifted out of the frontmatter, unquoted and trimmed, and the rest is the trimmed body",
  Arbitrary.all({
    title: titleText,
    quote: pick(["", '"', "'"]),
    spaces: pick(["", " ", "  "]),
    before: Arbitrary.array(yamlLine, { maxLength: 3 }),
    after: Arbitrary.array(yamlLine, { maxLength: 3 }),
    newline: pick(["\n", "\r\n"]),
    body: bodyText,
  }),
  ({ title, quote, spaces, before, after, newline, body }) => {
    const yaml = [
      ...before,
      `title:${spaces || " "}${quote}${title}${quote}${spaces}`,
      ...after,
    ].join(newline);
    const markdown = `---${newline}${yaml}${newline}---${newline}${body}`;
    expect(splitFrontmatter(markdown)).toEqual({ title, text: body.trim() });
  },
);

property(
  "frontmatter without a title is still removed and gives no title",
  Arbitrary.all({
    lines: Arbitrary.array(yamlLine, { minLength: 1, maxLength: 3 }),
    body: bodyText,
  }),
  ({ lines, body }) => {
    expect(splitFrontmatter(`---\n${lines.join("\n")}\n---\n${body}`)).toEqual({
      text: body.trim(),
    });
  },
);

property(
  "markdown that does not open with a frontmatter fence is only trimmed",
  bodyText.pipe(Arbitrary.filter((text) => !text.startsWith("---"))),
  (markdown) => {
    expect(splitFrontmatter(markdown)).toEqual({ text: markdown.trim() });
  },
);

property(
  "loopback, private, link-local and internal hosts are refused on any scheme, port and path, written dotted, decimal or hex",
  Arbitrary.all({ scheme, host: privateHost, port, path }),
  ({ scheme, host, port, path }) => {
    expect(() => publicUrl(`${scheme}://${host}${port}${path}`)).toThrow();
  },
);

property(
  "public names and public addresses, including the neighbours of private ranges, are accepted as the parsed URL",
  Arbitrary.all({
    scheme,
    host: Arbitrary.all([publicIp, publicName, Arbitrary.schema(Schema.Boolean)]),
    port,
    path,
  }),
  ({ scheme, host: [ip, domain, useIp], port, path }) => {
    const input = `${scheme}://${useIp ? ip : domain}${port}${path}`;
    expect(publicUrl(input).href).toBe(new URL(input).href);
  },
);

property(
  "schemes other than http and https, and text that is not a URL, are refused",
  Arbitrary.all({
    scheme: pick(["ftp", "file", "ws", "javascript", "data", "httpx"]),
    host: publicName,
    garbage: Arbitrary.schema(
      Schema.String.check(Schema.isPattern(/^[a-z ]*$/), Schema.isMaxLength(10)),
    ),
  }),
  ({ scheme, host, garbage }) => {
    expect(() => publicUrl(`${scheme}://${host}/`)).toThrow();
    expect(() => publicUrl(garbage)).toThrow();
  },
);

property(
  "a rendered page gives back its title, body and the exact screenshot bytes, opened at the normalised URL",
  Arbitrary.all({
    host: publicName,
    path,
    title: titleText,
    body: bodyText,
    screenshot: Arbitrary.schema(Schema.Uint8Array.check(Schema.isMaxLength(64))),
  }),
  ({ host, path, title, body, screenshot }) =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const url = `https://${host}${path}`;
      const encoded = Buffer.from(screenshot).toString("base64");
      const binding = fake(
        () =>
          page({
            success: true,
            result: {
              markdown: `---\ntitle: ${title}\n---\n\n${body}`,
              ...(encoded ? { screenshot: encoded } : {}),
            },
          }),
        opened,
      );
      const exit = yield* read(binding, url);
      const normalised = new URL(url).href;
      expect(exit).toEqual(
        Exit.succeed({
          url: normalised,
          title,
          text: body.trim(),
          screenshot: screenshot.length === 0 ? undefined : screenshot,
        }),
      );
      expect(opened).toEqual([normalised]);
    }),
);

property(
  "an error status or an unsuccessful snapshot fails the read",
  Arbitrary.all({
    status: int(400, 599),
    httpError: Arbitrary.schema(Schema.Boolean),
    message: bodyText,
    host: publicName,
  }),
  ({ status, httpError, message, host }) =>
    Effect.gen(function* () {
      const binding = fake(
        () =>
          httpError ? page({ message }, status) : page({ success: false, errors: [{ message }] }),
        [],
      );
      const exit = yield* read(binding, `https://${host}/`);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
);

property(
  "a private host fails before the browser is opened, and without a binding every read fails",
  Arbitrary.all({ privateUrl: privateHost, host: publicName }),
  ({ privateUrl, host }) =>
    Effect.gen(function* () {
      const opened: string[] = [];
      const refused = yield* read(
        fake(() => page({ success: true, result: { markdown: "" } }), opened),
        `http://${privateUrl}/`,
      );
      expect(Exit.isFailure(refused)).toBe(true);
      expect(opened).toEqual([]);
      expect(Exit.isFailure(yield* read(undefined, `https://${host}/`))).toBe(true);
    }),
);
