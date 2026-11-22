import { expect, test } from "vite-plus/test";
import { previewText } from "../apps/web/src/format.ts";
import { renderMarkdown } from "../apps/web/src/markdown.ts";

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
