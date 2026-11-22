import { Arbitrary, Schema } from "effect";
import { expect } from "vite-plus/test";
import { htmlToText } from "../src/web.ts";
import { property } from "./property.ts";

const word = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9.,!?$é—😀]+$/u), Schema.isMaxLength(12)),
);

const sentence = Arbitrary.array(word, { minLength: 1, maxLength: 6 }).pipe(
  Arbitrary.map((words) => words.join(" ")),
);

const lines = Arbitrary.array(sentence, { minLength: 1, maxLength: 6 });

const blankRun = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[ \t\n\u00a0]+$/), Schema.isMaxLength(5)),
);

const hidden = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9 (){};=."'&]*$/), Schema.isMaxLength(40)),
);

const visibleCodePoint = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ minimum: 0x21, maximum: 0x2ffff })),
).pipe(
  Arbitrary.filter(
    (code) =>
      (code < 0x7f || code > 0xa0) &&
      (code < 0xd800 || code > 0xdfff) &&
      !/\s/u.test(String.fromCodePoint(code)),
  ),
);

property("plain text without markup comes back unchanged", sentence, (text) => {
  expect(htmlToText(text)).toBe(text);
});

property(
  "runs of spaces, tabs and non-breaking spaces collapse to one space and the ends are trimmed",
  Arbitrary.all({
    words: Arbitrary.array(word, { minLength: 1, maxLength: 6 }),
    gaps: Arbitrary.array(
      Arbitrary.schema(
        Schema.String.check(Schema.isPattern(/^[ \t\u00a0]+$/), Schema.isMaxLength(5)),
      ),
      { minLength: 7, maxLength: 7 },
    ),
  }),
  ({ words, gaps }) => {
    const html = gaps[0] + words.map((w, i) => w + gaps[i + 1]).join("");
    expect(htmlToText(html)).toBe(words.join(" "));
  },
);

property(
  "decimal and hex character references, in either letter case, decode to the character they name",
  Arbitrary.all({
    code: visibleCodePoint,
    form: Arbitrary.schema(Schema.Literals(["decimal", "hex", "HEX"])),
  }),
  ({ code, form }) => {
    const entity =
      form === "decimal"
        ? `&#${code};`
        : form === "hex"
          ? `&#x${code.toString(16)};`
          : `&#x${code.toString(16).toUpperCase()};`;
    expect(htmlToText(`a${entity}b`)).toBe(`a${String.fromCodePoint(code)}b`);
  },
);

property(
  "the named entities decode, in any letter case, and unknown names are kept as written",
  Arbitrary.all({
    entity: Arbitrary.schema(
      Schema.Literals(["amp", "lt", "gt", "quot", "apos", "nbsp", "AMP", "Lt", "copyx", "zz"]),
    ),
    left: word,
    right: word,
  }),
  ({ entity, left, right }) => {
    const meaning: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    const decoded = meaning[entity.toLowerCase()] ?? `&${entity};`;
    expect(htmlToText(`${left}&${entity};${right}`)).toBe(`${left}${decoded}${right}`);
  },
);

property(
  "script, style, noscript, svg, template, head and comment contents never show up",
  Arbitrary.all({
    tag: Arbitrary.schema(
      Schema.Literals(["script", "style", "noscript", "svg", "template", "head", "SCRIPT"]),
    ),
    secret: hidden,
    before: sentence,
    after: sentence,
    comment: hidden,
  }),
  ({ tag, secret, before, after, comment }) => {
    const html = `<p>${before}</p><${tag} id="x">${secret}</${tag}><!--${comment}--><p>${after}</p>`;
    expect(htmlToText(html)).toBe(`${before}\n${after}`);
  },
);

property(
  "only the main or article element is read when the page has one",
  Arbitrary.all({
    container: Arbitrary.schema(Schema.Literals(["main", "article", "MAIN"])),
    nav: sentence,
    body: lines,
    footer: sentence,
  }),
  ({ container, nav, body, footer }) => {
    const html = `<html><body><nav>${nav}</nav><${container} class="c">${body
      .map((line) => `<p>${line}</p>`)
      .join("")}</${container}><footer>${footer}</footer></body></html>`;
    expect(htmlToText(html)).toBe(body.join("\n"));
  },
);

property(
  "block elements end a line and list items become dashed lines, with blank lines squeezed out",
  Arbitrary.all({
    heading: sentence,
    paragraphs: lines,
    items: lines,
    gap: blankRun,
  }),
  ({ heading, paragraphs, items, gap }) => {
    const html = `<h2>${heading}</h2>${gap}${paragraphs
      .map((p) => `<div>${p}</div>${gap}<br>`)
      .join("")}<ul>${items.map((item) => `<li>${item}</li>${gap}`).join("")}</ul>`;
    expect(htmlToText(html)).toBe(
      [heading, ...paragraphs, ...items.map((item) => `- ${item}`)].join("\n"),
    );
  },
);
