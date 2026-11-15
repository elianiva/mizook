import { Context, Effect, Layer, Redacted, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { Settings } from "./config.ts";
import { ExecutorError } from "./errors.ts";

/** The tools Executor's MCP endpoint serves, however many apps are connected behind it. */
export const EXECUTOR_TOOLS = [
  "skills",
  "search",
  "describe",
  "call",
  "execute",
  "resume",
] as const;

const Rpc = Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});
const decodeRpc = Schema.decodeUnknownEffect(Rpc);
const Content = Schema.Struct({
  content: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
  ),
  isError: Schema.optionalKey(Schema.Boolean),
});
const decodeContent = Schema.decodeUnknownEffect(Content);

/** A response is plain JSON or a server-sent event stream: take the last JSON-RPC message. */
export const parseRpcBody = (body: string): unknown => {
  const trimmed = body.trim();
  if (!trimmed.startsWith("event:") && !trimmed.startsWith("data:")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  return JSON.parse(data.at(-1) ?? "null");
};

/**
 * Executor over MCP (streamable HTTP): the connectors, credentials and approvals live there, and
 * the agent reaches them through its six fixed tools.
 */
export class Executor extends Context.Service<
  Executor,
  {
    readonly enabled: boolean;
    call(tool: string, input: Record<string, unknown>): Effect.Effect<string, ExecutorError>;
  }
>()("mizook/Executor") {
  static readonly layer = Layer.effect(
    Executor,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const { executorUrl, executorToken } = yield* Settings;
      const token = Redacted.value(executorToken);
      const enabled = executorUrl !== "" && token !== "";

      const fail = (reason: string) => new ExecutorError({ reason });

      const rpc = (
        session: string | undefined,
        id: number | undefined,
        method: string,
        params: unknown,
      ) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(executorUrl, {
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${token}`,
              ...(session ? { "mcp-session-id": session } : {}),
            },
          }).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              ...(id ? { id } : {}),
              method,
              params,
            }),
          );
          const response = yield* HttpClient.execute(request);
          if (response.status >= 400) {
            return yield* fail(`${response.status} ${yield* response.text}`.slice(0, 300));
          }
          const text = yield* response.text;
          return { session: response.headers["mcp-session-id"], text };
        }).pipe(
          Effect.mapError((e) => (e instanceof ExecutorError ? e : fail(String(e.message ?? e)))),
        );

      const call = (tool: string, input: Record<string, unknown>) =>
        Effect.gen(function* () {
          if (!enabled) return yield* fail("not configured: set EXECUTOR_URL and EXECUTOR_TOKEN");
          const init = yield* rpc(undefined, 1, "initialize", {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "mizook", version: "1" },
          });
          yield* rpc(init.session, undefined, "notifications/initialized", {});
          const done = yield* rpc(init.session, 2, "tools/call", { name: tool, arguments: input });
          const message = yield* Effect.try({
            try: () => parseRpcBody(done.text),
            catch: () => fail("unreadable response"),
          }).pipe(
            Effect.flatMap((json) =>
              decodeRpc(json).pipe(Effect.mapError(() => fail("unexpected response"))),
            ),
          );
          if (message.error) return yield* fail(message.error.message);
          const result = yield* decodeContent(message.result).pipe(
            Effect.mapError(() => fail("unexpected result")),
          );
          const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
          return result.isError ? `Error: ${text}` : text;
        }).pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(fail("timed out")),
          }),
        );

      return Executor.of({
        enabled,
        call: (tool, input) =>
          call(tool, input).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      });
    }),
  );
}
