import { ConfigProvider, Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Artifacts } from "../src/artifacts.ts";
import { Blobs } from "../src/blobs.ts";
import { Settings } from "../src/config.ts";
import { Sql, type SqlDriver } from "../src/sql.ts";

const driverOf = (db: DatabaseSync): SqlDriver => ({
  all: <T>(query: string, ...params: unknown[]) =>
    db.prepare(query).all(...(params as never[])) as T[],
});

const tables = (db: DatabaseSync) =>
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all()
    .map((row) => row["name"]);

const recorded = (db: DatabaseSync, name: string) =>
  db
    .prepare(`SELECT step FROM _migrations WHERE name = ? ORDER BY step`)
    .all(name)
    .map((row) => row["step"]);

const migrate = (db: DatabaseSync, name: string, steps: ReadonlyArray<string>) =>
  Effect.runPromise(
    Sql.use((sql) => sql.migrate(name, steps)).pipe(Effect.provide(Sql.layer(driverOf(db)))),
  );

test("a migration's steps run once, and a step added later runs once", async () => {
  const db = new DatabaseSync(":memory:");
  const first = [`CREATE TABLE t (id INTEGER PRIMARY KEY)`, `INSERT INTO t (id) VALUES (1)`];
  await migrate(db, "t", first);
  await migrate(db, "t", first);
  expect(db.prepare(`SELECT COUNT(*) AS n FROM t`).get()?.["n"]).toBe(1);
  expect(recorded(db, "t")).toEqual([0, 1]);

  await migrate(db, "t", [...first, `INSERT INTO t (id) VALUES (2)`]);
  await migrate(db, "t", [...first, `INSERT INTO t (id) VALUES (2)`]);
  expect(
    db
      .prepare(`SELECT id FROM t ORDER BY id`)
      .all()
      .map((r) => r["id"]),
  ).toEqual([1, 2]);
  expect(recorded(db, "t")).toEqual([0, 1, 2]);
  expect(tables(db)).toEqual(["_migrations", "t"]);
});

const settings = Settings.layer.pipe(
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        BOT_TOKEN: "x",
        MIZOOK_WEBHOOK_SECRET: "x",
        DEEPSEEK_API_KEY: "x",
        PUBLIC_URL: "https://t.test",
      }),
    ),
  ),
);

const buildArtifacts = (db: DatabaseSync) =>
  Effect.runPromise(
    Artifacts.use((artifacts) => artifacts.list).pipe(
      Effect.provide(
        Artifacts.layer.pipe(
          Layer.provide(Sql.layer(driverOf(db))),
          Layer.provide(Layer.merge(Blobs.memory, settings)),
        ),
      ),
    ),
  );

const columns = (db: DatabaseSync, table: string) =>
  db
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all(table)
    .map((row) => row["name"]);

test("a database made before migrations were recorded migrates without error", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE app_artifacts (
       name TEXT PRIMARY KEY, token TEXT NOT NULL, version INTEGER NOT NULL,
       content_type TEXT NOT NULL, updated INTEGER NOT NULL)`,
  );
  db.exec(`ALTER TABLE app_artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  db.exec(
    `INSERT INTO app_artifacts (name, token, version, content_type, updated, visibility)
     VALUES ('old', 'tok', 3, 'text/html', 1, 'private')`,
  );

  const listed = await buildArtifacts(db);
  expect(listed.map((a) => [a.name, a.version, a.visibility])).toEqual([["old", 3, "private"]]);
  expect(columns(db, "app_artifacts")).toEqual([
    "name",
    "token",
    "version",
    "content_type",
    "updated",
    "visibility",
  ]);
  expect(recorded(db, "artifacts")).toEqual([0, 1]);

  await buildArtifacts(db);
  expect(recorded(db, "artifacts")).toEqual([0, 1]);
});

test("a database with the old table but no visibility column gains it once", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE app_artifacts (
       name TEXT PRIMARY KEY, token TEXT NOT NULL, version INTEGER NOT NULL,
       content_type TEXT NOT NULL, updated INTEGER NOT NULL)`,
  );
  await buildArtifacts(db);
  await buildArtifacts(db);
  expect(columns(db, "app_artifacts")).toContain("visibility");
  expect(recorded(db, "artifacts")).toEqual([0, 1]);
});
