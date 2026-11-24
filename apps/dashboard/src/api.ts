import { Data, Effect, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import { Query } from "foldkit/experimental";
import {
  CSRF_HEADER,
  CSRF_VALUE,
  ErrorReply,
  paths,
  PublishedReply,
  Reads,
  SavedReply,
  type ActionKind,
  type AgentEdit,
  type AgentManagement,
  type AgentOp,
  type ArtifactAction,
  type ReadPage,
  type SettingInput,
  type SettingKey,
} from "@mizook/admin-api";

class ApiError extends Data.TaggedError("ApiError")<{ readonly reason: string }> {
  override get message(): string {
    return this.reason;
  }
}

const isSuccess = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300;

const sendRequest = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.mapError((cause) => new ApiError({ reason: cause.message })),
    Effect.provide(FetchHttpClient.layer),
  );

const readJson = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(Effect.mapError((cause) => new ApiError({ reason: cause.message })));

const fetchJson = <A, I>(
  schema: Schema.Codec<A, I>,
  page: ReadPage,
  params: Readonly<Record<string, string | number>>,
): Effect.Effect<A, string> =>
  Effect.gen(function* () {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, value]) => value !== "")
        .map(([key, value]) => [key, String(value)]),
    ).toString();
    const url = query === "" ? paths.read(page) : `${paths.read(page)}?${query}`;
    const response = yield* sendRequest(
      HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson),
    );
    if (!isSuccess(response)) {
      return yield* new ApiError({
        reason: response.status === 404 ? "Not found" : `Request failed (${response.status})`,
      });
    }
    const body = yield* readJson(response);
    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => new ApiError({ reason: "The server sent something unexpected" })),
    );
  }).pipe(Effect.mapError((error) => error.message));

const channelArgs = { channel: Schema.String };

/** Keyed by channel alone, so an optimistic write can name the entry it patches. */
export const channelKey = ({ channel }: { readonly channel: string }): string => channel;

export const channelsQuery = Query.define({
  name: "Channels",
  data: Reads.channels,
  error: Schema.String,
  execute: fetchJson(Reads.channels, "channels", {}),
});

export const overviewQuery = Query.define({
  name: "Overview",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.overview,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.overview, "overview", { c: channel }),
});

export const logQuery = Query.define({
  name: "Log",
  args: { channel: Schema.String, kind: Schema.String, q: Schema.String, before: Schema.String },
  data: Reads.messages,
  error: Schema.String,
  execute: ({ channel, kind, q, before }) =>
    fetchJson(Reads.messages, "messages", { c: channel, kind, q, before }),
});

export const entryQuery = Query.define({
  name: "Entry",
  args: { channel: Schema.String, entryId: Schema.Finite },
  data: Reads.message,
  error: Schema.String,
  execute: ({ channel, entryId }) =>
    fetchJson(Reads.message, "message", { c: channel, i: entryId }),
});

export const memoryQuery = Query.define({
  name: "Memory",
  args: channelArgs,
  data: Reads.memory,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.memory, "memory", { c: channel }),
});

export const usageQuery = Query.define({
  name: "Usage",
  args: { channel: Schema.String, days: Schema.Finite },
  data: Reads.usage,
  error: Schema.String,
  execute: ({ channel, days }) => fetchJson(Reads.usage, "usage", { c: channel, days }),
});

export const schedulesQuery = Query.define({
  name: "Schedules",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.schedules,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.schedules, "schedules", { c: channel }),
});

export const profileQuery = Query.define({
  name: "Profile",
  data: Reads.profile,
  error: Schema.String,
  execute: fetchJson(Reads.profile, "profile", {}),
});

export const skillsQuery = Query.define({
  name: "Skills",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.skills,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.skills, "skills", { c: channel }),
});

export const intentsQuery = Query.define({
  name: "Intents",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.intents,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.intents, "intents", { c: channel }),
});

export const policiesQuery = Query.define({
  name: "Policies",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.policies,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.policies, "policies", { c: channel }),
});

export const runsQuery = Query.define({
  name: "Runs",
  args: channelArgs,
  data: Reads.runs,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.runs, "runs", { c: channel, limit: 25 }),
});

export const artifactsQuery = Query.define({
  name: "Artifacts",
  args: channelArgs,
  toKey: channelKey,
  data: Reads.artifacts,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.artifacts, "artifacts", { c: channel }),
});

export const artifactQuery = Query.define({
  name: "Artifact",
  args: { channel: Schema.String, name: Schema.String },
  data: Reads.artifact,
  error: Schema.String,
  execute: ({ channel, name }) => fetchJson(Reads.artifact, "artifact", { c: channel, name }),
});

export const agentsQuery = Query.define({
  name: "Agents",
  data: Reads.agents,
  error: Schema.String,
  execute: fetchJson(Reads.agents, "agents", {}),
});

export const summaryQuery = Query.define({
  name: "Summary",
  data: Reads.summary,
  error: Schema.String,
  execute: fetchJson(Reads.summary, "summary", {}),
});

export const auditQuery = Query.define({
  name: "Audit",
  args: channelArgs,
  data: Reads.audit,
  error: Schema.String,
  execute: ({ channel }) => fetchJson(Reads.audit, "audit", { c: channel }),
});

const OVERVIEW_RECENT_MESSAGE_COUNT = 8;

export const recentQuery = Query.define({
  name: "Recent",
  args: channelArgs,
  data: Reads.messages,
  error: Schema.String,
  execute: ({ channel }) =>
    fetchJson(Reads.messages, "messages", {
      c: channel,
      limit: OVERVIEW_RECENT_MESSAGE_COUNT,
    }),
});

const HTTP_CONFLICT = 409;

const postSameOrigin = (
  path: string,
  channel: string | undefined,
  body?: unknown,
): Effect.Effect<unknown, string> =>
  Effect.gen(function* () {
    const scope = channel === undefined ? "" : `?c=${encodeURIComponent(channel)}`;
    const post = HttpClientRequest.post(`${path}${scope}`, {
      headers: { [CSRF_HEADER]: CSRF_VALUE, "content-type": "application/json" },
    });
    const response = yield* sendRequest(
      body === undefined ? post : HttpClientRequest.bodyJsonUnsafe(post, body),
    );
    const reply: unknown = yield* readJson(response).pipe(Effect.orElseSucceed(() => ({})));
    if (!isSuccess(response)) {
      const serverError = Option.map(Schema.decodeUnknownOption(ErrorReply)(reply), (r) => r.error);
      return yield* new ApiError({
        reason:
          response.status === HTTP_CONFLICT
            ? "It was already handled"
            : Option.getOrElse(serverError, () => `Request failed (${response.status})`),
      });
    }
    return reply;
  }).pipe(Effect.mapError((error) => error.message));

export const postAction = (
  channel: string,
  action: ActionKind,
  id: number,
): Effect.Effect<void, string> =>
  postSameOrigin(
    action === "stop"
      ? paths.stop
      : action === "cancel"
        ? paths.cancelSchedule(id)
        : paths.approval(id, action),
    channel,
  ).pipe(Effect.asVoid);

const channelReplyOf = (reply: unknown): string =>
  Option.match(Schema.decodeUnknownOption(SavedReply)(reply), {
    onNone: () => "Saved.",
    onSome: (saved) => saved.said,
  });

const publicLinkOf = (reply: unknown): string =>
  Option.match(Schema.decodeUnknownOption(PublishedReply)(reply), {
    onNone: () => "",
    onSome: (published) => published.url,
  });

export const postNewArtifact = (
  channel: string,
  draft: { name: string; kind: string; content: string },
): Effect.Effect<string, string> =>
  postSameOrigin(paths.newArtifact, channel, draft).pipe(Effect.map(publicLinkOf));

export const postArtifact = (
  channel: string,
  name: string,
  action: ArtifactAction,
): Effect.Effect<void, string> =>
  postSameOrigin(paths.artifact(name, action), channel).pipe(Effect.asVoid);

export const postSetting = (
  channel: string,
  key: SettingKey,
  value: string,
): Effect.Effect<string, string> => {
  const body: SettingInput = { value };
  return postSameOrigin(paths.setting(key), channel, body).pipe(Effect.map(channelReplyOf));
};

export const postAgent = (channel: string, edit: AgentEdit): Effect.Effect<string, string> => {
  const { kind, ...body } = edit;
  return postSameOrigin(paths.edit(kind), channel, body).pipe(Effect.map(channelReplyOf));
};

export const postManagedAgent = (
  op: AgentOp,
  slug: string,
  body: AgentManagement | undefined,
): Effect.Effect<string, string> =>
  postSameOrigin(
    op === "create" ? paths.newAgent : paths.agent(slug, op),
    undefined,
    body ?? {},
  ).pipe(Effect.map(channelReplyOf));
