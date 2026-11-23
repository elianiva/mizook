import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import type { StateError } from "./errors.ts";
import { stateSql } from "./sql.ts";

export interface Spend {
  readonly last24h: number;
  readonly last7d: number;
  readonly total: number;
}

const Total = Schema.Struct({ total: Schema.NullOr(Schema.Finite) });

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export class Usage extends Context.Service<
  Usage,
  {
    record(
      kind: "turn" | "memory" | "ask",
      model: string,
      usage: ModelUsage,
    ): Effect.Effect<void, StateError>;
    spentSince(sinceEpochMs: number): Effect.Effect<number, StateError>;
    readonly spend: Effect.Effect<Spend, StateError>;
  }
>()("mizook/Usage") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Usage,
      Effect.gen(function* () {
        const { run, rows } = stateSql(sql);
        yield* run("migrate usage", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_usage (
               at INTEGER NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL,
               input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL,
               cost REAL NOT NULL)`,
          ),
        );
        const spentDollarsSince = (sinceEpochMs: number) =>
          rows(Total)(
            "spent",
            `SELECT SUM(cost) AS total FROM app_usage WHERE at >= ?`,
            sinceEpochMs,
          ).pipe(Effect.map((found) => found[0]?.total ?? 0));
        return Usage.of({
          record: (kind, model, usage) =>
            run("record usage", () =>
              sql.all(
                `INSERT INTO app_usage (at, kind, model, input, output, cache_read, cost)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                Date.now(),
                kind,
                model,
                usage.input,
                usage.output,
                usage.cacheRead,
                usage.cost.total,
              ),
            ).pipe(Effect.asVoid),
          spentSince: spentDollarsSince,
          spend: Effect.gen(function* () {
            const now = Date.now();
            return {
              last24h: yield* spentDollarsSince(now - DAY_MS),
              last7d: yield* spentDollarsSince(now - WEEK_MS),
              total: yield* spentDollarsSince(0),
            };
          }),
        });
      }),
    );
}
