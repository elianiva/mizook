import { expect, test } from "vite-plus/test";
import { previewText } from "../apps/web/src/format.ts";
import { segmentsOf } from "../apps/web/src/generative.ts";
import { renderMarkdown } from "../apps/web/src/markdown.ts";
import { TOOL_GUIDE } from "../src/tools.ts";

test("raw HTML from an answer stays text", () => {
  const rendered = renderMarkdown("<img src=x onerror=alert(1)> and <script>alert(1)</script>");
  expect(rendered).not.toContain("<img src=x");
  expect(rendered).not.toContain("<script>");
  expect(rendered).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("links keep http, https and mailto, and drop every other scheme", () => {
  const rendered = renderMarkdown(
    [
      "[http](http://example.com/a)",
      "[https](https://example.com/b)",
      "[mail](mailto:me@example.com)",
      "[script](javascript:alert(1))",
      "[data](data:text/html,hello)",
    ].join(" "),
  );
  expect(rendered).toContain('href="http://example.com/a"');
  expect(rendered).toContain('href="https://example.com/b"');
  expect(rendered).toContain('href="mailto:me@example.com"');
  expect(rendered).not.toContain("javascript:");
  expect(rendered).not.toContain("data:text/html");
});

test("a sidebar preview is one plain line, whatever Markdown the answer used", () => {
  expect(
    previewText(
      "## Result\n\n- **Night:** Pixel\n- [Video](https://example.com): iPhone\n\n```js\ncode\n```",
    ),
  ).toBe("Result Night: Pixel Video: iPhone code");
});

test("an image needs https, and its alt and title text are escaped", () => {
  const rendered = renderMarkdown(
    '![safe](https://example.com/a.png "a \\"title\\"") ![](http://example.com/b.png)',
  );
  expect(rendered).toContain('src="https://example.com/a.png"');
  expect(rendered).toContain('alt="safe"');
  expect(rendered).not.toContain("http://example.com/b.png");
});

const fence = (body: string) => `\`\`\`openui-lang\n${body}\n\`\`\``;

test("a program between prose becomes its components, and the prose around it stays Markdown", () => {
  const segments = segmentsOf(
    `**Before** the chart\n\n${fence('root = Stack([rain, next])\nrain = Bars([Bar("Mon", 3.5), Bar("Tue", 0)], "Rain")\nnext = Choices(["Umbrella?"])')}\n\nAfter it`,
  );
  expect(segments).toEqual([
    { kind: "markdown", html: "<p><strong>Before</strong> the chart</p>\n" },
    {
      kind: "ui",
      blocks: [
        {
          type: "Bars",
          props: {
            items: [
              { label: "Mon", value: 3.5 },
              { label: "Tue", value: 0 },
            ],
            title: "Rain",
          },
        },
        { type: "Choices", props: { items: ["Umbrella?"] } },
      ],
    },
    { kind: "markdown", html: "<p>After it</p>\n" },
  ]);
});

test("a closed program that draws nothing from the catalog stays a code block", () => {
  for (const body of [
    'root = Iframe("https://example.com")',
    "root = Metrics([])",
    'root = Bars([Bar("Mon", "3")])',
    'root = Sources([Source("x", "javascript:alert(1)")])',
    "not a program",
  ]) {
    const segments = segmentsOf(fence(body));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("markdown");
    expect(segments[0]!.kind === "markdown" && segments[0]!.html).toContain(
      'class="language-openui-lang"',
    );
  }
});

test("an open program shows the components that already parse, and a placeholder before that", () => {
  expect(segmentsOf("Loading:\n\n```openui-lang\nroot = Steps([").map((s) => s.kind)).toEqual([
    "markdown",
    "pending",
  ]);
  const growing = segmentsOf(
    '```openui-lang\nroot = Stack([plan, more])\nplan = Steps([Step("Book flights", "done"), Step("Pack")])\nmore = Choices(["Ye',
  );
  expect(growing).toEqual([
    {
      kind: "ui",
      blocks: [
        {
          type: "Steps",
          props: { items: [{ text: "Book flights", state: "done" }, { text: "Pack" }] },
        },
      ],
    },
  ]);
  expect(segmentsOf("```js\nconst x = 1\n```").map((s) => s.kind)).toEqual(["markdown"]);
});

test("the example in the agent's guide draws with the web chat's catalog", () => {
  const example = /```openui-lang\n[\s\S]*?\n```/.exec(TOOL_GUIDE)?.[0] ?? "";
  const segments = segmentsOf(example);
  expect(segments).toHaveLength(1);
  expect(segments[0]!.kind === "ui" && segments[0]!.blocks.map((block) => block.type)).toEqual([
    "Metrics",
    "Choices",
  ]);
});
