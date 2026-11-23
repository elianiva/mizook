import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { StateError } from "./errors.ts";
import { IntentEvents, IntentState, stepIntent } from "./intent-lifecycle.ts";
import { stateSql } from "./sql.ts";

export type { IntentState };

export const MAX_INTENT_DESCRIPTION = 500;
export const MAX_INTENT_TRIGGERS = 8;
export const MAX_TRIGGER_LENGTH = 64;

type MillisecondsBetweenFires = number;

export interface Intent {
  readonly id: number;
  readonly description: string;
  readonly triggers: ReadonlyArray<string>;
  readonly created: number;
  readonly expires: number;
  readonly cooldown: MillisecondsBetweenFires;
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
  state: IntentState,
});

const decodeTriggers = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const parseTriggersOrNone = (json: string): ReadonlyArray<string> =>
  Option.getOrElse(decodeTriggers(json), () => []);

const allTriggersMentioned = (text: string, triggers: ReadonlyArray<string>) =>
  triggers.length > 0 && triggers.every((trigger) => matchesTrigger(text, trigger));

const toIntent = (row: typeof Row.Type): Intent => ({
  id: row.id,
  description: row.description,
  triggers: parseTriggersOrNone(row.triggers),
  created: row.created,
  expires: row.expires,
  cooldown: row.cooldown,
  maxFires: row.max_fires,
  fireCount: row.fire_count,
  lastFired: row.last_fired ?? undefined,
  state: row.state,
});

const SELECT = `SELECT id, description, triggers, created, expires, cooldown, max_fires, fire_count, last_fired, state FROM app_intents`;

const normalize = (text: string) => text.normalize("NFC").toLowerCase();
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const matchesTrigger = (text: string, trigger: string): boolean => {
  const needle = normalize(trigger).trim();
  if (needle === "") return false;
  if (CJK.test(needle)) return normalize(text).includes(needle);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(needle)}($|[^\\p{L}\\p{N}])`, "u").test(
    normalize(text),
  );
};

export class Intents extends Context.Service<
  Intents,
  {
    create(
      description: string,
      triggers: ReadonlyArray<string>,
      options: IntentOptions,
    ): Effect.Effect<Intent, StateError>;
    readonly list: Effect.Effect<ReadonlyArray<Intent>, StateError>;
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
    restore(input: Omit<Intent, "id">): Effect.Effect<Intent, StateError>;
    cancel(id: number): Effect.Effect<boolean, StateError>;
    match(text: string, now: Date): Effect.Effect<ReadonlyArray<Intent>, StateError>;
  }
>()("mizook/Intents") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Intents,
      Effect.gen(function* () {
        const { run, rows } = stateSql(sql);

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

        const selectRows = rows(Row);
        const query = (operation: string, text: string, ...params: unknown[]) =>
          selectRows(operation, text, ...params).pipe(Effect.map((found) => found.map(toIntent)));

        const one = (operation: string, text: string, ...params: unknown[]) =>
          query(operation, text, ...params).pipe(Effect.map((rows) => rows[0]));

        const setState = (id: number, state: IntentState) =>
          run("set intent state", () =>
            sql.all(`UPDATE app_intents SET state = ? WHERE id = ?`, state, id),
          );

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
            Effect.gen(function* () {
              const current = yield* one("intent", `${SELECT} WHERE id = ?`, id);
              if (!current) return undefined;
              const state = yield* stepIntent(
                current.state,
                IntentEvents.Edit({
                  fireCount: current.fireCount,
                  maxFires: input.maxFires,
                  isPastExpiry: input.expires < Date.now(),
                }),
              );
              return yield* one(
                "update intent",
                `UPDATE app_intents
                 SET description = ?, triggers = ?, expires = ?, cooldown = ?, max_fires = ?, state = ?
                 WHERE id = ?
                 RETURNING id, description, triggers, created, expires, cooldown,
                   max_fires, fire_count, last_fired, state`,
                input.description,
                JSON.stringify(input.triggers),
                input.expires,
                input.cooldown,
                input.maxFires,
                state ?? current.state,
                id,
              );
            }),
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
            Effect.gen(function* () {
              const current = yield* one("intent", `${SELECT} WHERE id = ?`, id);
              const state = current && (yield* stepIntent(current.state, IntentEvents.Cancel()));
              if (!state) return false;
              yield* setState(id, state);
              return true;
            }),
          match: (text, now) =>
            Effect.gen(function* () {
              const at = now.getTime();
              const armed = yield* query(
                "armed intents",
                `${SELECT} WHERE state = 'armed' ORDER BY id`,
              );
              const fired: Intent[] = [];
              for (const intent of armed) {
                if (intent.expires < at) {
                  const expired = yield* stepIntent(intent.state, IntentEvents.Expire());
                  if (expired) yield* setState(intent.id, expired);
                  continue;
                }
                if (intent.lastFired !== undefined && at - intent.lastFired < intent.cooldown) {
                  continue;
                }
                if (!allTriggersMentioned(text, intent.triggers)) continue;
                const fireCount = intent.fireCount + 1;
                const state = yield* stepIntent(
                  intent.state,
                  IntentEvents.Fire({ fireCount, maxFires: intent.maxFires }),
                );
                if (!state) continue;
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
