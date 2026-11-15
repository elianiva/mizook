import { expect, test } from "vite-plus/test";
import { htmlToText } from "../src/web.ts";

test("html becomes readable text: no scripts, entities decoded, main content preferred", () => {
  const html = `<html><head><title>x</title><style>p{}</style></head><body>
    <nav>Menu</nav><main><h1>Price &amp; stock</h1><p>It costs&nbsp;$5 &#8212; today</p>
    <ul><li>one</li><li>two</li></ul><script>alert(1)</script></main><footer>f</footer></body></html>`;
  const text = htmlToText(html);
  expect(text).toBe("Price & stock\nIt costs $5 — today\n- one\n- two");
  expect(htmlToText("<p>a</p><p>b</p>")).toBe("a\nb");
});
