// The kit's peer surface is `foldkit` and `effect`. `@foldkit/ui` belongs to the
// demo, where the comparison lives, and must not enter the kit's graph.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const here = new URL(".", import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as Record<
  string,
  Record<string, string> | undefined
>;

test("the kit does not depend on @foldkit/ui", () => {
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    expect(Object.keys(manifest[field] ?? {})).not.toContain("@foldkit/ui");
  }
});

test("no kit source imports @foldkit/ui", () => {
  const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  for (const file of sources) {
    expect(readFileSync(join(here, file), "utf8"), file).not.toMatch(/from ['"]@foldkit\/ui/);
  }
});

test("the peer surface is foldkit and effect", () => {
  expect(Object.keys(manifest["peerDependencies"] ?? {}).toSorted()).toEqual(["effect", "foldkit"]);
});

// The registry and the lock state belong to a `Registry` value that the app
// provides as a Resource. A module-level mutable binding would bring back the
// global that tests had to reset.
test("no kit source holds module-level mutable state", () => {
  const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  const offenders = sources.flatMap((file) =>
    readFileSync(join(here, file), "utf8")
      .split("\n")
      .filter(
        (line) =>
          /^(export )?(let|var) /.test(line) ||
          /^(export )?const \w+(: [^=]+)? = new (Map|Set|WeakMap|WeakSet)\b/.test(line) ||
          /import\.meta(\s+as [^)]+)?\)?\.hot|import\.meta\.hot/.test(line),
      )
      .map((line) => `${file}: ${line}`),
  );
  expect(offenders).toEqual([]);
});

// The adapter is headless: behavior and attributes only. Themes live in @foldlab/ui.
test("no adapter source imports styling", () => {
  const sources = readdirSync(here, { recursive: true, encoding: "utf8" }).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  for (const file of sources) {
    expect(readFileSync(join(here, file), "utf8"), file).not.toMatch(
      /@foldlab\/ui|@pandacss|styled-system/,
    );
  }
  expect(JSON.stringify(manifest)).not.toMatch(/pandacss|@foldlab\/ui/);
});
