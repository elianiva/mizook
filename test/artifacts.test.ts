import { ConfigProvider, Effect, Exit, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { artifactHeaders } from "../src/artifact-render.ts";
import { Artifacts } from "../src/artifacts.ts";
import { Blobs } from "../src/blobs.ts";
import { Settings } from "../src/config.ts";

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
  return Effect.runPromise(Effect.provide(f, layer));
};

test("publishing a name again keeps its link, adds a version, and serves the latest", async () => {
  await go(
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const blobs = yield* Blobs;
      const one = yield* artifacts.publish("c", "report.html", "<p>one</p>", "text/html");
      const two = yield* artifacts.publish("c", "report.html", "<p>two</p>", "text/html");
      expect(two.token).toBe(one.token);
      expect(two.version).toBe(2);
      expect(two.url).toBe(`https://t.test/a/${one.token}/report.html`);
      expect(one.token.length).toBeGreaterThanOrEqual(24);
      expect(new TextDecoder().decode((yield* blobs.get(`a/${one.token}`))!.body)).toBe(
        "<p>two</p>",
      );
      // Every version is kept.
      expect(yield* blobs.list("artifacts/c/report.html/")).toHaveLength(2);
      const other = yield* artifacts.publish("c", "b.html", "x", "text/html");
      expect(other.token).not.toBe(one.token);
    }),
  );
});

test("a bad name or a huge file is refused; deleting takes the public copy down", async () => {
  await go(
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const blobs = yield* Blobs;
      for (const bad of ["../x", "Up.html", "", "a/b"]) {
        expect(
          Exit.isFailure(yield* Effect.exit(artifacts.publish("c", bad, "x", "text/html"))),
        ).toBe(true);
      }
      expect(
        Exit.isFailure(
          yield* Effect.exit(artifacts.publish("c", "big", "x".repeat(5_000_001), "text/plain")),
        ),
      ).toBe(true);
      const made = yield* artifacts.publish("c", "p.html", "x", "text/html");
      expect(yield* artifacts.remove("c", "p.html")).toBe(true);
      expect(yield* blobs.get(`a/${made.token}`)).toBeUndefined();
      expect(yield* artifacts.remove("c", "p.html")).toBe(false);
    }),
  );
});

test("artifact pages are served in a sandbox that cannot reach the site", () => {
  const headers = artifactHeaders("text/html");
  const csp = headers.get("content-security-policy")!;
  expect(csp).toContain("sandbox");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toContain("default-src 'none'");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
});

test("kinds render into pages; bad table or chart JSON is refused at publish", async () => {
  const { renderArtifact, KIND_TYPES, checkContent } = await import("../src/artifact-render.ts");
  const ctx = { name: "n", origin: "https://t.test", token: "tok" };
  const md = renderArtifact(KIND_TYPES.markdown, "# Hi\n\n- [x] done", ctx)!;
  expect(md).toContain("<h1");
  expect(md).toContain("og:title");
  const html = renderArtifact(KIND_TYPES.html, "<p>x</p>", ctx)!;
  expect(html).toContain("window.mizook");
  expect(html).toContain("mizook-base");
  expect(checkContent(KIND_TYPES.table, "{nope")).toBeTruthy();
  expect(
    checkContent(
      KIND_TYPES.chart,
      '{"type":"bar","labels":["a"],"datasets":[{"label":"x","data":[1]}]}',
    ),
  ).toBeUndefined();
  expect(renderArtifact("image/svg+xml", "<svg/>", ctx)).toBeUndefined();
});

test("html pages must use the design variables, not their own colours or sizes", async () => {
  const { checkContent, KIND_TYPES } = await import("../src/artifact-render.ts");
  const bad = (css: string) => checkContent(KIND_TYPES.html, `<style>${css}</style><p>x</p>`);
  expect(bad("p{color:#ff0000}")).toContain("colour variables");
  expect(bad("p{background:oklch(50% 0 0)}")).toContain("colour variables");
  expect(bad("p{font-size:18px}")).toContain("size variables");
  expect(bad("p{font-family:Arial}")).toContain("font-family");
  expect(checkContent(KIND_TYPES.html, '<p style="color:#fff">x</p>')).toBeTruthy();
  expect(
    bad("p{color:var(--fg);font-size:var(--text-lg);font-family:var(--mono)}"),
  ).toBeUndefined();
  expect(checkContent(KIND_TYPES.html, "<p>no style</p>")).toBeUndefined();
});

test("a private artifact is marked on its public copy, and keeps that after a new version", async () => {
  await go(
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const blobs = yield* Blobs;
      const made = yield* artifacts.publish("c", "p.html", "<p>one</p>", "text/html");
      expect(made.visibility).toBe("public");
      const closed = yield* artifacts.setVisibility("p.html", "private");
      expect(closed.visibility).toBe("private");
      expect((yield* blobs.get(`a/${made.token}`))!.meta.visibility).toBe("private");
      const again = yield* artifacts.publish("c", "p.html", "<p>two</p>", "text/html");
      expect(again.visibility).toBe("private");
      expect((yield* blobs.get(`a/${made.token}`))!.meta.visibility).toBe("private");
      const shown = yield* artifacts.source("p.html");
      expect(shown.text).toBe("<p>two</p>");
      const opened = yield* artifacts.setVisibility("p.html", "public");
      expect((yield* blobs.get(`a/${made.token}`))!.meta.visibility).toBe("public");
      expect(opened.version).toBe(2);
    }),
  );
});
