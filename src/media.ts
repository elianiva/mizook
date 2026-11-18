import { Context, Effect, Layer } from "effect";
import { MediaError } from "./errors.ts";

export interface ExtractInput {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly name: string;
}

export interface Extracted {
  readonly kind: "transcript" | "description" | "document";
  readonly text: string;
}

export const MEDIA_LABEL = {
  transcript: "Transcript",
  description: "Image",
  document: "Document",
} as const;

const AUDIO_MAX = 25 * 1024 * 1024;
const IMAGE_MAX = 10 * 1024 * 1024;
const DOCUMENT_MAX = 20 * 1024 * 1024;

const AUDIO = /\.(ogg|oga|mp3|m4a|wav|flac)$/i;
const IMAGE = /\.(png|jpe?g|webp|gif|heic)$/i;

const isAudio = (input: ExtractInput) =>
  input.contentType.startsWith("audio/") || AUDIO.test(input.name);
const isImage = (input: ExtractInput) =>
  input.contentType.startsWith("image/") || IMAGE.test(input.name);
const isDocument = (input: ExtractInput) =>
  input.contentType === "application/pdf" ||
  input.contentType === "application/msword" ||
  input.contentType.includes("wordprocessingml") ||
  input.contentType.includes("presentationml") ||
  input.contentType.includes("spreadsheetml");

/**
 * Read what the user sent with Workers AI: a voice note becomes text, an image becomes a
 * description, and a document becomes markdown. Unsupported files stay a name and a size.
 */
export class Media extends Context.Service<
  Media,
  {
    extract(input: ExtractInput): Effect.Effect<Extracted | undefined, MediaError>;
  }
>()("mizook/Media") {
  static readonly layer = (ai: Ai | undefined) =>
    Layer.succeed(
      Media,
      Media.of({
        extract: (input) => {
          if (!ai || input.bytes.length === 0) return Effect.void.pipe(Effect.as(undefined));
          const attempt = <A>(operation: string, f: () => Promise<A>) =>
            Effect.tryPromise({
              try: f,
              catch: (cause) => new MediaError({ operation, cause }),
            });

          if (isAudio(input)) {
            if (input.bytes.length > AUDIO_MAX) {
              return Effect.fail(
                new MediaError({ operation: "transcribe", cause: "file is too large" }),
              );
            }
            return attempt("transcribe", async () => {
              const result = await ai.run("@cf/openai/whisper", {
                audio: Array.from(input.bytes),
              });
              const text = result.text.trim();
              return text === "" ? undefined : ({ kind: "transcript", text } satisfies Extracted);
            });
          }

          if (isImage(input)) {
            if (input.bytes.length > IMAGE_MAX) {
              return Effect.fail(
                new MediaError({ operation: "describe", cause: "file is too large" }),
              );
            }
            return attempt("describe", async () => {
              const result = await ai.run("@cf/meta/llama-3.2-11b-vision-instruct", {
                prompt:
                  "Describe this image for someone who cannot see it. Transcribe any text. Be concrete and short.",
                image: Array.from(input.bytes),
                max_tokens: 600,
              });
              const text = (result.response ?? "").trim();
              return text === "" ? undefined : ({ kind: "description", text } satisfies Extracted);
            });
          }

          if (isDocument(input)) {
            if (input.bytes.length > DOCUMENT_MAX) {
              return Effect.fail(
                new MediaError({ operation: "convert", cause: "file is too large" }),
              );
            }
            return attempt("convert", async () => {
              const result = await ai.toMarkdown({
                name: input.name || "attachment",
                blob: new Blob([new Uint8Array(input.bytes)], { type: input.contentType }),
              });
              if (result.format === "error") throw new Error(result.error);
              const text = result.data.trim();
              return text === "" ? undefined : ({ kind: "document", text } satisfies Extracted);
            });
          }

          return Effect.void.pipe(Effect.as(undefined));
        },
      }),
    );
}
