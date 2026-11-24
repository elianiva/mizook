import { Context, Effect, Layer, Schema } from "effect";
import { InvalidInput, StateError } from "./errors.ts";
import { Sql } from "./sql.ts";

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_DESCRIPTION = 200;
const MAX_SKILL_BODY = 24_000;

const refuse = (reason: string) => Effect.fail(new InvalidInput({ reason }));

/** A skill's name, description and body, trimmed, or the reason they cannot be saved. */
const checkSkill = (name: string, description: string, body: string) => {
  const [n, d, b] = [name.trim(), description.trim(), body.trim()];
  if (n === "") return refuse("Give the skill a name.");
  if (!SKILL_NAME.test(n))
    return refuse("Use lowercase letters, digits and dashes for the name, up to 64 characters.");
  if (d === "") return refuse("Describe when to use the skill.");
  if (d.length > MAX_SKILL_DESCRIPTION)
    return refuse(`Keep the description under ${MAX_SKILL_DESCRIPTION} characters.`);
  if (b === "") return refuse("Write the skill's steps.");
  if (b.length > MAX_SKILL_BODY) return refuse(`Keep the body under ${MAX_SKILL_BODY} characters.`);
  return Effect.succeed({ name: n, description: d, body: b });
};

export const pinnedRefusal = (name: string) =>
  `"${name}" is pinned by an automation; cancel the automation first.`;

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

export class Skills extends Context.Service<
  Skills,
  {
    readonly list: Effect.Effect<ReadonlyArray<Skill>, StateError>;
    get(name: string): Effect.Effect<Skill | undefined, StateError>;
    /** Saves a skill, trimmed. Refuses a bad name, a blank or overlong description or body. */
    save(
      name: string,
      description: string,
      body: string,
    ): Effect.Effect<Skill, StateError | InvalidInput>;
    /** Deletes a skill; false when there is none. Refuses a skill an automation pins. */
    remove(name: string): Effect.Effect<boolean, StateError | InvalidInput>;
    touch(name: string): Effect.Effect<void, StateError>;
    pin(name: string): Effect.Effect<void, StateError>;
    setPinned(name: string, pinned: boolean): Effect.Effect<void, StateError>;
    readonly index: Effect.Effect<ReadonlyArray<{ name: string; description: string }>, StateError>;
  }
>()("mizook/Skills") {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const sql = yield* Sql;
      yield* sql.migrate("skills", [
        `CREATE TABLE IF NOT EXISTS app_skills (
             name TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT NOT NULL,
             created INTEGER NOT NULL, updated INTEGER NOT NULL,
             used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
             pinned INTEGER NOT NULL DEFAULT 0)`,
      ]);

      const selectRows = sql.rows(Row);
      const query = (operation: string, text: string, ...params: unknown[]) =>
        selectRows(operation, text, ...params).pipe(Effect.map((found) => found.map(toSkill)));

      const one = (operation: string, name: string) =>
        query(operation, `${SELECT} WHERE name = ?`, name).pipe(Effect.map((rows) => rows[0]));

      return Skills.of({
        list: query("list skills", `${SELECT} ORDER BY name`),
        get: (name) => one("get skill", name),
        save: (name, description, body) =>
          Effect.gen(function* () {
            const skill = yield* checkSkill(name, description, body);
            const now = Date.now();
            const rows = yield* query(
              "save skill",
              `INSERT INTO app_skills (name, description, body, created, updated)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (name) DO UPDATE SET
                   description = excluded.description, body = excluded.body,
                   updated = excluded.updated
                 RETURNING name, description, body, created, updated, used_at, use_count, pinned`,
              skill.name,
              skill.description,
              skill.body,
              now,
              now,
            );
            return rows[0]!;
          }),
        remove: (name) =>
          Effect.gen(function* () {
            const found = yield* one("find skill", name);
            if (!found) return false;
            if (found.pinned) return yield* refuse(pinnedRefusal(name));
            const gone = yield* sql.exec(
              "remove skill",
              `DELETE FROM app_skills WHERE name = ? RETURNING name`,
              name,
            );
            return gone.length > 0;
          }),
        touch: (name) =>
          sql
            .exec(
              "touch skill",
              `UPDATE app_skills SET used_at = ?, use_count = use_count + 1 WHERE name = ?`,
              Date.now(),
              name,
            )
            .pipe(Effect.asVoid),
        pin: (name) =>
          sql
            .exec("pin skill", `UPDATE app_skills SET pinned = 1 WHERE name = ?`, name)
            .pipe(Effect.asVoid),
        setPinned: (name, pinned) =>
          sql
            .exec(
              "pin skill",
              `UPDATE app_skills SET pinned = ? WHERE name = ?`,
              pinned ? 1 : 0,
              name,
            )
            .pipe(Effect.asVoid),
        index: sql.exec<{ name: string; description: string }>(
          "skill index",
          `SELECT name, description FROM app_skills ORDER BY name`,
        ),
      });
    }),
  );
}
