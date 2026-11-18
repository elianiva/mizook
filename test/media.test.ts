import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { Media, type ExtractInput } from "../src/media.ts";

const fakeAi = {
  run: async (model: string) =>
    model === "@cf/openai/whisper" ? { text: "hello there" } : { response: "a cat on a desk" },
  toMarkdown: async (document: { name: string; blob: Blob }) => ({
    id: "1",
    name: document.name,
    mimeType: document.blob.type,
    format: "markdown",
    tokens: 3,
    data: "# Receipt\n\nTotal: 10",
  }),
} as unknown as Ai;

const extract = (ai: Ai | undefined, input: ExtractInput) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Media, (media) => media.extract(input)),
      Media.layer(ai),
    ),
  );

test("a voice note becomes a transcript", async () => {
  const out = await extract(fakeAi, {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "audio/ogg",
    name: "voice.oga",
  });
  expect(out).toEqual({ kind: "transcript", text: "hello there" });
});

test("an image becomes a description", async () => {
  const out = await extract(fakeAi, {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    name: "screen.png",
  });
  expect(out).toEqual({ kind: "description", text: "a cat on a desk" });
});

test("a PDF becomes markdown", async () => {
  const out = await extract(fakeAi, {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "application/pdf",
    name: "receipt.pdf",
  });
  expect(out).toEqual({ kind: "document", text: "# Receipt\n\nTotal: 10" });
});

test("an unsupported file is left alone, and so is everything without AI", async () => {
  const input = {
    bytes: new Uint8Array([1, 2, 3]),
    contentType: "application/zip",
    name: "archive.zip",
  };
  expect(await extract(fakeAi, input)).toBeUndefined();
  expect(
    await extract(undefined, {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "audio/ogg",
      name: "voice.oga",
    }),
  ).toBeUndefined();
});
