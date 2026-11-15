import { Effect } from "effect";
import { ArchiveError } from "@mizook/memory";

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const put = (header: Uint8Array, offset: number, text: string) =>
  header.set(encoder.encode(text), offset);

const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, "0") + "\0";

/** Files as a ustar archive: a plain format every system can open. Names are at most 100 bytes. */
export const packTar = (
  files: Readonly<Record<string, string | Uint8Array>>,
  mtime = Math.floor(Date.now() / 1000),
): Effect.Effect<Uint8Array, ArchiveError> =>
  Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    for (const [name, content] of Object.entries(files)) {
      const body = typeof content === "string" ? encoder.encode(content) : content;
      if (encoder.encode(name).length > 100) {
        return yield* new ArchiveError({ reason: `name too long for tar: ${name}` });
      }
      const header = new Uint8Array(BLOCK);
      put(header, 0, name);
      put(header, 100, octal(0o644, 8));
      put(header, 108, octal(0, 8));
      put(header, 116, octal(0, 8));
      put(header, 124, octal(body.length, 12));
      put(header, 136, octal(mtime, 12));
      put(header, 148, "        ");
      put(header, 156, "0");
      put(header, 257, "ustar\0");
      put(header, 263, "00");
      const sum = header.reduce((a, b) => a + b, 0);
      put(header, 148, `${sum.toString(8).padStart(6, "0")}\0 `);
      parts.push(header, body, new Uint8Array((BLOCK - (body.length % BLOCK)) % BLOCK));
    }
    parts.push(new Uint8Array(BLOCK * 2));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  });

const field = (header: Uint8Array, from: number, length: number) =>
  decoder.decode(header.subarray(from, from + length)).replace(/\0.*$/s, "");

/** The files of a ustar archive, by name. Only regular files are read. */
export const unpackTar = (
  bytes: Uint8Array,
): Effect.Effect<Record<string, Uint8Array>, ArchiveError> =>
  Effect.gen(function* () {
    const files: Record<string, Uint8Array> = {};
    let at = 0;
    while (at + BLOCK <= bytes.length) {
      const header = bytes.subarray(at, at + BLOCK);
      if (header.every((b) => b === 0)) break;
      const name = field(header, 0, 100);
      const size = Number.parseInt(field(header, 124, 12).trim(), 8);
      if (!Number.isFinite(size) || at + BLOCK + size > bytes.length) {
        return yield* new ArchiveError({ reason: `bad tar entry ${name}` });
      }
      const type = field(header, 156, 1);
      if (type === "0" || type === "") {
        files[name] = bytes.slice(at + BLOCK, at + BLOCK + size);
      }
      at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
    return files;
  });
