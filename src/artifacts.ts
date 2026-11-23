import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Blobs } from "./blobs.ts";
import { Settings } from "./config.ts";
import { checkContent } from "./artifact-render.ts";
import {
  DATA_KEY,
  dataKey,
  dataPrefix,
  doNameOf,
  MAX_KEYS,
  MAX_VALUE_BYTES,
} from "./artifact-data.ts";
import { StateError, ToolError, type BlobError } from "./errors.ts";
import { stateSql } from "./sql.ts";

export const MAX_ARTIFACT_BYTES = 5_000_000;

const Name = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,60}$/));
const decodeName = Schema.decodeUnknownEffect(Name);

const Row = Schema.Struct({
  name: Schema.String,
  token: Schema.String,
  version: Schema.Finite,
  content_type: Schema.String,
  updated: Schema.Finite,
  visibility: Schema.Literals(["public", "private"]),
});

export type Visibility = "public" | "private";

export interface Artifact {
  readonly name: string;
  readonly token: string;
  readonly version: number;
  readonly contentType: string;
  readonly updated: number;
  readonly visibility: Visibility;
  readonly url: string;
}

const TOKEN_RANDOM_BYTES = 18;
const HOUR_MS = 3_600_000;

const latestPublicCopyKey = (token: string) => `a/${token}`;
const versionHistoryPrefix = (channel: string, name: string) => `artifacts/${channel}/${name}/`;
const versionCopyKey = (channel: string, name: string, version: number) =>
  `${versionHistoryPrefix(channel, name)}${version}`;

const unguessableToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_RANDOM_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

export class Artifacts extends Context.Service<
  Artifacts,
  {
    publish(
      channel: string,
      name: string,
      content: string,
      contentType: string,
      options?: { readonly expiresInHours?: number },
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    publishBytes(
      channel: string,
      name: string,
      body: Uint8Array,
      contentType: string,
      options?: { readonly expiresInHours?: number },
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    readonly list: Effect.Effect<ReadonlyArray<Artifact>, StateError>;
    source(
      name: string,
    ): Effect.Effect<
      { readonly artifact: Artifact; readonly text: string; readonly size: number },
      ToolError | StateError | BlobError
    >;
    setVisibility(
      name: string,
      visibility: Visibility,
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    remove(channel: string, name: string): Effect.Effect<boolean, StateError | BlobError>;
    history(
      channel: string,
      name: string,
    ): Effect.Effect<ReadonlyArray<number>, StateError | BlobError>;
    restore(
      channel: string,
      name: string,
      version: number,
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    readonly data: {
      list(name: string): Effect.Effect<Record<string, string>, ToolError | StateError | BlobError>;
      get(
        name: string,
        key: string,
      ): Effect.Effect<string | undefined, ToolError | StateError | BlobError>;
      set(
        name: string,
        key: string,
        json: string,
      ): Effect.Effect<void, ToolError | StateError | BlobError>;
      delete(name: string, key: string): Effect.Effect<void, ToolError | StateError | BlobError>;
    };
    readonly contents: Effect.Effect<
      ReadonlyArray<{
        readonly artifact: Artifact;
        readonly body: Uint8Array;
        readonly data: Record<string, string>;
      }>,
      ToolError | StateError | BlobError
    >;
  }
>()("mizook/Artifacts") {
  static readonly layer = (sql: SqlDriver) =>
    Layer.effect(
      Artifacts,
      Effect.gen(function* () {
        const blobs = yield* Blobs;
        const { publicUrl } = yield* Settings;
        const { run, rows } = stateSql(sql);
        yield* run("migrate artifacts", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_artifacts (
               name TEXT PRIMARY KEY, token TEXT NOT NULL, version INTEGER NOT NULL,
               content_type TEXT NOT NULL, updated INTEGER NOT NULL)`,
          ),
        );
        const addVisibilityColumn = run("migrate artifact visibility", () =>
          sql.all(`ALTER TABLE app_artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`),
        );
        yield* addVisibilityColumn.pipe(Effect.ignore);
        const toArtifact = (row: typeof Row.Type): Artifact => ({
          name: row.name,
          token: row.token,
          version: row.version,
          contentType: row.content_type,
          updated: row.updated,
          visibility: row.visibility,
          url: `${publicUrl}/a/${row.token}/${row.name}`,
        });
        const selectRows = rows(Row);
        const query = (operation: string, text: string, ...params: unknown[]) =>
          selectRows(operation, text, ...params).pipe(Effect.map((found) => found.map(toArtifact)));
        const all = query("list artifacts", `SELECT * FROM app_artifacts ORDER BY name`);

        const find = (name: string) =>
          Effect.flatMap(
            query("find artifact", `SELECT * FROM app_artifacts WHERE name = ?`, name),
            ([found]) =>
              found
                ? Effect.succeed(found)
                : Effect.fail(new ToolError({ reason: `no artifact ${name}` })),
          );

        const validName = (name: string) =>
          decodeName(name).pipe(
            Effect.mapError(
              () =>
                new ToolError({
                  reason: `bad name "${name}": use lowercase letters, digits, dots, dashes, at most 61 characters`,
                }),
            ),
          );

        const storeVersion = (
          channel: string,
          name: string,
          body: Uint8Array,
          contentType: string,
          options: { readonly expiresInHours?: number } | undefined,
        ) =>
          Effect.gen(function* () {
            if (body.length > MAX_ARTIFACT_BYTES) {
              return yield* new ToolError({ reason: `too large: ${body.length} bytes` });
            }
            const [current] = yield* query(
              "find artifact",
              `SELECT * FROM app_artifacts WHERE name = ?`,
              name,
            );
            const version = (current?.version ?? 0) + 1;
            const tok = current?.token ?? unguessableToken();
            yield* blobs.put(versionCopyKey(channel, name, version), body, { contentType });
            yield* blobs.put(latestPublicCopyKey(tok), body, {
              contentType,
              meta: {
                name,
                do: doNameOf(channel),
                visibility: current?.visibility ?? "public",
                ...(options?.expiresInHours
                  ? { expires: String(Date.now() + options.expiresInHours * HOUR_MS) }
                  : {}),
              },
            });
            const [saved] = yield* query(
              "save artifact",
              `INSERT INTO app_artifacts (name, token, version, content_type, updated)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (name) DO UPDATE SET version = excluded.version,
                 content_type = excluded.content_type, updated = excluded.updated
               RETURNING *`,
              name,
              tok,
              version,
              contentType,
              Date.now(),
            );
            return saved!;
          });

        const self: Context.Service.Shape<typeof Artifacts> = Artifacts.of({
          publish: (channel, name, content, contentType, options) =>
            Effect.gen(function* () {
              yield* validName(name);
              const invalid = checkContent(contentType, content);
              if (invalid) return yield* new ToolError({ reason: invalid });
              return yield* storeVersion(
                channel,
                name,
                new TextEncoder().encode(content),
                contentType,
                options,
              );
            }),
          publishBytes: (channel, name, body, contentType, options) =>
            Effect.gen(function* () {
              yield* validName(name);
              if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
                return yield* new ToolError({ reason: `unsupported binary type ${contentType}` });
              }
              return yield* storeVersion(channel, name, body, contentType, options);
            }),
          list: all,
          source: (name) =>
            Effect.gen(function* () {
              const artifact = yield* find(name);
              const blob = yield* blobs.get(latestPublicCopyKey(artifact.token));
              if (!blob) return yield* new ToolError({ reason: `no artifact ${name}` });
              return {
                artifact,
                text: new TextDecoder().decode(blob.body),
                size: blob.body.length,
              };
            }),
          setVisibility: (name, visibility) =>
            Effect.gen(function* () {
              const found = yield* find(name);
              const blob = yield* blobs.get(latestPublicCopyKey(found.token));
              if (!blob) return yield* new ToolError({ reason: `no artifact ${name}` });
              yield* blobs.put(latestPublicCopyKey(found.token), blob.body, {
                contentType: blob.contentType,
                meta: { ...blob.meta, visibility },
              });
              const [saved] = yield* query(
                "save artifact",
                `UPDATE app_artifacts SET visibility = ? WHERE name = ? RETURNING *`,
                visibility,
                name,
              );
              return saved!;
            }),
          remove: (_channel, name) =>
            Effect.gen(function* () {
              const [found] = yield* query(
                "delete artifact",
                `DELETE FROM app_artifacts WHERE name = ? RETURNING *`,
                name,
              );
              if (!found) return false;
              yield* blobs.delete(latestPublicCopyKey(found.token));
              for (const key of yield* blobs.list(dataPrefix(found.token)))
                yield* blobs.delete(key);
              return true;
            }),
          history: (channel, name) =>
            Effect.map(blobs.list(versionHistoryPrefix(channel, name)), (keys) =>
              keys
                .map((k) => Number(k.slice(k.lastIndexOf("/") + 1)))
                .filter(Number.isFinite)
                .sort((a, b) => a - b),
            ),
          restore: (channel, name, version) =>
            Effect.gen(function* () {
              const blob = yield* blobs.get(versionCopyKey(channel, name, version));
              if (!blob)
                return yield* new ToolError({ reason: `${name} has no version ${version}` });
              return yield* self.publish(
                channel,
                name,
                new TextDecoder().decode(blob.body),
                blob.contentType,
              );
            }),
          data: {
            list: (name) =>
              Effect.gen(function* () {
                const found = yield* find(name);
                const out: Record<string, string> = {};
                const prefix = dataPrefix(found.token);
                for (const key of yield* blobs.list(prefix)) {
                  const blob = yield* blobs.get(key);
                  if (blob) out[key.slice(prefix.length)] = new TextDecoder().decode(blob.body);
                }
                return out;
              }),
            get: (name, key) =>
              Effect.gen(function* () {
                const found = yield* find(name);
                const blob = yield* blobs.get(dataKey(found.token, key));
                return blob ? new TextDecoder().decode(blob.body) : undefined;
              }),
            set: (name, key, json) =>
              Effect.gen(function* () {
                const found = yield* find(name);
                if (!DATA_KEY.test(key)) {
                  return yield* new ToolError({
                    reason: "a key is letters, digits, dots, dashes, up to 64",
                  });
                }
                yield* Effect.try({
                  try: () => JSON.parse(json) as unknown,
                  catch: () => new ToolError({ reason: "value must be valid JSON" }),
                });
                if (new TextEncoder().encode(json).length > MAX_VALUE_BYTES) {
                  return yield* new ToolError({
                    reason: `a value is at most ${MAX_VALUE_BYTES} bytes`,
                  });
                }
                const keys = yield* blobs.list(dataPrefix(found.token));
                if (!keys.includes(dataKey(found.token, key)) && keys.length >= MAX_KEYS) {
                  return yield* new ToolError({ reason: `at most ${MAX_KEYS} keys` });
                }
                yield* blobs.put(dataKey(found.token, key), json, {
                  contentType: "application/json",
                });
              }),
            delete: (name, key) =>
              Effect.gen(function* () {
                const found = yield* find(name);
                yield* blobs.delete(dataKey(found.token, key));
              }),
          },
          contents: Effect.gen(function* () {
            const out: Array<{
              artifact: Artifact;
              body: Uint8Array;
              data: Record<string, string>;
            }> = [];
            for (const artifact of yield* all) {
              const blob = yield* blobs.get(latestPublicCopyKey(artifact.token));
              if (blob) {
                const data = yield* self.data.list(artifact.name);
                out.push({ artifact, body: blob.body, data });
              }
            }
            return out;
          }),
        });
        return self;
      }),
    );
}
