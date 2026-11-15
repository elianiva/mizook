import { Effect, Exit } from "effect";
import { expect, test } from "vite-plus/test";
import { packTar, unpackTar } from "../src/tar.ts";

test("files survive a tar round trip, including empty, binary and multi-block ones", async () => {
  const binary = Uint8Array.from({ length: 1300 }, (_, i) => i % 256);
  const files = { "main/2026-01-01.jsonl": "héllo\n".repeat(200), empty: "", bin: binary };
  const tar = await Effect.runPromise(packTar(files, 1));
  expect(tar.length % 512).toBe(0);
  const back = await Effect.runPromise(unpackTar(tar));
  expect(Object.keys(back)).toEqual(Object.keys(files));
  expect(new TextDecoder().decode(back["main/2026-01-01.jsonl"])).toBe(
    files["main/2026-01-01.jsonl"],
  );
  expect(back["empty"]).toHaveLength(0);
  expect(back["bin"]).toEqual(binary);
});

test("system tar can list what we wrote, and a name over 100 bytes is refused", async () => {
  const tar = await Effect.runPromise(packTar({ "a/b.txt": "x" }, 1));
  const { spawnSync } = await import("node:child_process");
  const listed = spawnSync("tar", ["-tf", "-"], { input: tar });
  expect(listed.stdout.toString().trim()).toBe("a/b.txt");
  expect(Exit.isFailure(await Effect.runPromiseExit(packTar({ ["x".repeat(101)]: "" })))).toBe(
    true,
  );
  expect(Exit.isFailure(await Effect.runPromiseExit(unpackTar(tar.subarray(0, 512))))).toBe(true);
});
