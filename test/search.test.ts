import { Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, test } from "vite-plus/test";
import { searchWith, type SearchProvider } from "../src/search.ts";
import { WebError } from "../src/errors.ts";

const ok = (name: string): SearchProvider => ({
  name,
  search: () => Effect.succeed([{ title: name, url: `https://${name}`, snippet: "" }]),
});
const broken = (name: string): SearchProvider => ({
  name,
  search: () => Effect.fail(new WebError({ url: name, reason: "rate limited" })),
});
const titles = (order: Parameters<typeof searchWith>[0]) =>
  Effect.runPromise(
    Effect.map(searchWith(order, "q", 5), (r) => r.map((x) => x.title)).pipe(
      Effect.provide(FetchHttpClient.layer),
    ),
  );

test("search tries providers in order and falls through to the next on an error", async () => {
  expect(
    await titles([
      { provider: ok("parallel"), key: "k" },
      { provider: ok("exa"), key: "k" },
    ]),
  ).toEqual(["parallel"]);
  expect(
    await titles([
      { provider: broken("parallel"), key: "k" },
      { provider: ok("exa"), key: "k" },
    ]),
  ).toEqual(["exa"]);
});

test("when every provider fails, search fails; with none configured it fails too", async () => {
  const all = searchWith(
    [
      { provider: broken("a"), key: "k" },
      { provider: broken("b"), key: "k" },
    ],
    "q",
    5,
  );
  expect(
    Exit.isFailure(await Effect.runPromiseExit(all.pipe(Effect.provide(FetchHttpClient.layer)))),
  ).toBe(true);
  const none = searchWith([], "q", 5);
  expect(
    Exit.isFailure(await Effect.runPromiseExit(none.pipe(Effect.provide(FetchHttpClient.layer)))),
  ).toBe(true);
});
