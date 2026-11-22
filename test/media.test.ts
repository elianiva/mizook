import { Arbitrary, Effect, Exit, Schema } from "effect";
import { expect } from "vite-plus/test";
import { Media, type ExtractInput } from "../src/media.ts";
import { property } from "./property.ts";

interface Call {
  readonly model: string;
  readonly input: Record<string, unknown>;
}

interface Replies {
  readonly transcript: string;
  readonly description: string | undefined;
  readonly markdown: string;
  readonly markdownFails: boolean;
}

const fakeAi = (replies: Replies, calls: Call[]) =>
  ({
    run: async (model: string, input: Record<string, unknown>) => {
      calls.push({ model, input });
      return model === "@cf/openai/whisper"
        ? { text: replies.transcript }
        : replies.description === undefined
          ? {}
          : { response: replies.description };
    },
    toMarkdown: async (document: { name: string; blob: Blob }) => {
      calls.push({ model: "toMarkdown", input: { name: document.name, type: document.blob.type } });
      return replies.markdownFails
        ? {
            id: "1",
            name: document.name,
            mimeType: document.blob.type,
            format: "error",
            error: "no",
          }
        : {
            id: "1",
            name: document.name,
            mimeType: document.blob.type,
            format: "markdown",
            tokens: 1,
            data: replies.markdown,
          };
    },
  }) as unknown as Ai;

const extract = (ai: Ai | undefined, input: ExtractInput) =>
  Effect.exit(Effect.flatMap(Media, (media) => media.extract(input))).pipe(
    Effect.provide(Media.layer(ai)),
  );

const contentType = Arbitrary.schema(
  Schema.Literals([
    "audio/ogg",
    "audio/mpeg",
    "image/png",
    "image/jpeg",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip",
    "application/pdfx",
    "text/plain",
    "application/octet-stream",
    "",
  ]),
);

const extension = Arbitrary.schema(
  Schema.Literals([
    ".ogg",
    ".OGA",
    ".mp3",
    ".m4a",
    ".wav",
    ".flac",
    ".png",
    ".JPG",
    ".jpeg",
    ".webp",
    ".gif",
    ".heic",
    ".pdf",
    ".zip",
    ".txt",
    ".ogg.zip",
    "ogg",
    "",
  ]),
);

const stem = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-z0-9 _-]*$/), Schema.isMaxLength(8)),
);

const name = Arbitrary.all([stem, extension]).pipe(Arbitrary.map(([base, ext]) => base + ext));

const bytes = Arbitrary.schema(
  Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(16)),
);

const input = Arbitrary.all({ bytes, contentType, name });

const padding = Arbitrary.schema(Schema.Literals(["", " ", "\n", " \n\t "]));

const padded = Arbitrary.all([
  padding,
  Arbitrary.schema(
    Schema.String.check(Schema.isPattern(/^[a-zA-Zé😀 .#\n]*$/u), Schema.isMaxLength(30)),
  ),
  padding,
]).pipe(Arbitrary.map(([before, body, after]) => before + body + after));

const replies = Arbitrary.all({
  transcript: padded,
  description: Arbitrary.all([padded, Arbitrary.schema(Schema.Boolean)]).pipe(
    Arbitrary.map(([text, present]) => (present ? text : undefined)),
  ),
  markdown: padded,
  markdownFails: Arbitrary.Constant(false),
});

const lastExtension = (fileName: string) => {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot + 1).toLowerCase();
};

const documentTypes = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const expectedKind = ({ contentType, name }: ExtractInput) => {
  const ext = lastExtension(name);
  if (contentType.startsWith("audio/") || ["ogg", "oga", "mp3", "m4a", "wav", "flac"].includes(ext))
    return "transcript";
  if (
    contentType.startsWith("image/") ||
    ["png", "jpg", "jpeg", "webp", "gif", "heic"].includes(ext)
  )
    return "description";
  if (documentTypes.includes(contentType)) return "document";
  return undefined;
};

const replyFor = (kind: string, reply: Replies) =>
  kind === "transcript"
    ? reply.transcript
    : kind === "description"
      ? (reply.description ?? "")
      : reply.markdown;

property(
  "a file is routed by content type or extension to transcription, description or conversion, and the trimmed reply comes back",
  Arbitrary.all({ input, replies }),
  ({ input, replies }) =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const exit = yield* extract(fakeAi(replies, calls), input);
      const kind = expectedKind(input);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) return;
      if (kind === undefined) {
        expect(exit.value).toBeUndefined();
        expect(calls).toEqual([]);
        return;
      }
      const text = replyFor(kind, replies).trim();
      expect(exit.value).toEqual(text === "" ? undefined : { kind, text });
      expect(calls).toHaveLength(1);
    }),
);

property(
  "the AI receives the file itself: audio and image bytes as numbers, documents with their name and type",
  Arbitrary.all({ input, replies }).pipe(
    Arbitrary.filter(({ input }) => expectedKind(input) !== undefined),
  ),
  ({ input, replies }) =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      yield* extract(fakeAi(replies, calls), input);
      const kind = expectedKind(input);
      const call = calls[0]!;
      if (kind === "transcript") {
        expect(call.model).toBe("@cf/openai/whisper");
        expect(call.input["audio"]).toEqual([...input.bytes]);
      } else if (kind === "description") {
        expect(call.model).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
        expect(call.input["image"]).toEqual([...input.bytes]);
      } else {
        expect(call.input).toEqual({
          name: input.name === "" ? "attachment" : input.name,
          type: input.contentType,
        });
      }
    }),
);

property(
  "without AI, or with an empty file, nothing is extracted and nothing is called",
  Arbitrary.all({ input, replies, withAi: Arbitrary.schema(Schema.Boolean) }),
  ({ input, replies, withAi }) =>
    Effect.gen(function* () {
      const calls: Call[] = [];
      const exit = yield* extract(
        withAi ? fakeAi(replies, calls) : undefined,
        withAi ? { ...input, bytes: new Uint8Array() } : input,
      );
      expect(exit).toEqual(Exit.succeed(undefined));
      expect(calls).toEqual([]);
    }),
);

property(
  "a document converter error fails the extraction instead of returning text",
  Arbitrary.all({
    input: Arbitrary.all({
      bytes,
      contentType: Arbitrary.schema(Schema.Literals(documentTypes)),
      name: stem,
    }),
    replies: replies.pipe(Arbitrary.map((reply) => ({ ...reply, markdownFails: true }))),
  }),
  ({ input, replies }) =>
    Effect.gen(function* () {
      const exit = yield* extract(fakeAi(replies, []), input);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  { runs: 30 },
);

const MB = 1024 * 1024;

property(
  "a file over its kind's size limit fails before the AI is called",
  Arbitrary.all({
    kind: Arbitrary.schema(Schema.Literals(["audio/ogg", "image/png", "application/pdf"])),
    over: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_096 }))),
    replies,
  }),
  ({ kind, over, replies }) =>
    Effect.gen(function* () {
      const limit = kind === "audio/ogg" ? 25 * MB : kind === "image/png" ? 10 * MB : 20 * MB;
      const calls: Call[] = [];
      const exit = yield* extract(fakeAi(replies, calls), {
        bytes: new Uint8Array(limit + over),
        contentType: kind,
        name: "file",
      });
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual([]);
    }),
  { runs: 15 },
);

property(
  "a document of exactly the 20 MB limit or just under is still converted",
  Arbitrary.all({
    under: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4_096 }))),
    replies: replies.pipe(Arbitrary.map((reply) => ({ ...reply, markdown: "# ok" }))),
  }),
  ({ under, replies }) =>
    Effect.gen(function* () {
      const exit = yield* extract(fakeAi(replies, []), {
        bytes: new Uint8Array(20 * MB - under),
        contentType: "application/pdf",
        name: "big.pdf",
      });
      expect(exit).toEqual(Exit.succeed({ kind: "document", text: "# ok" }));
    }),
  { runs: 5 },
);
