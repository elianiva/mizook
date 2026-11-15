import { Context, Effect, Layer } from "effect";
import { BlobError } from "./errors.ts";

export interface Blob {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly meta: Readonly<Record<string, string>>;
}

export interface PutOptions {
  readonly contentType?: string;
  readonly meta?: Record<string, string>;
}

/** Files and exports: R2 in production, a map in tests. */
export class Blobs extends Context.Service<
  Blobs,
  {
    put(
      key: string,
      body: string | Uint8Array,
      options?: PutOptions,
    ): Effect.Effect<void, BlobError>;
    get(key: string): Effect.Effect<Blob | undefined, BlobError>;
    delete(key: string): Effect.Effect<void, BlobError>;
    /** Keys with this prefix, in order. */
    list(prefix: string): Effect.Effect<ReadonlyArray<string>, BlobError>;
  }
>()("mizook/Blobs") {
  static readonly r2 = (bucket: R2Bucket) =>
    Layer.succeed(
      Blobs,
      (() => {
        const run = <A>(operation: string, f: () => Promise<A>) =>
          Effect.tryPromise({ try: f, catch: (cause) => new BlobError({ operation, cause }) });
        return Blobs.of({
          put: (key, body, options) =>
            run("put", () =>
              bucket.put(key, body, {
                httpMetadata: { contentType: options?.contentType ?? "application/octet-stream" },
                customMetadata: options?.meta ?? {},
              }),
            ).pipe(Effect.asVoid),
          get: (key) =>
            run("get", async () => {
              const object = await bucket.get(key);
              if (!object) return undefined;
              return {
                body: new Uint8Array(await object.arrayBuffer()),
                contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
                meta: object.customMetadata ?? {},
              } satisfies Blob;
            }),
          delete: (key) => run("delete", () => bucket.delete(key)),
          list: (prefix) =>
            run("list", async () => {
              const keys: string[] = [];
              let cursor: string | undefined;
              do {
                const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
                keys.push(...page.objects.map((o) => o.key));
                cursor = page.truncated ? page.cursor : undefined;
              } while (cursor);
              return keys.sort();
            }),
        });
      })(),
    );

  /** In memory, for tests. */
  static readonly memory = Layer.sync(Blobs, () => {
    const store = new Map<string, Blob>();
    const bytes = (body: string | Uint8Array) =>
      typeof body === "string" ? new TextEncoder().encode(body) : body;
    return Blobs.of({
      put: (key, body, options) =>
        Effect.sync(() => {
          store.set(key, {
            body: bytes(body),
            contentType: options?.contentType ?? "application/octet-stream",
            meta: options?.meta ?? {},
          });
        }),
      get: (key) => Effect.sync(() => store.get(key)),
      delete: (key) => Effect.sync(() => void store.delete(key)),
      list: (prefix) =>
        Effect.sync(() => [...store.keys()].filter((k) => k.startsWith(prefix)).sort()),
    });
  });
}
