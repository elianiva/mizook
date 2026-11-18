import { Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { Browser, publicUrl, splitFrontmatter } from "../src/browser.ts";

const page = (markdown: string, screenshot?: string) =>
  new Response(
    JSON.stringify({
      success: true,
      result: { markdown, ...(screenshot ? { screenshot } : {}) },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const fake = (response: Response) =>
  ({
    quickAction: async () => response,
  }) as unknown as BrowserRun;

const read = (binding: BrowserRun | undefined, url: string) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Browser, (browser) => browser.read(url)),
      Browser.layer(binding),
    ),
  );

test("a rendered page gives its title, markdown and screenshot", async () => {
  const binding = fake(
    page("---\ntitle: Example\n---\n\n# Hello\n\nBody", Buffer.from("png").toString("base64")),
  );
  const result = await read(binding, "https://example.com/article");
  expect(result.title).toBe("Example");
  expect(result.text).toBe("# Hello\n\nBody");
  expect(result.screenshot).toEqual(new Uint8Array([112, 110, 103]));
});

test("frontmatter is lifted out of the markdown", () => {
  expect(splitFrontmatter('---\ntitle: "A page"\n---\n\nText')).toEqual({
    title: "A page",
    text: "Text",
  });
  expect(splitFrontmatter("No frontmatter")).toEqual({ text: "No frontmatter" });
});

test("private and local hosts are refused before the browser is called", () => {
  for (const url of [
    "http://localhost:8787",
    "http://127.0.0.1",
    "http://10.0.0.4",
    "http://192.168.1.2",
    "http://169.254.169.254/latest",
    "ftp://example.com",
  ]) {
    expect(() => publicUrl(url)).toThrow();
  }
  expect(publicUrl("https://example.com/a").toString()).toBe("https://example.com/a");
});

test("without a binding the tool fails instead of pretending", async () => {
  const result = await Effect.runPromiseExit(
    Effect.provide(
      Effect.flatMap(Browser, (browser) => browser.read("https://example.com")),
      Browser.layer(undefined),
    ),
  );
  expect(Exit.isFailure(result)).toBe(true);
});
