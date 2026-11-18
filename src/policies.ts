import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export type Decision = "allow" | "ask" | "deny";

export interface Policy {
  readonly id: number;
  /** A substring of the action, lowercased: a tool path such as `gmail.send`. */
  readonly match: string;
  readonly decision: Decision;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  match: Schema.String,
  decision: Schema.Literals(["allow", "ask", "deny"]),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toPolicy = (row: typeof Row.Type): Policy => ({
  id: row.id,
  match: row.match,
  decision: row.decision,
});

/**
 * How much rope an action gets: run it, ask first, or refuse. The agent's executor calls are
 * matched by their tool path; the user can add a rule from an approval card with Always allow.
 */
export class Policies extends Context.Service<
  Policies,
  {
    readonly list: Effect.Effect<ReadonlyArray<Policy>, StateError>;
    add(match: string, decision: Decision): Effect.Effect<Policy, StateError>;
    update(
      id: number,
      match: string,
      decision: Decision,
    ): Effect.Effect<Policy | undefined, StateError>;
    remove(id: number): Effect.Effect<boolean, StateError>;
    /** The strongest decision for an action. Deny beats ask, ask beats allow. */
    decide(target: string): Effect.Effect<Decision | undefined, StateError>;
  }
>()("mizook/Policies") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Policies,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate policies", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_policies (
               id INTEGER PRIMARY KEY AUTOINCREMENT, match TEXT NOT NULL,
               decision TEXT NOT NULL, created INTEGER NOT NULL,
               UNIQUE (match, decision))`,
          ),
        );

        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toPolicy)),
          );

        const list = query(
          "list policies",
          `SELECT id, match, decision FROM app_policies ORDER BY id`,
        );

        return Policies.of({
          list,
          add: (match, decision) =>
            Effect.gen(function* () {
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
          update: (id, match, decision) =>
            query(
              "update policy",
              `UPDATE app_policies SET match = ?, decision = ? WHERE id = ?
               RETURNING id, match, decision`,
              match,
              decision,
              id,
            ).pipe(Effect.map((rows) => rows[0])),
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
