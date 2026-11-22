import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
import {
  artifactHeaders,
  ChartSpec,
  checkContent,
  KIND_TYPES,
  renderArtifact,
  TableSpec,
} from "../src/artifact-render.ts";
import { Artifacts, MAX_ARTIFACT_BYTES } from "../src/artifacts.ts";
import { Blobs } from "../src/blobs.ts";
import { Settings } from "../src/config.ts";
import { property } from "./property.ts";

const settings = Settings.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        BOT_TOKEN: "x",
        MIZOOK_WEBHOOK_SECRET: "x",
        DEEPSEEK_API_KEY: "x",
        PUBLIC_URL: "https://t.test",
      }),
    ),
  ),
);

const go = <A, E>(f: Effect.Effect<A, E, Artifacts | Blobs>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const layer = Artifacts.layer(sql).pipe(
    Layer.provideMerge(Blobs.memory),
    Layer.provide(settings),
  );
  return Effect.provide(f, layer);
};

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const oneOf = <const A extends ReadonlyArray<string | number>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const chars = (alphabet: string, minLength: number, maxLength: number) =>
  Arbitrary.array(oneOf(alphabet.split("")), { minLength, maxLength }).pipe(
    Arbitrary.map((cs) => cs.join("")),
  );
const survivesUtf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
const text = Arbitrary.schema(Schema.String).pipe(Arbitrary.filter(survivesUtf8));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const LOWER_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";
const NAME_REST = `${LOWER_DIGITS}._-`;
const validName = Arbitrary.all({
  first: chars(LOWER_DIGITS, 1, 1),
  rest: Arbitrary.flatMap(oneOf([0, 1, 60, -1]), (n) =>
    n === -1 ? chars(NAME_REST, 0, 60) : chars(NAME_REST, n, n),
  ),
}).pipe(Arbitrary.map(({ first, rest }) => first + rest));
const badName = Arbitrary.all({
  kind: int(0, 5),
  name: validName,
  junk: chars("ABZ/ \\é", 1, 3),
  lead: chars("._-/A", 1, 1),
  long: chars(NAME_REST, 61, 70),
}).pipe(
  Arbitrary.map(
    ({ kind, name, junk, lead, long }) =>
      [
        "",
        `${lead}${name}`,
        `${name}${junk}`,
        `${name.slice(0, 1)}${junk}${name.slice(1)}`,
        `${name.slice(0, 1)}${long}`,
        "../x",
      ][kind]!,
  ),
);

property(
  "publishing a name again and again keeps its link, counts versions, keeps every one, and serves the latest",
  Arbitrary.all({
    name: validName,
    other: validName,
    contents: Arbitrary.array(text, { minLength: 1, maxLength: 5 }),
  }).pipe(Arbitrary.filter(({ name, other }) => name !== other)),
  ({ name, other, contents }) =>
    go(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const blobs = yield* Blobs;
        const made = [];
        for (const content of contents)
          made.push(yield* artifacts.publish("c", name, content, "text/plain"));
        const token = made[0]!.token;
        expect(token.length).toBeGreaterThanOrEqual(24);
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
        made.forEach((artifact, i) => {
          expect(artifact.token).toBe(token);
          expect(artifact.version).toBe(i + 1);
          expect(artifact.url).toBe(`https://t.test/a/${token}/${name}`);
        });
        const latest = contents.at(-1)!;
        expect(decode((yield* blobs.get(`a/${token}`))!.body)).toBe(latest);
        expect((yield* artifacts.source(name)).text).toBe(latest);
        expect(yield* artifacts.history("c", name)).toEqual(contents.map((_, i) => i + 1));
        for (const [i, content] of contents.entries())
          expect(decode((yield* blobs.get(`artifacts/c/${name}/${i + 1}`))!.body)).toBe(content);
        const second = yield* artifacts.publish("c", other, "x", "text/plain");
        expect(second.token).not.toBe(token);
        expect(second.version).toBe(1);
      }),
    ),
  { runs: 40 },
);

property(
  "a name of lowercase letters and digits, then up to sixty of those or dots, dashes and underscores, is accepted; anything else is refused",
  Arbitrary.all({ good: validName, bad: badName }),
  ({ good, bad }) =>
    go(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        expect(
          Exit.isSuccess(yield* Effect.exit(artifacts.publish("c", good, "x", "text/plain"))),
        ).toBe(true);
        expect(
          Exit.isFailure(yield* Effect.exit(artifacts.publish("c", bad, "x", "text/plain"))),
        ).toBe(true);
        expect((yield* artifacts.list).map((a) => a.name)).toEqual([good]);
      }),
    ),
  { runs: 60 },
);

property(
  "a file up to five million bytes, counted in UTF-8 bytes rather than characters, is accepted and one byte more is refused",
  Arbitrary.all({ glyph: oneOf(["a", "é", "日", "😀"]), over: oneOf([-1, 0, 1]) }),
  ({ glyph, over }) => {
    const bytes = MAX_ARTIFACT_BYTES + over;
    const width = new TextEncoder().encode(glyph).length;
    const content = glyph.repeat(Math.floor(bytes / width)) + "a".repeat(bytes % width);
    return go(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const published = yield* Effect.exit(artifacts.publish("c", "big", content, "text/plain"));
        expect(Exit.isSuccess(published)).toBe(over <= 0);
      }),
    );
  },
  { runs: 12 },
);

property(
  "removing an artifact takes its public copy and data down once, and a second remove finds nothing",
  Arbitrary.all({ name: validName, content: text, key: chars("abc.-_1", 1, 8) }),
  ({ name, content, key }) =>
    go(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const blobs = yield* Blobs;
        const made = yield* artifacts.publish("c", name, content, "text/plain");
        yield* artifacts.data.set(name, key, JSON.stringify(content));
        expect(yield* artifacts.data.get(name, key)).toBe(JSON.stringify(content));
        expect(yield* artifacts.remove("c", name)).toBe(true);
        expect(yield* blobs.get(`a/${made.token}`)).toBeUndefined();
        expect(yield* blobs.list(`d/${made.token}/`)).toEqual([]);
        expect(yield* artifacts.list).toEqual([]);
        expect(yield* artifacts.remove("c", name)).toBe(false);
      }),
    ),
  { runs: 40 },
);

const contentType = Arbitrary.all({
  pick: int(0, 1),
  known: oneOf([
    ...Object.values(KIND_TYPES),
    "text/html",
    "TEXT/HTML",
    "image/png",
    "image/svg+xml",
    "application/pdf",
  ]),
  any: chars("abcz/+.-;= 019", 0, 30),
}).pipe(Arbitrary.map(({ pick, known, any }) => (pick === 0 ? known : any)));

property(
  "every artifact page is served sandboxed away from the site, with nothing allowed by default and no sniffing",
  contentType,
  (type) => {
    const headers = artifactHeaders(type);
    const csp = headers.get("content-security-policy")!;
    const directives = csp.split(";").map((d) => d.trim());
    expect(directives.some((d) => d.startsWith("sandbox "))).toBe(true);
    expect(csp).not.toContain("allow-same-origin");
    expect(directives).toContain("default-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    if (/^text\/markdown/i.test(type)) expect(directives).toContain("script-src 'none'");
  },
);

const ctx = { name: "n", origin: "https://t.test", token: "tok" };
const plainWords = chars("abcdefghij ", 1, 30).pipe(Arbitrary.filter((s) => s.trim() !== ""));

property(
  "markdown renders to a page whose heading becomes its title, and html gets the base styles and data bridge",
  Arbitrary.all({ heading: plainWords, paragraph: plainWords }),
  ({ heading, paragraph }) => {
    const md = renderArtifact(
      KIND_TYPES.markdown,
      `# ${heading}\n\n${paragraph}\n\n- [x] done`,
      ctx,
    )!;
    const title = heading.replace(/\s+/g, " ").trim();
    expect(md).toContain("<h1");
    expect(md).toContain(`<title>${title}</title>`);
    expect(md).toContain(`<meta property="og:title" content="${title}">`);
    const html = renderArtifact(KIND_TYPES.html, `<p>${paragraph}</p>`, ctx)!;
    expect(html).toContain("window.mizook");
    expect(html).toContain('id="mizook-base"');
    expect(html).toContain(`<p>${paragraph}</p>`);
  },
);

property(
  "a file of any other type is not rendered into a page",
  oneOf(["image/svg+xml", "image/png", "application/pdf", "text/plain", "application/json"]),
  (type) => {
    expect(renderArtifact(type, "<svg/>", ctx)).toBeUndefined();
  },
);

property(
  "a well-formed table or chart is accepted at publish, and text that is not JSON is refused",
  Arbitrary.all({
    table: Arbitrary.schema(TableSpec),
    chart: Arbitrary.schema(ChartSpec),
    junk: Arbitrary.schema(Schema.String).pipe(
      Arbitrary.filter((s) => {
        try {
          JSON.parse(s);
          return false;
        } catch {
          return true;
        }
      }),
    ),
  }),
  ({ table, chart, junk }) => {
    expect(checkContent(KIND_TYPES.table, JSON.stringify(table))).toBeUndefined();
    expect(checkContent(KIND_TYPES.chart, JSON.stringify(chart))).toBeUndefined();
    expect(checkContent(KIND_TYPES.table, junk)).toBeTruthy();
    expect(checkContent(KIND_TYPES.chart, junk)).toBeTruthy();
  },
);

const hex = chars("0123456789abcdefABCDEF", 3, 8);
const colourLiteral = Arbitrary.all({
  pick: int(0, 1),
  hex,
  fn: oneOf(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch"]),
}).pipe(Arbitrary.map(({ pick, hex, fn }) => (pick === 0 ? `#${hex}` : `${fn}(50% 0 0)`)));
const variable = chars("abcdefgh-", 1, 8).pipe(Arbitrary.map((n) => `var(--${n})`));
const literalRule = Arbitrary.all({
  kind: int(0, 2),
  colourProperty: oneOf(["color", "background", "border-color", "fill"]),
  colour: colourLiteral,
  size: int(1, 99),
  unit: oneOf(["px", "rem"]),
  font: oneOf(["Arial", "serif", "'Comic Sans MS'"]),
}).pipe(
  Arbitrary.map(
    ({ kind, colourProperty, colour, size, unit, font }) =>
      [
        { css: `${colourProperty}:${colour}`, complaint: "colour variables" },
        { css: `font-size:${size}${unit}`, complaint: "size variables" },
        { css: `font-family:${font}`, complaint: "font-family" },
      ][kind]!,
  ),
);
const tokenRule = Arbitrary.all({
  kind: int(0, 2),
  colourProperty: oneOf(["color", "background", "border-color"]),
  variable,
  font: oneOf(["font", "mono"]),
}).pipe(
  Arbitrary.map(
    ({ kind, colourProperty, variable, font }) =>
      [`${colourProperty}:${variable}`, `font-size:${variable}`, `font-family:var(--${font})`][
        kind
      ]!,
  ),
);

property(
  "html styles that use a literal colour, font size or font are refused with the matching hint; design variables pass",
  Arbitrary.all({
    bad: literalRule,
    good: Arbitrary.array(tokenRule, { maxLength: 4 }),
    inline: Arbitrary.schema(Schema.Boolean),
    body: plainWords,
  }).pipe(
    Arbitrary.filter(
      ({ bad, good }) =>
        bad.complaint !== "font-family" || !good.some((rule) => rule.startsWith("font-family")),
    ),
  ),
  ({ bad, good, inline, body }) => {
    const page = (rules: ReadonlyArray<string>) =>
      inline
        ? `<p style="${rules.join(";")}">${body}</p>`
        : `<style>p{${rules.join(";")}}</style><p>${body}</p>`;
    expect(checkContent(KIND_TYPES.html, page([...good, bad.css]))).toContain(bad.complaint);
    expect(checkContent(KIND_TYPES.html, page(good))).toBeUndefined();
    expect(checkContent(KIND_TYPES.html, `<p>${body}</p>`)).toBeUndefined();
  },
);

const visibilityStep = Arbitrary.all({
  publish: Arbitrary.schema(Schema.Boolean),
  content: text,
  visibility: oneOf(["public", "private"]),
});

property(
  "an artifact's visibility is the last one set, survives new versions, and is marked on its public copy",
  Arbitrary.all({ first: text, steps: Arbitrary.array(visibilityStep, { maxLength: 8 }) }),
  ({ first, steps }) =>
    go(
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const blobs = yield* Blobs;
        const made = yield* artifacts.publish("c", "p.html", first, "text/plain");
        expect(made.visibility).toBe("public");
        let visibility = "public";
        let latest = first;
        let version = 1;
        for (const step of steps) {
          const result = step.publish
            ? yield* artifacts.publish("c", "p.html", step.content, "text/plain")
            : yield* artifacts.setVisibility("p.html", step.visibility);
          if (step.publish) {
            latest = step.content;
            version += 1;
          } else {
            visibility = step.visibility;
          }
          expect(result.visibility).toBe(visibility);
          expect(result.version).toBe(version);
          expect((yield* blobs.get(`a/${made.token}`))!.meta.visibility).toBe(visibility);
        }
        expect((yield* artifacts.source("p.html")).text).toBe(latest);
      }),
    ),
  { runs: 40 },
);
