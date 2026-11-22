import { Effect, Schema } from "effect";

export const Agent = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
  isWebDefault: Schema.Boolean,
});
export type Agent = typeof Agent.Type;

export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  created: Schema.Finite,
  updated: Schema.Finite,
  agent: Schema.Struct({ slug: Schema.String, name: Schema.String }),
});
export type ThreadSummary = typeof ThreadSummary.Type;

export const Bootstrap = Schema.Struct({
  agents: Schema.Array(Agent),
  threads: Schema.Array(ThreadSummary),
  defaultAgent: Schema.Struct({ slug: Schema.String, name: Schema.String }),
});
export type Bootstrap = typeof Bootstrap.Type;

export const ChatMessage = Schema.Struct({
  id: Schema.Finite,
  role: Schema.Literals(["user", "agent"]),
  text: Schema.String,
  at: Schema.Finite,
});
export type ChatMessage = typeof ChatMessage.Type;

export const Approval = Schema.Struct({
  id: Schema.Finite,
  summary: Schema.String,
  match: Schema.String,
  created: Schema.Finite,
});
export type Approval = typeof Approval.Type;

export const ThreadState = Schema.Struct({
  thread: ThreadSummary,
  messages: Schema.Array(ChatMessage),
  running: Schema.Boolean,
  approvals: Schema.Array(Approval),
});
export type ThreadState = typeof ThreadState.Type;

const ThreadReply = Schema.Struct({ thread: ThreadSummary });

export const SendReplySchema = Schema.Struct({
  ok: Schema.Literal(true),
  folded: Schema.Boolean,
  messageId: Schema.Finite,
  at: Schema.Finite,
  thread: ThreadSummary,
});
export type SendReply = typeof SendReplySchema.Type;

const StopReply = Schema.Struct({ ok: Schema.Boolean });

const errorOf = async (response: Response): Promise<string> => {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (typeof body.error === "string") return body.error;
  if (response.status === 403) return "Your Access session expired. Reload the page.";
  if (response.status === 503) return "The chat is not configured yet.";
  return `Request failed (${response.status})`;
};

const request = <A, I>(
  schema: Schema.Codec<A, I>,
  path: string,
  init?: RequestInit,
): Effect.Effect<A, string> =>
  Effect.tryPromise({
    try: async () => {
      const headers = new Headers(init?.headers);
      headers.set("accept", "application/json");
      if (init?.body !== undefined) headers.set("content-type", "application/json");
      if (init?.method === "POST" || init?.method === "PATCH") headers.set("x-mizook-csrf", "1");
      const response = await fetch(path, { ...init, headers });
      if (!response.ok) throw new Error(await errorOf(response));
      return (await response.json()) as unknown;
    },
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() => "The server sent something unexpected."),
      ),
    ),
  );

const get = <A, I>(schema: Schema.Codec<A, I>, path: string) => request(schema, path);

const write = <A, I>(
  schema: Schema.Codec<A, I>,
  path: string,
  method: "POST" | "PATCH",
  body?: unknown,
) =>
  request(schema, path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const getBootstrap: Effect.Effect<Bootstrap, string> = get(Bootstrap, "/c/api/bootstrap");

export const getThread = (id: string, after: number): Effect.Effect<ThreadState, string> =>
  get(ThreadState, `/c/api/threads/${encodeURIComponent(id)}?after=${after}`);

export const createThread = (agent: string | undefined): Effect.Effect<ThreadSummary, string> =>
  write(ThreadReply, "/c/api/threads", "POST", agent === undefined ? {} : { agent }).pipe(
    Effect.map((reply) => reply.thread),
  );

export const sendMessage = (
  id: string,
  text: string,
  requestId: string,
): Effect.Effect<SendReply, string> =>
  write(SendReplySchema, `/c/api/threads/${encodeURIComponent(id)}/messages`, "POST", {
    text,
    requestId,
  });

export const stopThread = (id: string): Effect.Effect<boolean, string> =>
  write(StopReply, `/c/api/threads/${encodeURIComponent(id)}/stop`, "POST").pipe(
    Effect.map((reply) => reply.ok),
  );

export const approve = (
  threadId: string,
  approvalId: number,
  action: "approve" | "always" | "deny",
): Effect.Effect<void, string> =>
  write(Schema.Struct({ ok: Schema.Boolean }), `/c/api/approvals/${approvalId}`, "POST", {
    action,
    thread: threadId,
  }).pipe(Effect.asVoid);

export const renameThread = (id: string, title: string): Effect.Effect<ThreadSummary, string> =>
  write(ThreadReply, `/c/api/threads/${encodeURIComponent(id)}`, "PATCH", { title }).pipe(
    Effect.map((reply) => reply.thread),
  );

export const archiveThread = (id: string): Effect.Effect<void, string> =>
  write(
    Schema.Struct({ ok: Schema.Boolean }),
    `/c/api/threads/${encodeURIComponent(id)}/archive`,
    "POST",
  ).pipe(Effect.asVoid);
