import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export interface Approval {
  /** Short and local: it goes in a button, and Telegram allows 64 bytes there. */
  readonly id: number;
  /** Executor's id of the paused execution. */
  readonly executionId: string;
  readonly summary: string;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  execution_id: Schema.String,
  summary: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toApproval = (r: typeof Row.Type): Approval => ({
  id: r.id,
  executionId: r.execution_id,
  summary: r.summary,
});

/**
 * What Executor paused for: kept until the user presses Approve or Deny, so a restart does not
 * lose the question. The tool writes it; the bot posts it as buttons and answers it.
 */
export class Approvals extends Context.Service<
  Approvals,
  {
    add(executionId: string, summary: string): Effect.Effect<Approval, StateError>;
    /** Approvals not yet shown to the user. */
    readonly unposted: Effect.Effect<ReadonlyArray<Approval>, StateError>;
    markPosted(id: number): Effect.Effect<void, StateError>;
    /** Remove and return an approval: a button press answers it once. */
    take(id: number): Effect.Effect<Approval | undefined, StateError>;
  }
>()("mizook/Approvals") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Approvals,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });
        yield* run("migrate approvals", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_approvals (
               id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL,
               summary TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0)`,
          ),
        );
        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toApproval)),
          );
        return Approvals.of({
          add: (executionId, summary) =>
            query(
              "add approval",
              `INSERT INTO app_approvals (execution_id, summary) VALUES (?, ?)
               RETURNING id, execution_id, summary`,
              executionId,
              summary,
            ).pipe(Effect.map((rows) => rows[0]!)),
          unposted: query(
            "unposted approvals",
            `SELECT id, execution_id, summary FROM app_approvals WHERE posted = 0 ORDER BY id`,
          ),
          markPosted: (id) =>
            run("mark approval posted", () =>
              sql.all(`UPDATE app_approvals SET posted = 1 WHERE id = ?`, id),
            ).pipe(Effect.asVoid),
          take: (id) =>
            query(
              "take approval",
              `DELETE FROM app_approvals WHERE id = ? RETURNING id, execution_id, summary`,
              id,
            ).pipe(Effect.map((rows) => rows[0])),
        });
      }),
    );
}
