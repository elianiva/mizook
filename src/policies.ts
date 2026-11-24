import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { InvalidInput, StateError } from "./errors.ts";
import { stateSql } from "./sql.ts";

export type Decision = "allow" | "ask" | "deny";

export interface Policy {
  readonly id: number;
  readonly match: string;
  readonly decision: Decision;
}

const MAX_MATCH = 200;

const refuse = (reason: string) => Effect.fail(new InvalidInput({ reason }));

/** A policy's match, trimmed and lowercased, or the reason it cannot be saved. */
const checkMatch = (match: string) => {
  const normal = match.trim().toLowerCase();
  if (normal === "") return refuse("Give the policy something to match.");
  if (normal.length > MAX_MATCH) return refuse(`Keep the match under ${MAX_MATCH} characters.`);
  return Effect.succeed(normal);
};

/** One line per policy, as `/policies` and the policy tool list them. */
export const describePolicy = (policy: Policy): string =>
  `#${policy.id} ${policy.decision} ${policy.match}`;

const Row = Schema.Struct({
  id: Schema.Finite,
  match: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
});

const toPolicy = (row: typeof Row.Type): Policy => ({
  id: row.id,
  match: row.match,
  decision: row.decision,
});

export class Policies extends Context.Service<
  Policies,
  {
    readonly list: Effect.Effect<ReadonlyArray<Policy>, StateError>;
    /** Adds a rule, its match trimmed and lowercased; adding one that exists returns it. */
    add(match: string, decision: Decision): Effect.Effect<Policy, StateError | InvalidInput>;
    /** Changes a rule; undefined when there is none. Refuses to duplicate another rule. */
    update(
      id: number,
      match: string,
      decision: Decision,
    ): Effect.Effect<Policy | undefined, StateError | InvalidInput>;
    remove(id: number): Effect.Effect<boolean, StateError>;
    decide(target: string): Effect.Effect<Decision | undefined, StateError>;
  }
>()("mizook/Policies") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Policies,
      Effect.gen(function* () {
        const { run, rows } = stateSql(sql);

        yield* run("migrate policies", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_policies (
               id INTEGER PRIMARY KEY AUTOINCREMENT, match TEXT NOT NULL,
               decision TEXT NOT NULL, created INTEGER NOT NULL,
               UNIQUE (match, decision))`,
          ),
        );

        const selectRows = rows(Row);
        const query = (operation: string, text: string, ...params: unknown[]) =>
          selectRows(operation, text, ...params).pipe(Effect.map((found) => found.map(toPolicy)));

        const list = query(
          "list policies",
          `SELECT id, match, decision FROM app_policies ORDER BY id`,
        );

        return Policies.of({
          list,
          add: (raw, decision) =>
            Effect.gen(function* () {
              const match = yield* checkMatch(raw);
              yield* run("add policy", () =>
                sql.all(
                  `INSERT OR IGNORE INTO app_policies (match, decision, created) VALUES (?, ?, ?)`,
                  match,
                  decision,
                  Date.now(),
                ),
              );
              const rows = yield* query(
                "read added policy",
                `SELECT id, match, decision FROM app_policies WHERE match = ? AND decision = ?`,
                match,
                decision,
              );
              return rows[0]!;
            }),
          update: (id, raw, decision) =>
            Effect.gen(function* () {
              const match = yield* checkMatch(raw);
              const all = yield* list;
              if (!all.some((policy) => policy.id === id)) return undefined;
              if (all.some((p) => p.id !== id && p.match === match && p.decision === decision))
                return yield* refuse("That rule already exists.");
              const rows = yield* query(
                "update policy",
                `UPDATE app_policies SET match = ?, decision = ? WHERE id = ?
                 RETURNING id, match, decision`,
                match,
                decision,
                id,
              );
              return rows[0];
            }),
          remove: (id) =>
            run("remove policy", () =>
              sql.all(`DELETE FROM app_policies WHERE id = ? RETURNING id`, id),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          decide: (target) =>
            Effect.gen(function* () {
              const needle = target.toLowerCase();
              const all = yield* list;
              const hits = all.filter(
                (policy) => policy.match !== "" && needle.includes(policy.match),
              );
              if (hits.some((policy) => policy.decision === "deny")) return "deny";
              if (hits.some((policy) => policy.decision === "ask")) return "ask";
              if (hits.some((policy) => policy.decision === "allow")) return "allow";
              return undefined;
            }),
        });
      }),
    );
}
