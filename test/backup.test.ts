import { Store, sqliteStore, type SqlDriver } from "@mizook/memory";
import { Arbitrary, ConfigProvider, Effect, Exit, Layer, Schema } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vite-plus/test";
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
import { property } from "./property.ts";

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
    Layer.provide(Layer.succeed(Host, fakeHost())),
  );
};

const int = (minimum: number, maximum: number) =>
  Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum, maximum })));
const oneOf = <const A extends ReadonlyArray<string | number>>(values: A) =>
  Arbitrary.schema(Schema.Literals(values));
const chars = (alphabet: string, minLength: number, maxLength: number) =>
  Arbitrary.array(oneOf(alphabet.split("")), { minLength, maxLength }).pipe(
    Arbitrary.map((cs) => cs.join("")),
  );
const survivesUtf8 = (s: string) => new TextDecoder().decode(new TextEncoder().encode(s)) === s;
const text = Arbitrary.schema(Schema.String).pipe(Arbitrary.filter(survivesUtf8));
/** Text a skill or intent accepts: not blank, nothing to trim, within every limit. */
const words = chars("abc xyz", 0, 30).pipe(Arbitrary.map((inner) => `w${inner}w`));
const distinctBy = <A>(items: ReadonlyArray<A>, key: (a: A) => string) =>
  new Set(items.map(key)).size === items.length;

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

const messages = Arbitrary.array(
  Arbitrary.all({
    kind: oneOf(["user", "agent", "tool", "echo", "note"]),
    text,
    gap: int(0, 3 * DAY),
  }),
  { minLength: 1, maxLength: 6 },
).pipe(
  Arbitrary.map((drafts) => {
    let at = START;
    return drafts.map(({ kind, text, gap }, i) => {
      at += gap;
      return {
        i,
        kind,
        text,
        size: new TextEncoder().encode(text).length,
        date: new Date(at).toISOString(),
      };
    });
  }),
);

const channelContents = Arbitrary.all({
  messages,
  nodes: Arbitrary.array(Arbitrary.all({ l: int(1, 3), i: int(0, 3), text }), {
    maxLength: 4,
  }).pipe(Arbitrary.filter((nodes) => distinctBy(nodes, (n) => `${n.l}:${n.i}`))),
  view: Arbitrary.array(Arbitrary.all([int(0, 3), int(0, 5)]), { maxLength: 4 }),
  pending: Arbitrary.schema(Schema.Boolean),
  settings: Arbitrary.array(Arbitrary.all({ key: chars("abcdef", 1, 6), value: text }), {
    maxLength: 4,
  }).pipe(Arbitrary.filter((s) => distinctBy(s, (x) => x.key))),
  skills: Arbitrary.array(
    Arbitrary.all({
      name: chars("abcdef-", 1, 8).pipe(Arbitrary.filter((name) => !name.startsWith("-"))),
      description: words,
      body: words,
      pinned: Arbitrary.schema(Schema.Boolean),
    }),
    { maxLength: 3 },
  ).pipe(Arbitrary.filter((s) => distinctBy(s, (x) => x.name))),
  intents: Arbitrary.array(
    Arbitrary.all({
      description: words,
      triggers: Arbitrary.array(chars("abcxyz", 1, 8), { minLength: 1, maxLength: 3 }),
      expiresIn: int(1, 30 * DAY),
      cooldown: int(0, DAY),
      maxFires: int(1, 9),
    }),
    { maxLength: 3 },
  ),
  policies: Arbitrary.array(
    Arbitrary.all({
      match: oneOf(["gmail.send", "web.*", "agents.manage", "*"]),
      decision: oneOf(["allow", "ask", "deny"]),
    }),
    { maxLength: 5 },
  ),
  artifacts: Arbitrary.array(
    Arbitrary.all({
      name: chars("abcxyz019.-", 1, 12).pipe(Arbitrary.filter((n) => /^[a-z0-9]/.test(n))),
      content: text,
      data: Arbitrary.array(Arbitrary.all({ key: chars("abK._-1", 1, 6), value: text }), {
        maxLength: 3,
      }).pipe(Arbitrary.filter((d) => distinctBy(d, (x) => x.key))),
    }),
    { maxLength: 3 },
  ).pipe(Arbitrary.filter((a) => distinctBy(a, (x) => x.name))),
});

property(
  "an archive restores any channel into an empty one: log, nodes, view, settings, skills, intents, policies, artifacts and their data; a second restore is refused",
  channelContents,
  (contents) => {
    const shared = Layer.build(Blobs.memory).pipe(Effect.map((c) => Layer.succeedContext(c)));
    return Effect.scoped(
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
          for (const m of contents.messages) yield* store.appendMessage(m);
          for (const n of contents.nodes)
            yield* store.putNode({ ...n, size: new TextEncoder().encode(n.text).length });
          yield* store.saveViews({
            chat: { lines: contents.view, pending: contents.pending },
            compaction: { lines: [], pending: false },
          });
          for (const { key, value } of contents.settings)
            yield* state.setMeta(`setting:${key}`, value);
          for (const s of contents.skills) {
            yield* skills.save(s.name, s.description, s.body);
            if (s.pinned) yield* skills.pin(s.name);
          }
          for (const i of contents.intents) {
            yield* intents.create(i.description, i.triggers, {
              expiresAt: Date.now() + i.expiresIn,
              cooldownMs: i.cooldown,
              maxFires: i.maxFires,
            });
          }
          for (const p of contents.policies) yield* policies.add(p.match, p.decision);
          for (const a of contents.artifacts) {
            yield* artifacts.publish("telegram:-1:5", a.name, a.content, "text/plain");
            for (const { key, value } of a.data)
              yield* artifacts.data.set(a.name, key, JSON.stringify(value));
          }
          return {
            tar: yield* (yield* Backup).tar,
            snapshot: yield* store.snapshot,
            intents: (yield* intents.list).map((intent) => ({ ...intent, id: 0 })),
          };
        }).pipe(Effect.provide(source));

        expect(exported.snapshot.messages).toEqual(contents.messages);

        const target = yield* Layer.build(channel(blobs));
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const backup = yield* Backup;
          yield* backup.restoreTar(exported.tar);
          expect(yield* store.snapshot).toEqual(exported.snapshot);
          expect(yield* (yield* State).settings).toEqual(
            Object.fromEntries(contents.settings.map(({ key, value }) => [key, value])),
          );
          const byName = <A extends { name: string }>(items: ReadonlyArray<A>) =>
            [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          expect(
            (yield* (yield* Skills).list).map(({ name, description, body, pinned }) => ({
              name,
              description,
              body,
              pinned,
            })),
          ).toEqual(byName(contents.skills));
          expect((yield* (yield* Intents).list).map((intent) => ({ ...intent, id: 0 }))).toEqual(
            exported.intents,
          );
          expect(
            exported.intents.map((i) => [i.description, i.triggers, i.maxFires, i.state]),
          ).toEqual(contents.intents.map((i) => [i.description, i.triggers, i.maxFires, "armed"]));
          const distinctPolicies = contents.policies.filter(
            (p, index) =>
              contents.policies.findIndex(
                (q) => q.match === p.match && q.decision === p.decision,
              ) === index,
          );
          expect(
            (yield* (yield* Policies).list).map(({ match, decision }) => ({ match, decision })),
          ).toEqual(distinctPolicies);
          const artifacts = yield* Artifacts;
          expect((yield* artifacts.list).map((a) => a.name)).toEqual(
            byName(contents.artifacts).map((a) => a.name),
          );
          for (const a of contents.artifacts) {
            expect((yield* artifacts.source(a.name)).text).toBe(a.content);
            expect(yield* artifacts.data.list(a.name)).toEqual(
              Object.fromEntries(a.data.map(({ key, value }) => [key, JSON.stringify(value)])),
            );
          }
          expect(Exit.isFailure(yield* Effect.exit(backup.restoreTar(exported.tar)))).toBe(true);
        }).pipe(Effect.provide(target));
      }),
    );
  },
  { runs: 20 },
);

property(
  "a backup is taken the first time a day has passed since the last one, and only the newest fourteen are kept",
  Arbitrary.all({
    start: int(START, START + 365 * DAY),
    gaps: Arbitrary.array(
      int(0, 4).pipe(
        Arbitrary.flatMap((pick) =>
          pick === 4 ? int(0, 3 * DAY) : Arbitrary.Constant([0, 1, DAY - 1, DAY][pick]!),
        ),
      ),
      { maxLength: 24 },
    ),
  }),
  ({ start, gaps }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(channel(Blobs.memory));
        yield* Effect.gen(function* () {
          const backup = yield* Backup;
          const blobs = yield* Blobs;
          let now = start;
          expect(yield* backup.backupIfDue(now)).toBe(false);
          let due = now + DAY;
          const taken: Array<number> = [];
          for (const gap of gaps) {
            now += gap;
            const expected = now >= due;
            expect(yield* backup.backupIfDue(now)).toBe(expected);
            if (expected) {
              taken.push(now);
              due = now + DAY;
            }
          }
          expect(yield* blobs.list("backup/")).toEqual(
            taken.slice(-14).map((at) => `backup/agent:a1/${new Date(at).toISOString()}.tar`),
          );
          expect(yield* backup.nextBackupAt).toBe(due);
        }).pipe(Effect.provide(ctx));
      }),
    ),
  { runs: 30 },
);
