import { expect, test } from "vite-plus/test";
import { chunk } from "../src/chunk.ts";

test("a short reply is one part", () => {
  expect(chunk("  hello  ")).toEqual(["hello"]);
});

test("a long reply is cut at paragraph breaks, nothing is lost, no part is over the limit", () => {
  const paragraph = (n: number) => `${"p".repeat(n)}.`;
  const text = [paragraph(30), paragraph(30), paragraph(30)].join("\n\n");
  const parts = chunk(text, 70);
  expect(parts).toEqual([`${paragraph(30)}\n\n${paragraph(30)}`, paragraph(30)]);
  expect(parts.every((part) => part.length <= 70)).toBe(true);
  expect(parts.join("\n\n").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
});

test("a long word with no break is cut at the limit", () => {
  const parts = chunk("x".repeat(25), 10);
  expect(parts).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});
