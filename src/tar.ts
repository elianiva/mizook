import { Effect } from "effect";
import { ArchiveError } from "@mizook/memory";

const TAR_BLOCK_BYTES = 512;
const USTAR_MAX_NAME_BYTES = 100;
const REGULAR_FILE_MODE = 0o644;

const USTAR_HEADER = {
  name: { offset: 0, width: USTAR_MAX_NAME_BYTES },
  mode: { offset: 100, width: 8 },
  ownerId: { offset: 108, width: 8 },
  groupId: { offset: 116, width: 8 },
  size: { offset: 124, width: 12 },
  modifiedSeconds: { offset: 136, width: 12 },
  checksum: { offset: 148, width: 8 },
  typeFlag: { offset: 156, width: 1 },
  magic: { offset: 257, width: 6 },
  version: { offset: 263, width: 2 },
} as const;

const REGULAR_FILE_TYPE_FLAG = "0";
const LEGACY_REGULAR_FILE_TYPE_FLAG = "";
const CHECKSUM_PLACEHOLDER = " ".repeat(USTAR_HEADER.checksum.width);
const END_OF_ARCHIVE_BLOCKS = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const writeAt = (header: Uint8Array, offset: number, text: string) =>
  header.set(encoder.encode(text), offset);

const nulTerminatedOctal = (value: number, width: number) =>
  value.toString(8).padStart(width - 1, "0") + "\0";

const paddingToBlockBoundary = (byteLength: number) =>
  new Uint8Array((TAR_BLOCK_BYTES - (byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES);

export const packTar = (
  files: Readonly<Record<string, string | Uint8Array>>,
  mtime = Math.floor(Date.now() / 1000),
): Effect.Effect<Uint8Array, ArchiveError> =>
  Effect.gen(function* () {
    const parts: Uint8Array[] = [];
    for (const [name, content] of Object.entries(files)) {
      const body = typeof content === "string" ? encoder.encode(content) : content;
      if (encoder.encode(name).length > USTAR_MAX_NAME_BYTES) {
        return yield* new ArchiveError({ reason: `name too long for tar: ${name}` });
      }
      const header = new Uint8Array(TAR_BLOCK_BYTES);
      const { mode, ownerId, groupId, size, modifiedSeconds, checksum, typeFlag, magic, version } =
        USTAR_HEADER;
      writeAt(header, USTAR_HEADER.name.offset, name);
      writeAt(header, mode.offset, nulTerminatedOctal(REGULAR_FILE_MODE, mode.width));
      writeAt(header, ownerId.offset, nulTerminatedOctal(0, ownerId.width));
      writeAt(header, groupId.offset, nulTerminatedOctal(0, groupId.width));
      writeAt(header, size.offset, nulTerminatedOctal(body.length, size.width));
      writeAt(header, modifiedSeconds.offset, nulTerminatedOctal(mtime, modifiedSeconds.width));
      writeAt(header, checksum.offset, CHECKSUM_PLACEHOLDER);
      writeAt(header, typeFlag.offset, REGULAR_FILE_TYPE_FLAG);
      writeAt(header, magic.offset, "ustar\0");
      writeAt(header, version.offset, "00");
      const headerByteSum = header.reduce((a, b) => a + b, 0);
      writeAt(header, checksum.offset, `${headerByteSum.toString(8).padStart(6, "0")}\0 `);
      parts.push(header, body, paddingToBlockBoundary(body.length));
    }
    parts.push(new Uint8Array(TAR_BLOCK_BYTES * END_OF_ARCHIVE_BLOCKS));
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  });

const readField = (header: Uint8Array, field: { offset: number; width: number }) =>
  decoder.decode(header.subarray(field.offset, field.offset + field.width)).replace(/\0.*$/s, "");

export const unpackTar = (
  bytes: Uint8Array,
): Effect.Effect<Record<string, Uint8Array>, ArchiveError> =>
  Effect.gen(function* () {
    const files: Record<string, Uint8Array> = {};
    let at = 0;
    while (at + TAR_BLOCK_BYTES <= bytes.length) {
      const header = bytes.subarray(at, at + TAR_BLOCK_BYTES);
      const isEndOfArchive = header.every((b) => b === 0);
      if (isEndOfArchive) break;
      const name = readField(header, USTAR_HEADER.name);
      const size = Number.parseInt(readField(header, USTAR_HEADER.size).trim(), 8);
      const bodyStart = at + TAR_BLOCK_BYTES;
      if (!Number.isFinite(size) || bodyStart + size > bytes.length) {
        return yield* new ArchiveError({ reason: `bad tar entry ${name}` });
      }
      const type = readField(header, USTAR_HEADER.typeFlag);
      const isRegularFile =
        type === REGULAR_FILE_TYPE_FLAG || type === LEGACY_REGULAR_FILE_TYPE_FLAG;
      if (isRegularFile) {
        files[name] = bytes.slice(bodyStart, bodyStart + size);
      }
      at = bodyStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    }
    return files;
  });
