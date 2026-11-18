import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_SKILL_DESCRIPTION = 200;
export const MAX_SKILL_BODY = 24_000;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly created: number;
  readonly updated: number;
  readonly usedAt: number | undefined;
  readonly useCount: number;
  readonly pinned: boolean;
}

const Row = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  body: Schema.String,
  created: Schema.Finite,
  updated: Schema.Finite,
  used_at: Schema.NullOr(Schema.Finite),
  use_count: Schema.Finite,
  pinned: Schema.Finite,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toSkill = (row: typeof Row.Type): Skill => ({
  name: row.name,
  description: row.description,
  body: row.body,
  created: row.created,
  updated: row.updated,
  usedAt: row.used_at ?? undefined,
  useCount: row.use_count,
  pinned: row.pinned === 1,
});

const SELECT = `SELECT name, description, body, created, updated, used_at, use_count, pinned FROM app_skills`;

/**
 * What the agent knows how to do, kept as procedures rather than conversation. A skill is read on
 * demand, so its body never sits in the prompt unless a task needs it.
 */
export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<Skill>, StateError>;
    get(name: string): Effect.Effect<Skill | undefined, StateError>;
    save(name: string, description: string, body: string): Effect.Effect<Skill, StateError>;
    remove(name: string): Effect.Effect<boolean, StateError>;
    /** Count a read, so a later curator can see what is used. */
    touch(name: string): Effect.Effect<void, StateError>;
    /** Keep a skill a schedule depends on. */
    pin(name: string): Effect.Effect<void, StateError>;
    /** Set whether a skill stays at hand, from the dashboard or a schedule. */
    setPinned(name: string, pinned: boolean): Effect.Effect<void, StateError>;
    /** The names and descriptions a turn can see, cheapest form of progressive disclosure. */
    readonly index: Effect.Effect<ReadonlyArray<{ name: string; description: string }>, StateError>;
  }
>()("mizook/Skills") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Skills,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate skills", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_skills (
               name TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL,
               created INTEGER NOT NULL, updated INTEGER NOT NULL,
               used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
               pinned INTEGER NOT NULL DEFAULT 0)`,
          ),
        );

        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toSkill)),
          );

        const one = (operation: string, name: string) =>
          query(operation, `${SELECT} WHERE name = ?`, name).pipe(Effect.map((rows) => rows[0]));

        return Skills.of({
          list: query("list skills", `${SELECT} ORDER BY name`),
          get: (name) => one("get skill", name),
          save: (name, description, body) =>
            Effect.gen(function* () {
              const now = Date.now();
              const rows = yield* query(
                "save skill",
                `INSERT INTO app_skills (name, description, body, created, updated)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET
                   description = excluded.description, body = excluded.body,
                   updated = excluded.updated
                 RETURNING name, description, body, created, updated, used_at, use_count, pinned`,
                name,
                description,
                body,
                now,
                now,
              );
              return rows[0]!;
            }),
          remove: (name) =>
            run("remove skill", () =>
              sql.all(`DELETE FROM app_skills WHERE name = ? RETURNING name`, name),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          touch: (name) =>
            run("touch skill", () =>
              sql.all(
                `UPDATE app_skills SET used_at = ?, use_count = use_count + 1 WHERE name = ?`,
                Date.now(),
                name,
              ),
            ).pipe(Effect.asVoid),
          pin: (name) =>
            run("pin skill", () =>
              sql.all(`UPDATE app_skills SET pinned = 1 WHERE name = ?`, name),
            ).pipe(Effect.asVoid),
          setPinned: (name, pinned) =>
            run("pin skill", () =>
              sql.all(`UPDATE app_skills SET pinned = ? WHERE name = ?`, pinned ? 1 : 0, name),
            ).pipe(Effect.asVoid),
          index: run("skill index", () =>
            sql.all<{ name: string; description: string }>(
              `SELECT name, description FROM app_skills ORDER BY name`,
            ),
          ),
        });
      }),
    );
}
