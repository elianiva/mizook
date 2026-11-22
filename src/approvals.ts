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
  /** When it was asked. */
  readonly created: number;
  /** Where the turn that asked was talking: the card goes there. */
  readonly place: string;
  /** A change of ours to carry out once approved, as JSON. Empty: an Executor call to resume. */
  readonly action: string;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  execution_id: Schema.String,
  summary: Schema.String,
  match: Schema.String,
  created: Schema.Finite,
  place: Schema.String,
  action: Schema.String,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toApproval = (r: typeof Row.Type): Approval => ({
  id: r.id,
  executionId: r.execution_id,
  summary: r.summary,
  match: r.match,
  created: r.created,
  place: r.place,
  action: r.action,
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
    add(
      executionId: string,
      summary: string,
      match: string,
      place: string,
      action?: string,
    ): Effect.Effect<Approval, StateError>;
    /** Approvals of a place not yet shown to the user. */
    unposted(place: string): Effect.Effect<ReadonlyArray<Approval>, StateError>;
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
               summary TEXT NOT NULL, posted INTEGER NOT NULL DEFAULT 0,
               match TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL,
               place TEXT NOT NULL DEFAULT '', action TEXT NOT NULL DEFAULT '')`,
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
          add: (executionId, summary, match, place, action) =>
            query(
              "add approval",
              `INSERT INTO app_approvals (execution_id, summary, match, created, place, action)
               VALUES (?, ?, ?, ?, ?, ?)
               RETURNING id, execution_id, summary, match, created, place, action`,
              executionId,
              summary,
              match,
              Date.now(),
              place,
              action ?? "",
            ).pipe(Effect.map((rows) => rows[0]!)),
          unposted: (place) =>
            Effect.suspend(() =>
              query(
                "unposted approvals",
                `SELECT id, execution_id, summary, match, created, place, action FROM app_approvals
                 WHERE posted = 0 AND place = ? AND created > ? ORDER BY id`,
                place,
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
              `DELETE FROM app_approvals WHERE id = ?
               RETURNING id, execution_id, summary, match, created, place, action`,
              id,
            ).pipe(
              Effect.map((rows) => {
                const found = rows[0];
                if (!found) return undefined;
                return found.created < Date.now() - APPROVAL_TTL_MS ? undefined : found;
              }),
            ),
        });
      }),
    );
}
