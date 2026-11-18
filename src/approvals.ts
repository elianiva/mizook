import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export interface Approval {
  /** Short and local: it goes in a button, and Telegram allows 64 bytes there. */
  readonly id: number;
  /** Executor's id of the paused execution. */
  readonly executionId: string;
  readonly summary: string;
  /** The action a policy would match, so Always allow can save it. Empty when unknown. */
  readonly match: string;
  /** When it was asked; zero for rows written before this column existed. */
  readonly created: number;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  execution_id: Schema.String,
  summary: Schema.String,
  match: Schema.String,
  created: Schema.Finite,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toApproval = (r: typeof Row.Type): Approval => ({
  id: r.id,
  executionId: r.execution_id,
  summary: r.summary,
  match: r.match,
  created: r.created,
});

/** An approval nobody answered in this long is stale: the turn that asked is long over. */
export const APPROVAL_TTL_MS = 30 * 60_000;

/**
 * What Executor paused for: kept until the user presses Approve or Deny, so a restart does not
 * lose the question. The tool writes it; the bot posts it as buttons and answers it.
 */
export class Approvals extends Context.Service<
  Approvals,
  {
    add(executionId: string, summary: string, match?: string): Effect.Effect<Approval, StateError>;
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
        yield* run("migrate approvals", async () => {
          await sql.all(
            `CREATE TABLE IF NOT EXISTS app_approvals (
               id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL,
               summary TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0,
               match TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0)`,
          );
          const columns = await sql.all<{ name: string }>(`PRAGMA table_info(app_approvals)`);
          if (!columns.some((column) => column.name === "match")) {
            await sql.all(`ALTER TABLE app_approvals ADD COLUMN match TEXT NOT NULL DEFAULT ''`);
          }
          if (!columns.some((column) => column.name === "created")) {
            await sql.all(
              `ALTER TABLE app_approvals ADD COLUMN created INTEGER NOT NULL DEFAULT 0`,
            );
          }
        });
        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toApproval)),
          );
        return Approvals.of({
          add: (executionId, summary, match) =>
            query(
              "add approval",
              `INSERT INTO app_approvals (execution_id, summary, match, created) VALUES (?, ?, ?, ?)
               RETURNING id, execution_id, summary, match, created`,
              executionId,
              summary,
              match ?? "",
              Date.now(),
            ).pipe(Effect.map((rows) => rows[0]!)),
          unposted: Effect.suspend(() =>
            query(
              "unposted approvals",
              `SELECT id, execution_id, summary, match, created FROM app_approvals
               WHERE posted = 0 AND (created = 0 OR created > ?) ORDER BY id`,
              Date.now() - APPROVAL_TTL_MS,
            ),
          ),
          markPosted: (id) =>
            run("mark approval posted", () =>
              sql.all(`UPDATE app_approvals SET posted = 1 WHERE id = ?`, id),
            ).pipe(Effect.asVoid),
          take: (id) =>
            query(
              "take approval",
              `DELETE FROM app_approvals WHERE id = ? RETURNING id, execution_id, summary, match, created`,
              id,
            ).pipe(
              Effect.map((rows) => {
                const found = rows[0];
                if (!found) return undefined;
                return found.created > 0 && found.created < Date.now() - APPROVAL_TTL_MS
                  ? undefined
                  : found;
              }),
            ),
        });
      }),
    );
}
