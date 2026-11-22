import { Arbitrary, Effect, Exit, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { expect } from "vite-plus/test";
import { packTar, unpackTar } from "../src/tar.ts";
import { property } from "./property.ts";

const encoder = new TextEncoder();

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));

const name = Arbitrary.schema(
  Schema.String.check(Schema.isPattern(/^[a-z0-9.é-]+(\/[a-z0-9.é-]+)*$/), Schema.isMaxLength(60)),
).pipe(Arbitrary.filter((text) => encoder.encode(text).length <= 100));

const content = Arbitrary.all([
  Arbitrary.schema(Schema.String.check(Schema.isMaxLength(1_100))),
  Arbitrary.schema(Schema.Uint8Array.check(Schema.isMaxLength(1_300))),
  Arbitrary.schema(Schema.Boolean),
]).pipe(Arbitrary.map(([text, bytes, asText]) => (asText ? text : bytes)));

const filesOf = (minLength: number) =>
  Arbitrary.array(Arbitrary.all([name, content]), { minLength, maxLength: 6 }).pipe(
    Arbitrary.map((entries) => Object.fromEntries(entries)),
  );

const files = filesOf(0);

const mtime = int(0, 8 ** 11 - 1);

const bytesOf = (value: string | Uint8Array) =>
  typeof value === "string" ? encoder.encode(value) : value;

const field = (header: Uint8Array, offset: number, width: number) =>
  new TextDecoder().decode(header.subarray(offset, offset + width)).replace(/\0.*$/s, "");

const headerOffsets = (archive: Record<string, string | Uint8Array>) => {
  const offsets: number[] = [];
  let at = 0;
  for (const value of Object.values(archive)) {
    offsets.push(at);
    at += 512 + Math.ceil(bytesOf(value).length / 512) * 512;
  }
  return { offsets, end: at };
};

property(
  "every file comes back byte for byte under its name, in order, after packing and unpacking",
  Arbitrary.all({ files, mtime }),
  ({ files, mtime }) =>
    Effect.gen(function* () {
      const back = yield* unpackTar(yield* packTar(files, mtime));
      expect(Object.keys(back)).toEqual(Object.keys(files));
      for (const [key, value] of Object.entries(files)) {
        expect(back[key]).toEqual(bytesOf(value));
      }
    }),
  { runs: 60, size: 1_300 },
);

property(
  "the archive is one header block per file, each body padded to 512 bytes, and two zero blocks at the end",
  Arbitrary.all({ files, mtime }),
  ({ files, mtime }) =>
    Effect.gen(function* () {
      const tar = yield* packTar(files, mtime);
      const { end } = headerOffsets(files);
      expect(tar.length).toBe(end + 1024);
      expect(tar.subarray(end).every((byte) => byte === 0)).toBe(true);
    }),
  { runs: 60, size: 1_300 },
);

property(
  "each header carries a valid ustar checksum, the size, the mode 644 and the given mtime in octal",
  Arbitrary.all({ files, mtime }),
  ({ files, mtime }) =>
    Effect.gen(function* () {
      const tar = yield* packTar(files, mtime);
      const { offsets } = headerOffsets(files);
      Object.values(files).forEach((value, index) => {
        const header = tar.subarray(offsets[index]!, offsets[index]! + 512);
        const withBlankChecksum = Uint8Array.from(header);
        withBlankChecksum.fill(32, 148, 156);
        const sum = withBlankChecksum.reduce((total, byte) => total + byte, 0);
        expect(Number.parseInt(field(header, 148, 8), 8)).toBe(sum);
        expect(Number.parseInt(field(header, 124, 12), 8)).toBe(bytesOf(value).length);
        expect(field(header, 100, 8)).toBe("0000644");
        expect(Number.parseInt(field(header, 136, 12), 8)).toBe(mtime);
        expect(field(header, 156, 1)).toBe("0");
        expect(field(header, 257, 6)).toBe("ustar");
      });
    }),
  { runs: 60, size: 1_300 },
);

property(
  "the system tar lists exactly the names that were packed",
  Arbitrary.all({ files: filesOf(1), mtime }),
  ({ files, mtime }) =>
    Effect.gen(function* () {
      const tar = yield* packTar(files, mtime);
      const listed = spawnSync("tar", ["-tf", "-"], { input: tar });
      expect(listed.status).toBe(0);
      expect(listed.stdout.toString().split("\n").filter(Boolean)).toEqual(Object.keys(files));
    }),
  { runs: 15, size: 1_300 },
);

property(
  "a name is accepted up to 100 bytes of UTF-8 and refused beyond, counting bytes rather than characters",
  Arbitrary.all({
    count: int(1, 110),
    character: Arbitrary.schema(Schema.Literals(["x", "é", "€"])),
  }),
  ({ count, character }) =>
    Effect.gen(function* () {
      const longName = character.repeat(count);
      const exit = yield* Effect.exit(packTar({ [longName]: "" }, 0));
      expect(Exit.isSuccess(exit)).toBe(encoder.encode(longName).length <= 100);
    }),
);

property(
  "an archive cut off inside a file body is refused",
  Arbitrary.schema(Schema.Uint8Array.check(Schema.isMinLength(1), Schema.isMaxLength(1_300))).pipe(
    Arbitrary.flatMap((body) =>
      Arbitrary.all({ body: Arbitrary.Constant(body), keep: int(0, body.length - 1) }),
    ),
  ),
  ({ body, keep }) =>
    Effect.gen(function* () {
      const tar = yield* packTar({ file: body }, 0);
      const exit = yield* Effect.exit(unpackTar(tar.subarray(0, 512 + keep)));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  { size: 1_300 },
);
