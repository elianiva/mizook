import type { SqlDriver } from "@mizook/memory/sqlite";
import { Context, Effect, Layer, Schema } from "effect";
import { Blobs } from "./blobs.ts";
import { Settings } from "./config.ts";
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
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

export interface Artifact {
  readonly name: string;
  readonly token: string;
  readonly version: number;
  readonly contentType: string;
  readonly updated: number;
  readonly url: string;
}

export const artifactHeaders = (contentType: string | undefined): Headers =>
  new Headers({
    "content-type": contentType ?? "text/plain; charset=utf-8",
    "content-security-policy":
      "sandbox allow-scripts allow-forms allow-popups allow-modals; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  });

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
    publish(
      channel: string,
      name: string,
      content: string,
      contentType: string,
    ): Effect.Effect<Artifact, ToolError | StateError | BlobError>;
    readonly list: Effect.Effect<ReadonlyArray<Artifact>, StateError>;
    remove(channel: string, name: string): Effect.Effect<boolean, StateError | BlobError>;
    /** The current content of every artifact, for an export. */
    readonly contents: Effect.Effect<
      ReadonlyArray<{ readonly artifact: Artifact; readonly body: Uint8Array }>,
      StateError | BlobError
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
        const toArtifact = (row: typeof Row.Type): Artifact => ({
          name: row.name,
          token: row.token,
          version: row.version,
          contentType: row.content_type,
          updated: row.updated,
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

        return Artifacts.of({
          publish: (channel, name, content, contentType) =>
            Effect.gen(function* () {
              yield* decodeName(name).pipe(
                Effect.mapError(
                  () =>
                    new ToolError({
                      reason: `bad name "${name}": use lowercase letters, digits, dots, dashes, at most 61 characters`,
                    }),
                ),
              );
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
              yield* blobs.put(`a/${tok}`, body, { contentType });
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
              return true;
            }),
          contents: Effect.gen(function* () {
            const out: Array<{ artifact: Artifact; body: Uint8Array }> = [];
            for (const artifact of yield* all) {
              const blob = yield* blobs.get(`a/${artifact.token}`);
              if (blob) out.push({ artifact, body: blob.body });
            }
            return out;
          }),
        });
      }),
    );
}
