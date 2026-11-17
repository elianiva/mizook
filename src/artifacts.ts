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
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

/** Who may open the public link: anyone who has it, or nobody (the dashboard still can). */
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

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

/**
 * Pages and files the agent publishes. The Worker serves the latest version at an unguessable
 * `/a/<token>/<name>` under a sandboxing Content-Security-Policy; every version is kept in the
 * blob store under `artifacts/<channel>/<name>/<version>`.
 */
export class Artifacts extends Context.Service<
  Artifacts,
  {
    /** Publish a page or file under a name. The same name again adds a version and keeps the link. */
    publish(
      channel: string,
      name: string,
      content: string,
      contentType: string,
      options?: { readonly expiresInHours?: number },
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    readonly list: Effect.Effect<ReadonlyArray<Artifact>, StateError>;
    /** The latest version's text, for the dashboard to show. */
    source(
      name: string,
    ): Effect.Effect<
      { readonly artifact: Artifact; readonly text: string; readonly size: number },
      ToolError | StateError | BlobError
    >;
    /** Open or close the public link. The page keeps its token and its data. */
    setVisibility(
      name: string,
      visibility: Visibility,
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    remove(channel: string, name: string): Effect.Effect<boolean, StateError | BlobError>;
    /** The numbers of the versions kept of an artifact, oldest first. */
    history(
      channel: string,
      name: string,
    ): Effect.Effect<ReadonlyArray<number>, StateError | BlobError>;
    /** Publish an old version again, as a new one. */
    restore(
      channel: string,
      name: string,
      version: number,
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    /** What the page saved with `mizook.data`, which the agent can read and write too. Values are JSON text. */
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
    /** The current content of every artifact and its saved data, for an export. */
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
        const run = <A>(operation: string, f: () => A | Promise<A>) =>
          Effect.tryPromise({
            try: async () => f(),
            catch: (cause) => new StateError({ operation, cause }),
          });
        yield* run("migrate artifacts", () =>
          sql.all(
            `CREATE TABLE IF NOT EXISTS app_artifacts (
               name TEXT PRIMARY KEY, token TEXT NOT NULL, version INTEGER NOT NULL,
               content_type TEXT NOT NULL, updated INTEGER NOT NULL)`,
          ),
        );
        // Older databases have no visibility column; the error on a second run is the answer "it is there".
        yield* run("migrate artifact visibility", () =>
          sql.all(`ALTER TABLE app_artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`),
        ).pipe(Effect.ignore);
        const toArtifact = (row: typeof Row.Type): Artifact => ({
          name: row.name,
          token: row.token,
          version: row.version,
          contentType: row.content_type,
          updated: row.updated,
          visibility: row.visibility,
          url: `${publicUrl}/a/${row.token}/${row.name}`,
        });
        const query = (operation: string, text: string, ...params: unknown[]) =>
          run(operation, () => sql.all(text, ...params)).pipe(
            Effect.flatMap(decodeRows),
            Effect.mapError((cause) =>
              cause instanceof StateError ? cause : new StateError({ operation, cause }),
            ),
            Effect.map((rows) => rows.map(toArtifact)),
          );
        const all = query("list artifacts", `SELECT * FROM app_artifacts ORDER BY name`);

        const find = (name: string) =>
          Effect.flatMap(
            query("find artifact", `SELECT * FROM app_artifacts WHERE name = ?`, name),
            ([found]) =>
              found
                ? Effect.succeed(found)
                : Effect.fail(new ToolError({ reason: `no artifact ${name}` })),
          );

        const self: Context.Service.Shape<typeof Artifacts> = Artifacts.of({
          publish: (channel, name, content, contentType, options) =>
            Effect.gen(function* () {
              yield* decodeName(name).pipe(
                Effect.mapError(
                  () =>
                    new ToolError({
                      reason: `bad name "${name}": use lowercase letters, digits, dots, dashes, at most 61 characters`,
                    }),
                ),
              );
              const invalid = checkContent(contentType, content);
              if (invalid) return yield* new ToolError({ reason: invalid });
              const body = new TextEncoder().encode(content);
              if (body.length > MAX_ARTIFACT_BYTES) {
                return yield* new ToolError({ reason: `too large: ${body.length} bytes` });
              }
              const [current] = yield* query(
                "find artifact",
                `SELECT * FROM app_artifacts WHERE name = ?`,
                name,
              );
              const version = (current?.version ?? 0) + 1;
              const tok = current?.token ?? token();
              yield* blobs.put(`artifacts/${channel}/${name}/${version}`, body, { contentType });
              // The public copy is the latest version, found by token alone.
              // What serves a page needs only this: its kind, its channel (for `say`), when it lapses.
              yield* blobs.put(`a/${tok}`, body, {
                contentType,
                meta: {
                  name,
                  do: doNameOf(channel),
                  visibility: current?.visibility ?? "public",
                  ...(options?.expiresInHours
                    ? { expires: String(Date.now() + options.expiresInHours * 3_600_000) }
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
            }),
          list: all,
          source: (name) =>
            Effect.gen(function* () {
              const artifact = yield* find(name);
              const blob = yield* blobs.get(`a/${artifact.token}`);
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
              const blob = yield* blobs.get(`a/${found.token}`);
              if (!blob) return yield* new ToolError({ reason: `no artifact ${name}` });
              yield* blobs.put(`a/${found.token}`, blob.body, {
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
              // Versions stay in the log of the channel; only the public link stops working.
              yield* blobs.delete(`a/${found.token}`);
              for (const key of yield* blobs.list(dataPrefix(found.token)))
                yield* blobs.delete(key);
              return true;
            }),
          history: (channel, name) =>
            Effect.map(blobs.list(`artifacts/${channel}/${name}/`), (keys) =>
              keys
                .map((k) => Number(k.slice(k.lastIndexOf("/") + 1)))
                .filter(Number.isFinite)
                .sort((a, b) => a - b),
            ),
          restore: (channel, name, version) =>
            Effect.gen(function* () {
              const blob = yield* blobs.get(`artifacts/${channel}/${name}/${version}`);
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
              const blob = yield* blobs.get(`a/${artifact.token}`);
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
