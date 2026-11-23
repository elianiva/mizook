import {
  ChatEvent,
  ChatMessage,
  ChatState,
  ThreadSummary,
  ThreadTranscript,
  WebChat,
  emptyTranscript,
  previewOf,
  titleOf,
  withThread,
  withTranscript,
  type Agent,
  type Approval,
} from "@mizook/chat-sync";
import { Server } from "@yielded/sync/server";
import { ProtocolError } from "@yielded/sync";
import { Effect, Predicate, Schema } from "effect";
import type { Env } from "../env.ts";
import type { AgentInfo, WebThreadInfo } from "../host.ts";
import type { WebState, WebStatus, WebTurnResult } from "./types.ts";

export const INTERNAL_PRINCIPAL = "internal";

const ServerState = Schema.Struct({
  chat: ChatState,
  nextMessageId: Schema.Int,
});
type ServerState = typeof ServerState.Type;

interface HubChatApi {
  agents(): Promise<AgentInfo[]>;
  webThreads(): Promise<WebThreadInfo[]>;
  webDefaultAgent(): Promise<AgentInfo>;
}

interface AgentChatApi {
  webTurn(place: string, text: string, requestId: string, where: string): Promise<WebTurnResult>;
  webState(place: string, after: number): Promise<WebState>;
  webStatus(place: string): Promise<WebStatus>;
  webStop(place: string): Promise<boolean>;
  act(who: string, action: string, id: number): Promise<boolean>;
}

const hubOf = (env: Env) => env.Hub.getByName("hub") as unknown as HubChatApi;
const agentOf = (env: Env, thread: ThreadSummary) =>
  env.AgentObject.getByName(`agent:${thread.agent.id}`) as unknown as AgentChatApi;

const promise = <A>(operation: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (cause) =>
      new ProtocolError({
        reason: "Unavailable",
        message: `${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const agentView = (agent: AgentInfo, webDefault: AgentInfo): Agent => ({
  id: agent.id,
  slug: agent.slug,
  name: agent.name,
  isDefault: agent.isDefault,
  isWebDefault: agent.id === webDefault.id,
});

const threadSummary = (thread: WebThreadInfo): ThreadSummary => ({
  id: thread.id,
  title: thread.title,
  preview: thread.preview,
  created: thread.created,
  updated: thread.updated,
  agent: { id: thread.agent.id, slug: thread.agent.slug, name: thread.agent.name },
  archived: false,
});

const transcriptOf = (state: WebState): ThreadTranscript => ({
  messages: state.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    at: message.at,
  })),
  running: state.running,
  approvals: state.approvals.map(({ id, summary, match, created }) => ({
    id,
    summary,
    match,
    created,
  })),
});

const approvalsOf = (status: WebStatus): ReadonlyArray<Approval> =>
  status.approvals.map(({ id, summary, match, created }) => ({ id, summary, match, created }));

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const threadOf = (state: ServerState, threadId: string): ThreadSummary | undefined =>
  state.chat.threads.find((thread) => thread.id === threadId);

const transcriptOfThread = (state: ServerState, threadId: string): ThreadTranscript =>
  state.chat.transcripts[threadId] ?? emptyTranscript;

const initialize = (env: Env) =>
  Effect.gen(function* () {
    const hub = hubOf(env);
    const [agents, webDefault, threads] = yield* promise("read the web chat", () =>
      Promise.all([hub.agents(), hub.webDefaultAgent(), hub.webThreads()]),
    );
    const states = yield* Effect.forEach(
      threads,
      (thread) =>
        promise("read a saved web thread", () =>
          (env.AgentObject.getByName(thread.agent.doName) as unknown as AgentChatApi).webState(
            `web:${thread.id}`,
            0,
          ),
        ).pipe(Effect.map((state) => ({ thread, state }))),
      { concurrency: 4 },
    );
    const nextMessageId = states.reduce(
      (next, { state }) =>
        state.messages.reduce((highest, message) => Math.max(highest, message.id + 1), next),
      1,
    );
    const chat: ChatState = {
      agents: agents.map((agent) => agentView(agent, webDefault)),
      threads: threads.map(threadSummary),
      defaultAgent: { slug: webDefault.slug, name: webDefault.name },
      transcripts: Object.fromEntries(
        states.map(({ thread, state }) => [thread.id, transcriptOf(state)]),
      ),
    };
    return { chat, nextMessageId } satisfies ServerState;
  });

const create = (state: ServerState, payload: { readonly id: string; readonly agent?: string }) =>
  Effect.gen(function* () {
    const id = payload.id.trim();
    if (id === "") return yield* Effect.fail({ reason: "Give the chat an id." });
    const existing = threadOf(state, id);
    if (existing !== undefined)
      return Server.commit({ state, events: [], result: { thread: existing } });
    const agent =
      payload.agent === undefined
        ? (state.chat.agents.find((candidate) => candidate.slug === state.chat.defaultAgent.slug) ??
          state.chat.agents[0])
        : state.chat.agents.find((candidate) => candidate.slug === payload.agent);
    if (agent === undefined) return yield* Effect.fail({ reason: "No agent called that." });
    const at = Date.now();
    const thread: ThreadSummary = {
      id,
      title: "New chat",
      preview: "",
      created: at,
      updated: at,
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      archived: false,
    };
    const chat = withThread(state.chat, thread);
    return Server.commit({
      state: { ...state, chat },
      events: [ChatEvent.cases.Thread.make({ thread })],
      result: { thread },
    });
  });

const send = (
  env: Env,
  state: ServerState,
  payload: { readonly threadId: string; readonly text: string; readonly requestId: string },
) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const text = payload.text.trim();
    if (text === "") return yield* Effect.fail({ reason: "Say something first." });
    if (text.length > 20_000) return yield* Effect.fail({ reason: "That message is too long." });
    const requestId = payload.requestId.trim();
    if (requestId === "") return yield* Effect.fail({ reason: "Missing message id." });
    const transcript = transcriptOfThread(state, thread.id);
    const alreadySent = transcript.messages.find((message) => message.requestId === requestId);
    if (alreadySent !== undefined)
      return Server.commit({ state, events: [], result: { message: alreadySent } });
    const at = Date.now();
    const message: ChatMessage = {
      id: state.nextMessageId,
      role: "user",
      text,
      at,
      requestId,
    };
    const title = titleOf(thread, text);
    const preview = previewOf(text);
    const updated: ThreadSummary = { ...thread, title, preview, updated: at };
    const chat = withTranscript(withThread(state.chat, updated), thread.id, {
      ...transcript,
      messages: [...transcript.messages, message],
      running: true,
    });
    const result = yield* promise("start a web turn", () =>
      agentOf(env, thread).webTurn(`web:${thread.id}`, text, requestId, title),
    );
    if (!result.ok) return yield* Effect.fail({ reason: result.reason });
    return Server.commit({
      state: { chat, nextMessageId: state.nextMessageId + 1 },
      events: [
        ChatEvent.cases.Thread.make({ thread: updated }),
        ChatEvent.cases.Message.make({ threadId: thread.id, message }),
        ChatEvent.cases.Status.make({
          threadId: thread.id,
          running: true,
          approvals: transcript.approvals,
        }),
      ],
      result: { message },
    });
  });

const stop = (env: Env, state: ServerState, payload: { readonly threadId: string }) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const ok = yield* promise("stop a web turn", () =>
      agentOf(env, thread).webStop(`web:${thread.id}`),
    );
    const transcript = transcriptOfThread(state, thread.id);
    if (!transcript.running) return Server.commit({ state, events: [], result: { ok } });
    return Server.commit({
      state: {
        ...state,
        chat: withTranscript(state.chat, thread.id, { ...transcript, running: false }),
      },
      events: [
        ChatEvent.cases.Status.make({
          threadId: thread.id,
          running: false,
          approvals: transcript.approvals,
        }),
      ],
      result: { ok },
    });
  });

const approve = (
  env: Env,
  principal: string,
  state: ServerState,
  payload: {
    readonly threadId: string;
    readonly approvalId: number;
    readonly action: "approve" | "always" | "deny";
  },
) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const acted = yield* promise("answer an approval", () =>
      agentOf(env, thread).act(principal, payload.action, payload.approvalId),
    );
    if (!acted) return yield* Effect.fail({ reason: "That approval expired." });
    const transcript = transcriptOfThread(state, thread.id);
    const approvals = transcript.approvals.filter((approval) => approval.id !== payload.approvalId);
    return Server.commit({
      state: {
        ...state,
        chat: withTranscript(state.chat, thread.id, {
          ...transcript,
          running: true,
          approvals,
        }),
      },
      events: [ChatEvent.cases.Status.make({ threadId: thread.id, running: true, approvals })],
      result: { ok: true },
    });
  });

const rename = (
  state: ServerState,
  payload: { readonly threadId: string; readonly title: string },
) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const title = payload.title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (title === "") return yield* Effect.fail({ reason: "Give the chat a name." });
    const updated: ThreadSummary = { ...thread, title, updated: Date.now() };
    return Server.commit({
      state: { ...state, chat: withThread(state.chat, updated) },
      events: [ChatEvent.cases.Thread.make({ thread: updated })],
      result: { thread: updated },
    });
  });

const archive = (state: ServerState, payload: { readonly threadId: string }) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const updated: ThreadSummary = { ...thread, archived: true, updated: Date.now() };
    return Server.commit({
      state: { ...state, chat: withThread(state.chat, updated) },
      events: [ChatEvent.cases.Thread.make({ thread: updated })],
      result: undefined,
    });
  });

const refresh = (env: Env, state: ServerState, payload: { readonly threadId?: string }) =>
  Effect.gen(function* () {
    if (payload.threadId !== undefined) {
      const thread = threadOf(state, payload.threadId);
      if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
      const status = yield* promise("refresh a web thread", () =>
        agentOf(env, thread).webStatus(`web:${thread.id}`),
      );
      const transcript = transcriptOfThread(state, thread.id);
      const approvals = approvalsOf(status);
      if (transcript.running === status.running && same(transcript.approvals, approvals))
        return Server.commit({ state, events: [], result: undefined });
      return Server.commit({
        state: {
          ...state,
          chat: withTranscript(state.chat, thread.id, {
            ...transcript,
            running: status.running,
            approvals,
          }),
        },
        events: [
          ChatEvent.cases.Status.make({ threadId: thread.id, running: status.running, approvals }),
        ],
        result: undefined,
      });
    }

    const hub = hubOf(env);
    const [agents, webDefault] = yield* promise("refresh the agent list", () =>
      Promise.all([hub.agents(), hub.webDefaultAgent()]),
    );
    const nextAgents = agents.map((agent) => agentView(agent, webDefault));
    const nextDefault = { slug: webDefault.slug, name: webDefault.name };
    let events: ReadonlyArray<ChatEvent> = [];
    if (!same(nextAgents, state.chat.agents) || !same(nextDefault, state.chat.defaultAgent))
      events = [
        ...events,
        ChatEvent.cases.Agents.make({ agents: nextAgents, defaultAgent: nextDefault }),
      ];
    const nextThreads = state.chat.threads.map((thread) => {
      const agent = nextAgents.find((candidate) => candidate.id === thread.agent.id);
      const nextThread: ThreadSummary = {
        ...thread,
        agent:
          agent === undefined ? thread.agent : { id: agent.id, slug: agent.slug, name: agent.name },
        archived: thread.archived || agent === undefined,
      };
      if (!same(nextThread, thread))
        events = [...events, ChatEvent.cases.Thread.make({ thread: nextThread })];
      return nextThread;
    });
    return Server.commit({
      state: {
        ...state,
        chat: {
          ...state.chat,
          agents: nextAgents,
          defaultAgent: nextDefault,
          threads: nextThreads,
        },
      },
      events,
      result: undefined,
    });
  });

const appendAgent = (
  state: ServerState,
  payload: { readonly threadId: string; readonly text: string },
) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const text = payload.text.trim();
    if (text === "") return yield* Effect.fail({ reason: "Nothing to add." });
    const at = Date.now();
    const message: ChatMessage = {
      id: state.nextMessageId,
      role: "agent",
      text,
      at,
    };
    const transcript = transcriptOfThread(state, thread.id);
    const updated: ThreadSummary = {
      ...thread,
      title: titleOf(thread, text),
      preview: previewOf(text),
      updated: at,
    };
    return Server.commit({
      state: {
        chat: withTranscript(withThread(state.chat, updated), thread.id, {
          ...transcript,
          messages: [...transcript.messages, message],
        }),
        nextMessageId: state.nextMessageId + 1,
      },
      events: [
        ChatEvent.cases.Thread.make({ thread: updated }),
        ChatEvent.cases.Message.make({ threadId: thread.id, message }),
      ],
      result: { message },
    });
  });

const setStatus = (
  state: ServerState,
  payload: {
    readonly threadId: string;
    readonly running: boolean;
    readonly approvals: ReadonlyArray<Approval>;
  },
) =>
  Effect.gen(function* () {
    const thread = threadOf(state, payload.threadId);
    if (thread === undefined) return yield* Effect.fail({ reason: "That chat is gone." });
    const transcript = transcriptOfThread(state, thread.id);
    if (transcript.running === payload.running && same(transcript.approvals, payload.approvals))
      return Server.commit({ state, events: [], result: undefined });
    return Server.commit({
      state: {
        ...state,
        chat: withTranscript(state.chat, thread.id, {
          ...transcript,
          running: payload.running,
          approvals: payload.approvals,
        }),
      },
      events: [
        ChatEvent.cases.Status.make({
          threadId: thread.id,
          running: payload.running,
          approvals: payload.approvals,
        }),
      ],
      result: undefined,
    });
  });

const INTERNAL_ACTIONS: ReadonlySet<string> = new Set(["appendAgent", "setStatus"]);

export const makeWebChatServer = (env: Env): Server.Definition<typeof WebChat.spec, never> =>
  Server.make(WebChat, {
    principal: Schema.String,
    state: ServerState,
    initialize: initialize(env),
    snapshot: (state) => state.chat,
    authorize: ({ principal, operation }) =>
      Effect.suspend(() => {
        if (!Predicate.isTagged(operation, "action") && !Predicate.isTagged(operation, "result"))
          return Effect.void;
        const internalOnly = INTERNAL_ACTIONS.has(operation.action);
        if (internalOnly && principal !== INTERNAL_PRINCIPAL)
          return Effect.fail(
            new ProtocolError({ reason: "Forbidden", message: "That action is internal." }),
          );
        return Effect.void;
      }),
    actions: {
      create: ({ state, payload }) => create(state, payload),
      send: ({ state, payload }) => send(env, state, payload),
      stop: ({ state, payload }) => stop(env, state, payload),
      approve: ({ state, payload, principal }) => approve(env, principal, state, payload),
      rename: ({ state, payload }) => rename(state, payload),
      archive: ({ state, payload }) => archive(state, payload),
      refresh: ({ state, payload }) => refresh(env, state, payload),
      appendAgent: ({ state, payload }) => appendAgent(state, payload),
      setStatus: ({ state, payload }) => setStatus(state, payload),
    },
  });
