import { ChatState, WebChat, WebChatClient, WebChatSource } from "@mizook/chat-sync";
import type * as Action from "@yielded/sync/Action";
import * as Client from "@yielded/sync/client/Client";
import { CurrentActor } from "@yielded/sync/client/CurrentActor";
import { layerWebSocketTransport } from "@yielded/sync/client/Transport";
import { IndexedDb } from "@yielded/sync-local-indexeddb";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import * as Socket from "effect/socket/Socket";

export const SyncView = Schema.Struct({
  state: Schema.Option(ChatState),
  connection: Schema.Literals(["idle", "connecting", "live", "recovering", "parked", "closed"]),
  saved: Schema.Boolean,
  error: Schema.Option(Schema.String),
});
export type SyncView = typeof SyncView.Type;

/** The browser's single Effect RPC client for the web chat source. */
export class ChatSync extends Context.Service<
  ChatSync,
  {
    readonly changes: Stream.Stream<SyncView, never>;
    readonly submit: <A extends Client.Actions<typeof WebChat.spec>>(
      action: A,
      payload: Action.Payload<A>,
    ) => Effect.Effect<Client.Command<A>, Client.ClientError>;
    readonly recover: Effect.Effect<void, Client.ClientError>;
  }
>()("mizook/ChatSync") {}

const storageKey = "mizook_actor";

const readStored = Effect.try(() => localStorage.getItem(storageKey)).pipe(
  Effect.map(Option.fromNullishOr),
  Effect.orElseSucceed(Option.none<string>),
);

// The session still works without the fallback.
const remember = (value: string) =>
  Effect.try(() => localStorage.setItem(storageKey, value)).pipe(Effect.ignore);

const actorIdEffect = Effect.gen(function* () {
  const encoded = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${storageKey}=`))
    ?.slice(`${storageKey}=`.length);
  if (encoded !== undefined) {
    // A malformed cookie falls back to the last known actor.
    const decoded = yield* Effect.try(() => decodeURIComponent(encoded)).pipe(Effect.option);
    if (Option.isSome(decoded) && decoded.value !== "") {
      yield* remember(decoded.value);
      return decoded.value;
    }
  }
  const stored = yield* readStored;
  return Option.getOrElse(
    Option.filter(stored, (value) => value !== ""),
    () => "web",
  );
});

const actorId = (): string =>
  typeof document === "undefined" ? "web" : Effect.runSync(actorIdEffect);

const toView = (replica: Client.State<typeof WebChat.spec>): SyncView => ({
  state: Option.fromNullishOr(replica.value?.source),
  connection: replica.connection,
  saved: replica.value !== undefined && replica.connection !== "live",
  error: Option.fromNullishOr(replica.error?.message ?? replica.cacheError?.message),
});

export const layer = Layer.effect(
  ChatSync,
  Effect.gen(function* () {
    const transport = layerWebSocketTransport(WebChat, {
      origin: window.location.origin,
      id: WebChatSource,
    }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    const actor = Layer.succeed(CurrentActor, CurrentActor.of({ actorId: actorId() }));
    const persistence = IndexedDb.layer({ namespace: "mizook-web-chat" }).pipe(
      Layer.provide(actor),
    );
    // Built in this layer's scope: the lease and its IndexedDB connections must
    // outlive this effect, or the first write after startup finds them closed.
    const services = yield* Layer.build(Layer.mergeAll(actor, persistence, transport));
    const openLease = (mode: "persistent" | "volatile") =>
      Client.make(WebChatClient, { persistence: { mode } }).pipe(
        Effect.flatMap((client) => client.open(WebChat.address(WebChatSource))),
        Effect.provide(services),
      );
    // Another tab holds this actor's persisted copy, so this one runs live without saving.
    const lease = yield* openLease("persistent").pipe(Effect.catch(() => openLease("volatile")));
    const changes = lease.changes.pipe(
      Stream.map(toView),
      Stream.catchCause(() => Stream.empty),
    );
    return ChatSync.of({
      changes,
      submit: (action, payload) => lease.submit(action, payload),
      recover: lease.recover,
    });
  }).pipe(Effect.orDie),
);
