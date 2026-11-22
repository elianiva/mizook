import { Arbitrary, Schema } from "effect";
import { expect } from "vite-plus/test";
import { chunk } from "../src/chunk.ts";
import { property } from "./property.ts";

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const solid = (minLength: number, maxLength: number) =>
  Arbitrary.array(Arbitrary.schema(Schema.Literals(["a", "Z", "7", ".", "-", "é", "😀"])), {
    minLength,
    maxLength,
  }).pipe(
    Arbitrary.map((characters) =>
      characters.reduce(
        (text, character) =>
          text.length + character.length <= maxLength ? text + character : text,
        "",
      ),
    ),
    Arbitrary.filter((text) => text.length >= minLength),
  );

const whitespace = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[ \n\t]*$/), Schema.isMaxLength(6)),
);

const separator = Arbitrary.schema(Schema.Literals([" ", "\n", "\n\n", "  ", " \n\n "]));

const withoutWhitespace = (text: string) => text.replace(/\s+/g, "");

const words = (text: string) => text.split(/\s+/).filter((word) => word !== "");

property(
  "text that fits after trimming comes back as one trimmed part, and blank text as none",
  Arbitrary.all({ limit: int(1, 60), before: whitespace, after: whitespace }).pipe(
    Arbitrary.flatMap((outer) =>
      solid(0, outer.limit).pipe(
        Arbitrary.flatMap((head) =>
          solid(0, Math.max(0, outer.limit - head.length - 1)).pipe(
            Arbitrary.map((tail) => ({ ...outer, body: { head, tail } })),
          ),
        ),
      ),
    ),
  ),
  ({ limit, before, after, body }) => {
    const inner = `${body.head} ${body.tail}`.trim();
    const parts = chunk(`${before}${inner}${after}`, limit);
    expect(parts).toEqual(inner === "" ? [] : [inner]);
  },
  { size: 100 },
);

property(
  "every part is non-empty, trimmed, within the limit, and the parts keep every visible character in order",
  Arbitrary.all({
    limit: int(1, 50),
    pieces: Arbitrary.array(Arbitrary.all([solid(0, 70), separator]), { maxLength: 30 }),
  }),
  ({ limit, pieces }) => {
    const text = pieces.map(([word, gap]) => word + gap).join("");
    const parts = chunk(text, limit);
    for (const part of parts) {
      expect(part).not.toBe("");
      expect(part.length).toBeLessThanOrEqual(limit);
      expect(part).toBe(part.trim());
    }
    expect(withoutWhitespace(parts.join(""))).toBe(withoutWhitespace(text));
  },
  { size: 100 },
);

property(
  "a run with no break is cut into full slices of the limit with the remainder last",
  Arbitrary.all({ limit: int(1, 40), length: int(0, 200) }),
  ({ limit, length }) => {
    const text = "x".repeat(length);
    const expected: string[] = [];
    for (let at = 0; at < length; at += limit)
      expected.push("x".repeat(Math.min(limit, length - at)));
    expect(chunk(text, limit)).toEqual(expected);
  },
);

property(
  "words shorter than half the limit are never cut in the middle, so no emoji is split in half",
  int(6, 60).pipe(
    Arbitrary.flatMap((limit) =>
      Arbitrary.all({
        limit: Arbitrary.Constant(limit),
        pieces: Arbitrary.array(Arbitrary.all([solid(1, Math.floor(limit / 2) - 2), separator]), {
          maxLength: 40,
        }),
      }),
    ),
  ),
  ({ limit, pieces }) => {
    const text = pieces.map(([word, gap]) => word + gap).join("");
    const parts = chunk(text, limit);
    expect(parts.flatMap(words)).toEqual(pieces.map(([word]) => word));
    expect(parts.some((part) => /\p{Cs}/u.test(part))).toBe(false);
  },
  { size: 100 },
);

property(
  "paragraphs too big to pair up each become their own part",
  int(4, 60).pipe(
    Arbitrary.flatMap((limit) =>
      Arbitrary.all({
        limit: Arbitrary.Constant(limit),
        paragraphs: Arbitrary.array(solid(Math.floor(limit / 2) + 1, limit), {
          minLength: 1,
          maxLength: 8,
        }),
      }),
    ),
  ),
  ({ limit, paragraphs }) => {
    expect(chunk(paragraphs.join("\n\n"), limit)).toEqual(paragraphs);
  },
  { size: 100 },
);

property(
  "short paragraphs are packed whole, and a part is closed only when the next paragraph would reach the limit",
  int(8, 80).pipe(
    Arbitrary.flatMap((limit) =>
      Arbitrary.all({
        limit: Arbitrary.Constant(limit),
        paragraphs: Arbitrary.array(solid(1, Math.floor(limit / 2) - 2), { maxLength: 20 }),
      }),
    ),
  ),
  ({ limit, paragraphs }) => {
    const parts = chunk(paragraphs.join("\n\n"), limit);
    const grouped = parts.map((part) => part.split("\n\n"));
    expect(grouped.flat()).toEqual(paragraphs);
    grouped.slice(0, -1).forEach((group, index) => {
      const next = grouped[index + 1]![0]!;
      expect(group.join("\n\n").length + 2 + next.length).toBeGreaterThanOrEqual(limit);
    });
  },
  { size: 100 },
);

property(
  "the default limit keeps a Telegram message under 4096 characters with room to spare",
  int(3_995, 4_005),
  (length) => {
    const parts = chunk("y".repeat(length));
    expect(parts.map((part) => part.length)).toEqual(
      length <= 4_000 ? [length] : [4_000, length - 4_000],
    );
  },
  { runs: 30 },
);
