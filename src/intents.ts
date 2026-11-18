import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { StateError } from "./errors.ts";

export const MAX_INTENT_DESCRIPTION = 500;
export const MAX_INTENT_TRIGGERS = 8;
export const MAX_TRIGGER_LENGTH = 64;

export type IntentState = "armed" | "done" | "cancelled" | "expired";

export interface Intent {
  readonly id: number;
  readonly description: string;
  readonly triggers: ReadonlyArray<string>;
  readonly created: number;
  readonly expires: number;
  /** Milliseconds between two fires. */
  readonly cooldown: number;
  readonly maxFires: number;
  readonly fireCount: number;
  readonly lastFired: number | undefined;
  readonly state: IntentState;
}

export interface IntentOptions {
  readonly expiresAt: number;
  readonly cooldownMs: number;
  readonly maxFires: number;
}

const Row = Schema.Struct({
  id: Schema.Finite,
  description: Schema.String,
  triggers: Schema.String,
  created: Schema.Finite,
  expires: Schema.Finite,
  cooldown: Schema.Finite,
  max_fires: Schema.Finite,
  fire_count: Schema.Finite,
  last_fired: Schema.NullOr(Schema.Finite),
  state: Schema.Literals(["armed", "done", "cancelled", "expired"]),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

const toIntent = (row: typeof Row.Type): Intent => {
  let triggers: string[] = [];
  try {
    const parsed = JSON.parse(row.triggers) as unknown;
    if (Array.isArray(parsed)) triggers = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // A broken row has no triggers, so it never fires.
  }
  return {
    id: row.id,
    description: row.description,
    triggers,
    created: row.created,
    expires: row.expires,
    cooldown: row.cooldown,
    maxFires: row.max_fires,
    fireCount: row.fire_count,
    lastFired: row.last_fired ?? undefined,
    state: row.state,
  };
};

const SELECT = `SELECT id, description, triggers, created, expires, cooldown, max_fires, fire_count, last_fired, state FROM app_intents`;

const normalize = (text: string) => text.normalize("NFC").toLowerCase();
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-token match; CJK has no word breaks, so it uses a literal substring. */
export const matchesTrigger = (text: string, trigger: string): boolean => {
  const needle = normalize(trigger).trim();
  if (needle === "") return false;
  if (CJK.test(needle)) return normalize(text).includes(needle);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(needle)}($|[^\\p{L}\\p{N}])`, "u").test(
    normalize(text),
  );
};

/**
 * Prospective memory: an instruction that waits for a future message. Matching is a token scan,
 * not a model call. Defaults are conservative: three fires, a day between them, ninety days.
 */
export class Intents extends Context.Service<
  Intents,
  {
    create(
      description: string,
      triggers: ReadonlyArray<string>,
      options: IntentOptions,
    ): Effect.Effect<Intent, StateError>;
    readonly list: Effect.Effect<ReadonlyArray<Intent>, StateError>;
    /** Change an armed intent's wording, triggers or limits. */
    update(
      id: number,
      input: {
        readonly description: string;
        readonly triggers: ReadonlyArray<string>;
        readonly expires: number;
        readonly cooldown: number;
        readonly maxFires: number;
      },
    ): Effect.Effect<Intent | undefined, StateError>;
    /** Put an exported intent back with its counters and state. */
    restore(input: Omit<Intent, "id">): Effect.Effect<Intent, StateError>;
    cancel(id: number): Effect.Effect<boolean, StateError>;
    /** The intents this text wakes. Increments their counters and advances their state. */
    match(text: string, now: Date): Effect.Effect<ReadonlyArray<Intent>, StateError>;
  }
>()("mizook/Intents") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Intents,
      Effect.gen(function* () {
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });

        yield* run("migrate intents", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_intents (
               id INTEGER PRIMARY KEY AUTOINCREMENT, description TEXT NOT NULL,
               triggers TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
               cooldown INTEGER NOT NULL, max_fires INTEGER NOT NULL,
               fire_count INTEGER NOT NULL DEFAULT 0, last_fired INTEGER,
               state TEXT NOT NULL DEFAULT 'armed')`,
          ),
        );

        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toIntent)),
          );

        const one = (operation: string, text: string, ...params: unknown[]) =>
          query(operation, text, ...params).pipe(Effect.map((rows) => rows[0]));

        return Intents.of({
          create: (description, triggers, options) =>
            Effect.gen(function* () {
              const now = Date.now();
              const made = yield* one(
                "create intent",
                `INSERT INTO app_intents
                   (description, triggers, created, expires, cooldown, max_fires)
                 VALUES (?, ?, ?, ?, ?, ?)
                 RETURNING id, description, triggers, created, expires, cooldown,
                   max_fires, fire_count, last_fired, state`,
                description,
                JSON.stringify(triggers),
                now,
                options.expiresAt,
                options.cooldownMs,
                options.maxFires,
              );
              return made!;
            }),
          list: query("list intents", `${SELECT} ORDER BY id`),
          update: (id, input) =>
            one(
              "update intent",
              `UPDATE app_intents
               SET description = ?, triggers = ?, expires = ?, cooldown = ?, max_fires = ?,
                   state = CASE
                     WHEN state = 'cancelled' THEN 'cancelled'
                     WHEN fire_count >= ? THEN 'done'
                     WHEN ? < ? THEN 'expired'
                     ELSE 'armed'
                   END
               WHERE id = ?
               RETURNING id, description, triggers, created, expires, cooldown,
                 max_fires, fire_count, last_fired, state`,
              input.description,
              JSON.stringify(input.triggers),
              input.expires,
              input.cooldown,
              input.maxFires,
              input.maxFires,
              input.expires,
              Date.now(),
              id,
            ),
          restore: (input) =>
            one(
              "restore intent",
              `INSERT INTO app_intents
                 (description, triggers, created, expires, cooldown, max_fires,
                  fire_count, last_fired, state)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
               RETURNING id, description, triggers, created, expires, cooldown,
                 max_fires, fire_count, last_fired, state`,
              input.description,
              JSON.stringify(input.triggers),
              input.created,
              input.expires,
              input.cooldown,
              input.maxFires,
              input.fireCount,
              input.lastFired ?? null,
              input.state,
            ).pipe(
              Effect.filterOrFail(
                (found): found is Intent => found !== undefined,
                () => new StateError({ operation: "restore intent", cause: "no row" }),
              ),
            ),
          cancel: (id) =>
            run("cancel intent", () =>
              sql.all(
                `UPDATE app_intents SET state = 'cancelled'
                 WHERE id = ? AND state = 'armed' RETURNING id`,
                id,
              ),
            ).pipe(Effect.map((rows) => rows.length > 0)),
          match: (text, now) =>
            Effect.gen(function* () {
              const at = now.getTime();
              // Expire overdue intents once, so the scan stays small and the list tells the truth.
              yield* run("expire intents", () =>
                sql.all(
                  `UPDATE app_intents SET state = 'expired'
                   WHERE state = 'armed' AND expires < ?`,
                  at,
                ),
              );
              const armed = yield* query(
                "armed intents",
                `${SELECT} WHERE state = 'armed' ORDER BY id`,
              );
              const fired: Intent[] = [];
              for (const intent of armed) {
                if (intent.lastFired !== undefined && at - intent.lastFired < intent.cooldown) {
                  continue;
                }
                if (!intent.triggers.every((trigger) => matchesTrigger(text, trigger))) continue;
                const fireCount = intent.fireCount + 1;
                const state: IntentState = fireCount >= intent.maxFires ? "done" : "armed";
                yield* run("fire intent", () =>
                  sql.all(
                    `UPDATE app_intents SET fire_count = ?, last_fired = ?, state = ? WHERE id = ?`,
                    fireCount,
                    at,
                    state,
                    intent.id,
                  ),
                );
                fired.push({ ...intent, fireCount, lastFired: at, state });
              }
              return fired;
            }),
        });
      }),
    );
}
