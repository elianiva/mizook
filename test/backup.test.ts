import { Store, sqliteStore, type SqlDriver } from "@mizook/memory";
import { ConfigProvider, Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Artifacts } from "../src/artifacts.ts";
import { Backup } from "../src/backup.ts";
import { Blobs } from "../src/blobs.ts";
import { Settings } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { fakeHost } from "./fake-host.ts";
import { Intents } from "../src/intents.ts";
import { Policies } from "../src/policies.ts";
import { Skills } from "../src/skills.ts";
import { State } from "../src/state.ts";

const settings = Settings.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        BOT_TOKEN: "x",
        MIZOOK_WEBHOOK_SECRET: "x",
        DEEPSEEK_API_KEY: "x",
        PUBLIC_URL: "https://t.test",
      }),
    ),
  ),
);

/** One channel: its own SQLite, over a shared blob store. */
const channel = (blobs: Layer.Layer<Blobs>) => {
  const db = new DatabaseSync(":memory:");
  const sql: SqlDriver = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Backup.layer.pipe(
    Layer.provideMerge(Artifacts.layer(sql)),
    Layer.provideMerge(Skills.layer(sql)),
    Layer.provideMerge(Intents.layer(sql)),
    Layer.provideMerge(Policies.layer(sql)),
    Layer.provideMerge(State.layer(sql)),
    Layer.provideMerge(sqliteStore(sql)),
    Layer.provideMerge(blobs),
    Layer.provide(settings),
    // Backup reads only who the agent is: its exports are filed under its Durable Object.
    Layer.provide(Layer.succeed(Host, fakeHost())),
  );
};

test("an archive restores a channel into an empty one: log, nodes, view, settings, artifacts", async () => {
  const shared = Layer.build(Blobs.memory).pipe(Effect.map((c) => Layer.succeedContext(c)));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const blobs = yield* shared;
        const source = yield* Layer.build(channel(blobs));
        const exported = yield* Effect.gen(function* () {
          const store = yield* Store;
          const state = yield* State;
          const skills = yield* Skills;
          const intents = yield* Intents;
          const policies = yield* Policies;
          const artifacts = yield* Artifacts;
          for (let i = 0; i < 5; i++) {
            yield* store.appendMessage({
              i,
              kind: "user",
              text: `m${i}`,
              size: 2,
              date: `2026-01-0${i + 1}T10:00:00Z`,
            });
          }
          yield* store.putNode({ l: 1, i: 0, text: "summary 0-1", size: 11 });
          yield* store.saveViews({
            chat: {
              lines: [
                [1, 0],
                [0, 2],
              ],
              pending: false,
            },
            compaction: { lines: [], pending: false },
          });
          yield* state.setMeta("thread", "telegram:-1:5");
          yield* state.setMeta("setting:model", "deepseek-flash");
          yield* skills.save("weekly-review", "Review the week", "1. Read seven days.");
          yield* skills.pin("weekly-review");
          yield* intents.create("Check the rollback owner", ["launch"], {
            expiresAt: Date.now() + 86_400_000,
            cooldownMs: 0,
            maxFires: 2,
          });
          yield* policies.add("gmail.send", "ask");
          yield* artifacts.publish("telegram:-1:5", "page.html", "<p>hi</p>", "text/html");
          const snapshot = yield* store.snapshot;
          return { tar: yield* (yield* Backup).tar, snapshot };
        }).pipe(Effect.provide(source));

        const target = yield* Layer.build(channel(blobs));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const state = yield* State;
          yield* state.setMeta("thread", "telegram:-1:5");
          yield* (yield* Backup).restoreTar(exported.tar);
          expect(yield* store.snapshot).toEqual(exported.snapshot);
          expect((yield* state.settings).model).toBe("deepseek-flash");
          const restoredSkills = yield* (yield* Skills).list;
          expect(restoredSkills.map((s) => s.name)).toEqual(["weekly-review"]);
          expect(restoredSkills[0]?.pinned).toBe(true);
          expect((yield* (yield* Intents).list)[0]?.description).toBe("Check the rollback owner");
          expect((yield* (yield* Policies).list)[0]).toMatchObject({
            match: "gmail.send",
            decision: "ask",
          });
          const [page] = yield* (yield* Artifacts).list;
          expect(page?.name).toBe("page.html");
          // A second restore into a channel that now has messages is refused.
          expect((yield* Effect.exit((yield* Backup).restoreTar(exported.tar)))._tag).toBe(
            "Failure",
          );
        }).pipe(Effect.provide(target));
      }),
    ),
  );
});

test("a backup runs when a day has passed, and only the newest 14 are kept", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(Layer.mergeAll(channel(Blobs.memory)));
        yield* Effect.gen(function* () {
          const backup = yield* Backup;
          const blobs = yield* Blobs;
          const day = 24 * 3_600_000;
          const t0 = Date.UTC(2026, 0, 1);
          expect(yield* backup.backupIfDue(t0)).toBe(false);
          expect(yield* backup.backupIfDue(t0 + day - 1)).toBe(false);
          for (let d = 1; d <= 20; d++) expect(yield* backup.backupIfDue(t0 + d * day)).toBe(true);
          expect(yield* blobs.list("backup/")).toHaveLength(14);
          expect(yield* backup.nextBackupAt).toBe(t0 + 21 * day);
        }).pipe(Effect.provide(ctx));
      }),
    ),
  );
});
