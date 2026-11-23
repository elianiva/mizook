import { Effect, Option, Schema } from "effect";

import { Bootstrap, ThreadState } from "./api.ts";

const DATABASE_NAME = "mizook";
const DATABASE_VERSION = 1;
const STORE_NAME = "saved";
const BOOTSTRAP_KEY = "bootstrap";
const THREAD_PREFIX = "thread:";

const threadKey = (id: string): string => `${THREAD_PREFIX}${id}`;

let database: Promise<IDBDatabase> | undefined;

const openDatabase = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser has no local database."));
  }
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const opened = request.result;
      if (!opened.objectStoreNames.contains(STORE_NAME)) opened.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The local database could not open."));
  });
  return database;
};

const readValue = async (key: string): Promise<unknown> => {
  const opened = await openDatabase();
  return await new Promise<unknown>((resolve, reject) => {
    const request = opened.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("The local database could not be read."));
  });
};

const writeValue = async (key: string, value: unknown): Promise<void> => {
  const opened = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = opened.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("The local database could not be written."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The local database could not be written."));
  });
};

const deleteValue = async (key: string): Promise<void> => {
  const opened = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = opened.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("The local database could not be written."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("The local database could not be written."));
  });
};

const readSaved = <A>(key: string, decode: (value: unknown) => Option.Option<A>) =>
  Effect.promise(async () => decode(await readValue(key))).pipe(
    Effect.catchCause(() => Effect.succeed(Option.none<A>())),
  );

const save = (key: string, value: unknown): Effect.Effect<void> =>
  Effect.promise(() => writeValue(key, value)).pipe(Effect.ignoreCause);

export const readBootstrap: Effect.Effect<Option.Option<Bootstrap>> = readSaved(
  BOOTSTRAP_KEY,
  Schema.decodeUnknownOption(Bootstrap),
);

export const saveBootstrap = (data: Bootstrap): Effect.Effect<void> => save(BOOTSTRAP_KEY, data);

export const readThread = (id: string): Effect.Effect<Option.Option<ThreadState>> =>
  readSaved(threadKey(id), Schema.decodeUnknownOption(ThreadState));

const lastSavedThread = new Map<string, string>();

const threadFingerprint = (state: ThreadState): string =>
  [
    state.thread.id,
    state.thread.title,
    state.thread.preview,
    state.thread.updated,
    state.messages.length,
    state.messages[state.messages.length - 1]?.id ?? 0,
    state.running,
    state.approvals.length,
  ].join("\u0000");

export const saveThread = (state: ThreadState): Effect.Effect<void> => {
  const key = threadKey(state.thread.id);
  const fingerprint = threadFingerprint(state);
  if (lastSavedThread.get(key) === fingerprint) return Effect.void;
  lastSavedThread.set(key, fingerprint);
  return save(key, state);
};

export const forgetThread = (id: string): Effect.Effect<void> => {
  lastSavedThread.delete(threadKey(id));
  return Effect.promise(() => deleteValue(threadKey(id))).pipe(Effect.ignoreCause);
};
