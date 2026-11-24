import * as Action from "@yielded/sync/Action";
import * as Source from "@yielded/sync/Source";
import { definition } from "@yielded/sync/client/Client";
import { Schema } from "effect";

export const Agent = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  isDefault: Schema.Boolean,
  isWebDefault: Schema.Boolean,
});
export type Agent = typeof Agent.Type;

export const DefaultAgent = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
});
export type DefaultAgent = typeof DefaultAgent.Type;

export const ThreadAgent = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
});
export type ThreadAgent = typeof ThreadAgent.Type;

export const ThreadSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  preview: Schema.String,
  created: Schema.Finite,
  updated: Schema.Finite,
  agent: ThreadAgent,
  archived: Schema.Boolean,
});
export type ThreadSummary = typeof ThreadSummary.Type;

/**
 * One step of an agent's turn, in the order the agent took it: what it thought,
 * what it ran, what it wrote. A web turn shows all three as they happen.
 */
export const ChatPart = Schema.TaggedUnion({
  Thinking: { text: Schema.String },
  Text: { text: Schema.String },
  Tool: {
    id: Schema.String,
    name: Schema.String,
    /** The program an `execute` call runs, or the call's arguments as JSON. */
    input: Schema.String,
    /** Absent while the call runs. */
    output: Schema.optionalKey(Schema.String),
    failed: Schema.optionalKey(Schema.Boolean),
  },
});
export type ChatPart = typeof ChatPart.Type;

export const ChatMessage = Schema.Struct({
  id: Schema.Finite,
  role: Schema.Literals(["user", "agent"]),
  /** For an agent message with `parts`, the text parts joined. */
  text: Schema.String,
  at: Schema.Finite,
  requestId: Schema.optionalKey(Schema.String),
  parts: Schema.optionalKey(Schema.Array(ChatPart)),
});
export type ChatMessage = typeof ChatMessage.Type;

export const Approval = Schema.Struct({
  id: Schema.Finite,
  summary: Schema.String,
  match: Schema.String,
  created: Schema.Finite,
});
export type Approval = typeof Approval.Type;

export const ThreadTranscript = Schema.Struct({
  messages: Schema.Array(ChatMessage),
  running: Schema.Boolean,
  approvals: Schema.Array(Approval),
  /** The turn in progress, as far as it has got. Gone once the turn's message lands. */
  live: Schema.optionalKey(Schema.Array(ChatPart)),
});
export type ThreadTranscript = typeof ThreadTranscript.Type;

export const ChatState = Schema.Struct({
  agents: Schema.Array(Agent),
  threads: Schema.Array(ThreadSummary),
  defaultAgent: DefaultAgent,
  transcripts: Schema.Record(Schema.String, ThreadTranscript),
});
export type ChatState = typeof ChatState.Type;

/** The home view of the chat. Archived threads stay out of the sidebar. */
export const Bootstrap = Schema.Struct({
  agents: Schema.Array(Agent),
  threads: Schema.Array(ThreadSummary),
  defaultAgent: DefaultAgent,
});
export type Bootstrap = typeof Bootstrap.Type;

/** One open thread, as the message view renders it. */
export const ThreadState = Schema.Struct({
  thread: ThreadSummary,
  messages: Schema.Array(ChatMessage),
  running: Schema.Boolean,
  approvals: Schema.Array(Approval),
  live: Schema.optionalKey(Schema.Array(ChatPart)),
});
export type ThreadState = typeof ThreadState.Type;

export const ChatEvent = Schema.TaggedUnion({
  Thread: { thread: ThreadSummary },
  Message: { threadId: Schema.String, message: ChatMessage },
  Status: { threadId: Schema.String, running: Schema.Boolean, approvals: Schema.Array(Approval) },
  Live: { threadId: Schema.String, parts: Schema.Array(ChatPart) },
  Agents: { agents: Schema.Array(Agent), defaultAgent: DefaultAgent },
});
export type ChatEvent = typeof ChatEvent.Type;

const ActionError = Schema.Struct({ reason: Schema.String });
export type ActionError = typeof ActionError.Type;

const CreateThread = Action.make("create", {
  payload: Schema.Struct({ id: Schema.String, agent: Schema.optionalKey(Schema.String) }),
  success: Schema.Struct({ thread: ThreadSummary }),
  error: ActionError,
});

const SendMessage = Action.make("send", {
  payload: Schema.Struct({
    threadId: Schema.String,
    text: Schema.String,
    requestId: Schema.String,
  }),
  success: Schema.Struct({ message: ChatMessage }),
  error: ActionError,
});

const StopTurn = Action.make("stop", {
  payload: Schema.Struct({ threadId: Schema.String }),
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: ActionError,
});

const Approve = Action.make("approve", {
  payload: Schema.Struct({
    threadId: Schema.String,
    approvalId: Schema.Finite,
    action: Schema.Literals(["approve", "always", "deny"]),
  }),
  success: Schema.Struct({ ok: Schema.Boolean }),
  error: ActionError,
});

const RenameThread = Action.make("rename", {
  payload: Schema.Struct({ threadId: Schema.String, title: Schema.String }),
  success: Schema.Struct({ thread: ThreadSummary }),
  error: ActionError,
});

/** A generated title, applied only while the thread still wears the old one. */
const AutoTitleThread = Action.make("autoTitle", {
  payload: Schema.Struct({
    threadId: Schema.String,
    title: Schema.String,
    from: Schema.String,
  }),
  success: Schema.Struct({ thread: ThreadSummary }),
  error: ActionError,
});

const ArchiveThread = Action.make("archive", {
  payload: Schema.Struct({ threadId: Schema.String }),
  success: Schema.Void,
  error: ActionError,
});

const Refresh = Action.make("refresh", {
  payload: Schema.Struct({ threadId: Schema.optionalKey(Schema.String) }),
  success: Schema.Void,
  error: ActionError,
});

const AppendAgentMessage = Action.make("appendAgent", {
  payload: Schema.Struct({
    threadId: Schema.String,
    text: Schema.String,
    parts: Schema.optionalKey(Schema.Array(ChatPart)),
  }),
  success: Schema.Struct({ message: ChatMessage }),
  error: ActionError,
});

/** The turn in progress. An empty list clears it. */
const SetLive = Action.make("setLive", {
  payload: Schema.Struct({ threadId: Schema.String, parts: Schema.Array(ChatPart) }),
  success: Schema.Void,
  error: ActionError,
});

const SetStatus = Action.make("setStatus", {
  payload: Schema.Struct({
    threadId: Schema.String,
    running: Schema.Boolean,
    approvals: Schema.Array(Approval),
  }),
  success: Schema.Void,
  error: ActionError,
});

export const WebChat = Source.make({
  kind: "web-chat",
  path: "/c/sync/web-chat",
  schemaVersion: 1,
  snapshot: ChatState,
  event: ChatEvent,
  actions: [
    CreateThread,
    SendMessage,
    StopTurn,
    Approve,
    RenameThread,
    AutoTitleThread,
    ArchiveThread,
    Refresh,
    AppendAgentMessage,
    SetStatus,
    SetLive,
  ],
});

export const WebChatSource = "main";

export const emptyTranscript: ThreadTranscript = { messages: [], running: false, approvals: [] };

export const previewOf = (text: string): string =>
  text
    .replace(/(```|~~~)openui-lang\b[\s\S]*?(\1|$)/g, (block) => {
      const names = [...block.matchAll(/^\s*\w+\s*=\s*([A-Z]\w*)\(/gm)].map((match) => match[1]);
      return ` ${names.find((name) => name !== "Stack") ?? ""} `;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

export const titleOf = (thread: ThreadSummary, text: string): string => {
  const preview = previewOf(text);
  return thread.title === "New chat" && preview !== "" ? preview.slice(0, 60) : thread.title;
};

const asThread = (thread: ThreadSummary, changes: Partial<ThreadSummary>): ThreadSummary => ({
  ...thread,
  ...changes,
});

export const withThread = (state: ChatState, thread: ThreadSummary): ChatState => ({
  ...state,
  threads: [thread, ...state.threads.filter((existing) => existing.id !== thread.id)],
  transcripts: {
    ...state.transcripts,
    [thread.id]: state.transcripts[thread.id] ?? emptyTranscript,
  },
});

export const withTranscript = (
  state: ChatState,
  threadId: string,
  transcript: ThreadTranscript,
): ChatState => ({
  ...state,
  transcripts: { ...state.transcripts, [threadId]: transcript },
});

export const withLive = (
  transcript: ThreadTranscript,
  parts: ReadonlyArray<ChatPart>,
): ThreadTranscript => {
  const { live: _gone, ...rest } = transcript;
  return parts.length === 0 ? rest : { ...rest, live: parts };
};

export const applyEvent = (state: ChatState, event: ChatEvent): ChatState =>
  ChatEvent.match(event, {
    Thread: ({ thread }) => withThread(state, thread),
    Message: ({ threadId, message }) => {
      const transcript = state.transcripts[threadId] ?? emptyTranscript;
      if (transcript.messages.some((existing) => existing.id === message.id)) return state;
      // An agent's message is the turn's result, so the live view of it is done.
      const next = { ...transcript, messages: [...transcript.messages, message] };
      return withTranscript(state, threadId, message.role === "agent" ? withLive(next, []) : next);
    },
    Live: ({ threadId, parts }) =>
      withTranscript(
        state,
        threadId,
        withLive(state.transcripts[threadId] ?? emptyTranscript, parts),
      ),
    Status: ({ threadId, running, approvals }) =>
      withTranscript(state, threadId, {
        ...(state.transcripts[threadId] ?? emptyTranscript),
        running,
        approvals,
      }),
    Agents: ({ agents, defaultAgent }) => ({ ...state, agents, defaultAgent }),
  });

const optimistic = {
  create: (state: ChatState, payload: { readonly id: string; readonly agent?: string }) => {
    if (state.threads.some((thread) => thread.id === payload.id)) return state;
    const agent =
      state.agents.find((candidate) => candidate.slug === payload.agent) ??
      state.agents.find((candidate) => candidate.slug === state.defaultAgent.slug) ??
      state.agents[0];
    if (agent === undefined) return state;
    const at = Date.now();
    return withThread(state, {
      id: payload.id,
      title: "New chat",
      preview: "",
      created: at,
      updated: at,
      agent: { id: agent.id, slug: agent.slug, name: agent.name },
      archived: false,
    });
  },
  send: (
    state: ChatState,
    payload: { readonly threadId: string; readonly text: string; readonly requestId: string },
  ) => {
    const thread = state.threads.find((candidate) => candidate.id === payload.threadId);
    if (thread === undefined) return state;
    const transcript = state.transcripts[thread.id] ?? emptyTranscript;
    const at = Date.now();
    const message: ChatMessage = {
      id: -at,
      role: "user",
      text: payload.text,
      at,
      requestId: payload.requestId,
    };
    const updated = asThread(thread, {
      title: titleOf(thread, payload.text),
      preview: previewOf(payload.text),
      updated: at,
    });
    return withTranscript(withThread(state, updated), thread.id, {
      ...transcript,
      messages: [...transcript.messages, message],
      running: true,
    });
  },
  stop: (state: ChatState, payload: { readonly threadId: string }) => {
    const transcript = state.transcripts[payload.threadId];
    if (transcript === undefined || !transcript.running) return state;
    return withTranscript(state, payload.threadId, { ...transcript, running: false });
  },
  approve: (
    state: ChatState,
    payload: { readonly threadId: string; readonly approvalId: number },
  ) => {
    const transcript = state.transcripts[payload.threadId];
    if (transcript === undefined) return state;
    return withTranscript(state, payload.threadId, {
      ...transcript,
      approvals: transcript.approvals.filter((approval) => approval.id !== payload.approvalId),
    });
  },
  rename: (state: ChatState, payload: { readonly threadId: string; readonly title: string }) => {
    const thread = state.threads.find((candidate) => candidate.id === payload.threadId);
    if (thread === undefined) return state;
    return withThread(state, asThread(thread, { title: payload.title, updated: Date.now() }));
  },
  autoTitle: (
    state: ChatState,
    payload: { readonly threadId: string; readonly title: string; readonly from: string },
  ) => {
    const thread = state.threads.find((candidate) => candidate.id === payload.threadId);
    if (thread === undefined || thread.title !== payload.from) return state;
    return withThread(state, asThread(thread, { title: payload.title, updated: Date.now() }));
  },
  archive: (state: ChatState, payload: { readonly threadId: string }) => {
    const thread = state.threads.find((candidate) => candidate.id === payload.threadId);
    if (thread === undefined) return state;
    return withThread(state, asThread(thread, { archived: true, updated: Date.now() }));
  },
} as const;

export const WebChatClient = definition(WebChat, { applyEvent, optimistic });
