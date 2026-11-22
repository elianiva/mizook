import { AsyncData, Command, Subscription, Update } from "foldkit";
import { scrollIntoViewAfterPaint } from "foldkit/dom";
import { load, pushUrl, UrlRequest } from "foldkit/navigation";
import { toString as urlToString, type Url } from "foldkit/url";
import { Effect, Option, Schema } from "effect";
import {
  Dialog,
  Drawer,
  Input,
  Select,
  Textarea,
  syncUiState,
  specOf,
  Message as UiMessage,
  type UiRegistry,
} from "@mizook/ui";

import {
  archiveThread,
  approve,
  createThread,
  getBootstrap,
  getThread,
  renameThread,
  sendMessage,
  stopThread,
  type Bootstrap,
  type ThreadState,
  type ThreadSummary,
} from "./api.ts";
import { kit } from "./kit.ts";
import { Message } from "./message.ts";
import { Model } from "./model.ts";
import { AppRoute, routeHref, routeThread, urlToAppRoute } from "./route.ts";

export const Flags = Schema.Struct({ anchorId: Schema.String });
export type Flags = typeof Flags.Type;

const POLL_DELAY = "350 millis";

const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigation())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedNavigation],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedNavigation())),
});

const LoadBootstrap = Command.define("LoadBootstrap", {
  messages: [Message.LoadedBootstrap, Message.FailedBootstrap],
  execute: getBootstrap.pipe(
    Effect.map((data) => Message.LoadedBootstrap({ data })),
    Effect.catch((reason) => Effect.succeed(Message.FailedBootstrap({ reason }))),
  ),
});

const LoadThread = Command.define("LoadThread", {
  args: { threadId: Schema.String, after: Schema.Finite },
  messages: [Message.LoadedThread, Message.FailedThread],
  execute: ({ threadId, after }) =>
    getThread(threadId, after).pipe(
      Effect.map((state) => Message.LoadedThread({ threadId, state })),
      Effect.catch((reason) => Effect.succeed(Message.FailedThread({ threadId, reason }))),
    ),
});

const PollThread = Command.define("PollThread", {
  args: { threadId: Schema.String, after: Schema.Finite },
  messages: [Message.PolledThread, Message.FailedPoll],
  execute: ({ threadId, after }) =>
    Effect.sleep(POLL_DELAY).pipe(
      Effect.andThen(getThread(threadId, after)),
      Effect.map((state) => Message.PolledThread({ threadId, state })),
      Effect.catch((reason) => Effect.succeed(Message.FailedPoll({ threadId, reason }))),
    ),
});

const CreateThread = Command.define("CreateThread", {
  args: { agent: Schema.String, text: Schema.String, requestId: Schema.String },
  messages: [Message.CreatedThread, Message.FailedCreate],
  execute: ({ agent, text, requestId }) =>
    createThread(agent).pipe(
      Effect.map((thread) => Message.CreatedThread({ thread, text, requestId })),
      Effect.catch((reason) => Effect.succeed(Message.FailedCreate({ reason }))),
    ),
});

const SendMessage = Command.define("SendMessage", {
  args: { threadId: Schema.String, text: Schema.String, requestId: Schema.String },
  messages: [Message.SentMessage, Message.FailedSend],
  execute: ({ threadId, text, requestId }) =>
    sendMessage(threadId, text, requestId).pipe(
      Effect.map((result) => Message.SentMessage({ threadId, text, result })),
      Effect.catch((reason) => Effect.succeed(Message.FailedSend({ reason }))),
    ),
});

const StopThread = Command.define("StopThread", {
  args: { threadId: Schema.String },
  messages: [Message.Stopped, Message.FailedStop],
  execute: ({ threadId }) =>
    stopThread(threadId).pipe(
      Effect.map((ok) => Message.Stopped({ ok })),
      Effect.catch((reason) => Effect.succeed(Message.FailedStop({ reason }))),
    ),
});

const Approve = Command.define("Approve", {
  args: {
    threadId: Schema.String,
    approvalId: Schema.Finite,
    action: Schema.Literals(["approve", "always", "deny"]),
  },
  messages: [Message.Approved, Message.FailedApprove],
  execute: ({ threadId, approvalId, action }) =>
    approve(threadId, approvalId, action).pipe(
      Effect.map(() => Message.Approved({ ok: true })),
      Effect.catch((reason) => Effect.succeed(Message.FailedApprove({ reason }))),
    ),
});

const RenameThread = Command.define("RenameThread", {
  args: { threadId: Schema.String, title: Schema.String },
  messages: [Message.Renamed, Message.FailedRename],
  execute: ({ threadId, title }) =>
    renameThread(threadId, title).pipe(
      Effect.map((thread) => Message.Renamed({ thread })),
      Effect.catch((reason) => Effect.succeed(Message.FailedRename({ reason }))),
    ),
});

const ArchiveThread = Command.define("ArchiveThread", {
  args: { id: Schema.String },
  messages: [Message.Archived, Message.FailedArchive],
  execute: ({ id }) =>
    archiveThread(id).pipe(
      Effect.map(() => Message.Archived({ id })),
      Effect.catch((reason) => Effect.succeed(Message.FailedArchive({ reason }))),
    ),
});

const ScrollToBottom = Command.define("ScrollToBottom", {
  messages: [Message.CompletedScroll],
  execute: scrollIntoViewAfterPaint("#messages-end").pipe(
    Effect.as(Message.CompletedScroll()),
    Effect.catchCause(() => Effect.succeed(Message.CompletedScroll())),
  ),
});

const uiCommands = (commands: ReadonlyArray<ReturnType<typeof syncUiState>>) =>
  Command.mapMessages(commands, (message) => Message.GotUiMessage({ message }));

const uiChange = (
  model: Model,
  component: string,
  key: string,
  snapshot: Record<string, unknown>,
) => {
  const result = kit.update(
    model.ui,
    UiMessage.ChangedUiState({ component, key, snapshot, reason: "app" }),
  );
  return { ui: result.model, commands: uiCommands(result.commands) };
};

const clearComposer = (model: Model) => uiChange(model, "textarea", "composer", { value: "" });

const setAgent = (
  model: Model,
  items: ReadonlyArray<{ value: string; label: string }>,
  value: string,
) => {
  const next = Select.init({ key: "agent", items, value });
  const command = syncUiState({ specs: [specOf(Select.component, next)] });
  return {
    ui: { ...model.ui, agent: next },
    commands: uiCommands([command]),
  };
};

const setDrawer = (model: Model, open: boolean) => uiChange(model, "drawer", "drawer", { open });

const openRename = (model: Model, threadId: string, title: string) => {
  const opened = kit.update(
    model.ui,
    UiMessage.ChangedUiState({
      component: "dialog",
      key: "rename",
      snapshot: { open: true },
      reason: "open",
    }),
  );
  const filled = kit.update(
    opened.model,
    UiMessage.ChangedUiState({
      component: "input",
      key: "rename-input",
      snapshot: { value: title },
      reason: "open",
    }),
  );
  return {
    ui: filled.model,
    renameThreadId: Option.some(threadId),
    commands: [...uiCommands(opened.commands), ...uiCommands(filled.commands)],
  };
};

const closeRename = (model: Model) => {
  const closed = uiChange(model, "dialog", "rename", { open: false });
  return {
    ui: closed.ui,
    renameThreadId: Option.none<string>(),
    commands: closed.commands,
  };
};

const lastIdOf = (messages: ReadonlyArray<{ id: number }>): number =>
  messages.reduce((last, message) => Math.max(last, message.id), 0);

const mergeState = (current: ThreadState, incoming: ThreadState): ThreadState => {
  const seen = new Set(current.messages.map((message) => message.id));
  const added = incoming.messages.filter((message) => !seen.has(message.id));
  return {
    ...incoming,
    messages: [...current.messages, ...added],
  };
};

const activeThread = (model: Model): Option.Option<string> => routeThread(model.route);

const defaultAgent = (model: Model): string =>
  Option.match(AsyncData.getData(model.bootstrap), {
    onNone: () => "",
    onSome: (data) => model.ui.agent.value || data.defaultAgent.slug,
  });

export const init = (flags: Flags, url: Url) => {
  const route = urlToAppRoute(url);
  const model = Model.make({
    anchorId: flags.anchorId,
    route,
    bootstrap: AsyncData.Idle(),
    thread: AsyncData.Idle(),
    ui: {
      composer: Textarea.init({ key: "composer" }),
      agent: Select.init({ key: "agent", items: [], value: "" }),
      drawer: Drawer.init({ key: "drawer", described: false, side: "left" }),
      rename: Dialog.init({ key: "rename", described: false }),
      renameInput: Input.init({ key: "rename-input" }),
    },
    sending: false,
    stopping: false,
    notice: Option.none(),
    armedArchive: Option.none(),
    renameThreadId: Option.none(),
    pollAfter: 0,
  });
  const commands: Array<ReturnType<typeof LoadBootstrap> | ReturnType<typeof LoadThread>> = [
    LoadBootstrap(),
  ];
  Option.match(routeThread(route), {
    onNone: () => undefined,
    onSome: (threadId) => commands.push(LoadThread({ threadId, after: 0 })),
  });
  return { model, commands };
};

type UpdateReturn = Update.Return<Model, Message, UiRegistry>;

const sameRoute = (a: AppRoute, b: AppRoute): boolean =>
  AppRoute.match<boolean>(a, {
    Home: () => b._tag === "Home",
    Thread: ({ threadId }) => b._tag === "Thread" && b.threadId === threadId,
    NotFound: ({ path }) => b._tag === "NotFound" && b.path === path,
  });

const bootstrapWith = (
  data: AsyncData.AsyncData<Bootstrap, string>,
  change: (bootstrap: Bootstrap) => Bootstrap,
): AsyncData.AsyncData<Bootstrap, string> =>
  Option.match(AsyncData.getData(data), {
    onNone: () => data,
    onSome: (bootstrap) => AsyncData.Success({ data: change(bootstrap) }),
  });

const upsertThread = (bootstrap: Bootstrap, thread: ThreadSummary): Bootstrap => ({
  ...bootstrap,
  threads: [thread, ...bootstrap.threads.filter((existing) => existing.id !== thread.id)],
});

const threadStateWith = (
  thread: AsyncData.AsyncData<ThreadState, string>,
  change: (state: ThreadState) => ThreadState,
): AsyncData.AsyncData<ThreadState, string> =>
  Option.match(AsyncData.getData(thread), {
    onNone: () => thread,
    onSome: (state) => AsyncData.Success({ data: change(state) }),
  });

const withNotice = (model: Model, notice: string): Model => ({
  ...model,
  notice: Option.some(notice),
  armedArchive: Option.none(),
});

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => {
          const href = urlToString(url);
          return href.startsWith("/admin")
            ? { model, commands: [LoadExternal({ href })] }
            : { model, commands: [NavigateInternal({ url: href })] };
        },
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url);
      if (sameRoute(model.route, route)) return { model };
      const active = routeThread(route);
      if (Option.isNone(active))
        return {
          model: {
            ...model,
            route,
            thread: AsyncData.Idle(),
            pollAfter: 0,
            notice: Option.none(),
            armedArchive: Option.none(),
          },
        };
      const current = AsyncData.getData(model.thread);
      const loaded = Option.isSome(current) && current.value.thread.id === active.value;
      return {
        model: {
          ...model,
          route,
          thread: loaded ? model.thread : AsyncData.Idle(),
          pollAfter: loaded ? model.pollAfter : 0,
          notice: Option.none(),
          armedArchive: Option.none(),
        },
        commands: loaded ? [] : [LoadThread({ threadId: active.value, after: 0 })],
      };
    },

    CompletedNavigation: () => ({ model }),
    CompletedScroll: () => ({ model }),

    LoadedBootstrap: ({ data }) => {
      const bootstrap = AsyncData.Success({ data });
      const current = Option.match(AsyncData.getData(model.thread), {
        onNone: () => undefined,
        onSome: (state) => state.thread.agent.slug,
      });
      const agent = setAgent(
        { ...model, bootstrap },
        data.agents.map((entry) => ({ value: entry.slug, label: entry.name })),
        current ?? data.defaultAgent.slug,
      );
      return {
        model: { ...model, bootstrap, ui: agent.ui },
        commands: agent.commands,
      };
    },
    FailedBootstrap: ({ reason }) => ({
      model: { ...model, bootstrap: AsyncData.Failure({ error: reason }) },
    }),

    LoadedThread: ({ threadId, state }) =>
      Option.contains(activeThread(model), threadId)
        ? {
            model: {
              ...model,
              thread: AsyncData.Success({ data: state }),
              pollAfter: lastIdOf(state.messages),
              notice: Option.none(),
            },
            commands: state.running
              ? [PollThread({ threadId, after: lastIdOf(state.messages) }), ScrollToBottom()]
              : [ScrollToBottom()],
          }
        : { model },
    FailedThread: ({ threadId, reason }) =>
      Option.contains(activeThread(model), threadId)
        ? {
            model: {
              ...model,
              thread: AsyncData.Failure({ error: reason }),
            },
          }
        : { model },

    PolledThread: ({ threadId, state }) =>
      Option.match(AsyncData.getData(model.thread), {
        onNone: () => ({ model }),
        onSome: (current) => {
          if (current.thread.id !== threadId) return { model };
          const merged = mergeState(current, state);
          const after = lastIdOf(merged.messages);
          return {
            model: {
              ...model,
              thread: AsyncData.Success({ data: merged }),
              pollAfter: after,
            },
            commands: merged.running
              ? [PollThread({ threadId, after }), ScrollToBottom()]
              : [ScrollToBottom()],
          };
        },
      }),
    FailedPoll: ({ threadId, reason }) =>
      Option.contains(activeThread(model), threadId) &&
      Option.isSome(AsyncData.getData(model.thread))
        ? { model: withNotice(model, reason) }
        : { model },

    CreatedThread: ({ thread, text, requestId }) => {
      const route = AppRoute.Thread({ threadId: thread.id });
      const state: ThreadState = {
        thread,
        messages: [],
        running: false,
        approvals: [],
      };
      return {
        model: {
          ...model,
          route,
          thread: AsyncData.Success({ data: state }),
          sending: true,
          notice: Option.none(),
          pollAfter: 0,
          bootstrap: bootstrapWith(model.bootstrap, (data) => ({
            ...data,
            threads: [thread, ...data.threads],
          })),
        },
        commands: [
          NavigateInternal({ url: routeHref(route) }),
          SendMessage({ threadId: thread.id, text, requestId }),
        ],
      };
    },
    FailedCreate: ({ reason }) => ({
      model: { ...model, sending: false, notice: Option.some(reason) },
    }),

    SentMessage: ({ threadId, text, result }) => {
      const current = AsyncData.getData(model.thread);
      const base =
        Option.isSome(current) && current.value.thread.id === threadId
          ? current.value
          : { thread: result.thread, messages: [], running: true, approvals: [] };
      const seen = new Set(base.messages.map((entry) => entry.id));
      const messages = seen.has(result.messageId)
        ? base.messages
        : [...base.messages, { id: result.messageId, role: "user" as const, text, at: result.at }];
      const state: ThreadState = {
        ...base,
        thread: result.thread,
        messages,
        running: true,
      };
      const cleared = clearComposer({
        ...model,
        thread: AsyncData.Success({ data: state }),
        sending: false,
        pollAfter: result.messageId,
        notice: Option.none(),
        bootstrap: bootstrapWith(model.bootstrap, (data) => upsertThread(data, result.thread)),
      });
      return {
        model: {
          ...model,
          ui: cleared.ui,
          thread: AsyncData.Success({ data: state }),
          sending: false,
          pollAfter: result.messageId,
          notice: Option.none(),
          bootstrap: bootstrapWith(model.bootstrap, (data) => upsertThread(data, result.thread)),
        },
        commands: [
          ...cleared.commands,
          PollThread({ threadId, after: result.messageId }),
          ScrollToBottom(),
        ],
      };
    },
    FailedSend: ({ reason }) => ({
      model: { ...model, sending: false, notice: Option.some(reason) },
    }),

    Stopped: ({ ok }) => {
      const active = activeThread(model);
      return {
        model: {
          ...model,
          stopping: false,
          notice: Option.some(ok ? "Stopped." : "Nothing was running."),
        },
        commands: Option.isSome(active)
          ? [PollThread({ threadId: active.value, after: model.pollAfter })]
          : [],
      };
    },
    FailedStop: ({ reason }) => ({
      model: { ...model, stopping: false, notice: Option.some(reason) },
    }),

    Approved: ({ ok }) => {
      const active = activeThread(model);
      return {
        model: { ...model, notice: ok ? Option.none() : Option.some("That approval expired.") },
        commands: Option.isSome(active)
          ? [PollThread({ threadId: active.value, after: model.pollAfter })]
          : [],
      };
    },
    FailedApprove: ({ reason }) => ({ model: withNotice(model, reason) }),

    Renamed: ({ thread }) => {
      const closed = closeRename(model);
      return {
        model: {
          ...model,
          ui: closed.ui,
          renameThreadId: Option.none(),
          notice: Option.none(),
          bootstrap: bootstrapWith(model.bootstrap, (data) => upsertThread(data, thread)),
          thread: threadStateWith(model.thread, (state) =>
            state.thread.id === thread.id ? { ...state, thread } : state,
          ),
        },
        commands: closed.commands,
      };
    },
    FailedRename: ({ reason }) => ({ model: withNotice(model, reason) }),

    Archived: ({ id }) => {
      const active = activeThread(model);
      const wasActive = Option.contains(active, id);
      const route = AppRoute.Home();
      return {
        model: {
          ...model,
          route: wasActive ? route : model.route,
          thread: wasActive ? AsyncData.Idle() : model.thread,
          pollAfter: wasActive ? 0 : model.pollAfter,
          armedArchive: Option.none(),
          notice: Option.some("Chat archived."),
          bootstrap: bootstrapWith(model.bootstrap, (data) => ({
            ...data,
            threads: data.threads.filter((thread) => thread.id !== id),
          })),
        },
        commands: wasActive ? [NavigateInternal({ url: routeHref(route) })] : [],
      };
    },
    FailedArchive: ({ reason }) => ({ model: withNotice(model, reason) }),

    ClickedThread: ({ id }) => {
      const route = AppRoute.Thread({ threadId: id });
      const next: Model = {
        ...model,
        route,
        thread: AsyncData.Idle(),
        pollAfter: 0,
        notice: Option.none(),
        armedArchive: Option.none(),
      };
      const drawer = setDrawer(next, false);
      return {
        model: { ...next, ui: drawer.ui },
        commands: [
          NavigateInternal({ url: routeHref(route) }),
          LoadThread({ threadId: id, after: 0 }),
          ...drawer.commands,
        ],
      };
    },
    ClickedNewChat: () => {
      const route = AppRoute.Home();
      const next: Model = {
        ...model,
        route,
        thread: AsyncData.Idle(),
        pollAfter: 0,
        sending: false,
        stopping: false,
        notice: Option.none(),
        armedArchive: Option.none(),
        renameThreadId: Option.none(),
      };
      const cleared = clearComposer(next);
      const drawer = setDrawer({ ...next, ui: cleared.ui }, false);
      return {
        model: { ...next, ui: drawer.ui },
        commands: [
          NavigateInternal({ url: routeHref(route) }),
          ...cleared.commands,
          ...drawer.commands,
        ],
      };
    },

    ClickedSend: () => {
      const text = model.ui.composer.value.trim();
      if (text === "" || model.sending) return { model };
      const requestId = crypto.randomUUID();
      const active = activeThread(model);
      if (Option.isSome(active))
        return {
          model: { ...model, sending: true, notice: Option.none() },
          commands: [SendMessage({ threadId: active.value, text, requestId })],
        };
      if (model.route._tag !== "Home")
        return { model: withNotice(model, "That page is not a chat.") };
      const agent = defaultAgent(model);
      if (agent === "") return { model: withNotice(model, "Choose an agent first.") };
      return {
        model: { ...model, sending: true, notice: Option.none() },
        commands: [CreateThread({ agent, text, requestId })],
      };
    },

    ClickedStop: () => {
      const active = activeThread(model);
      const running = Option.match(AsyncData.getData(model.thread), {
        onNone: () => false,
        onSome: (state) => state.running,
      });
      if (Option.isNone(active) || !running) return { model };
      return {
        model: { ...model, stopping: true, notice: Option.none() },
        commands: [StopThread({ threadId: active.value })],
      };
    },

    ClickedRetry: () => {
      const active = activeThread(model);
      return {
        model: { ...model, notice: Option.none() },
        commands: Option.isSome(active)
          ? [LoadBootstrap(), LoadThread({ threadId: active.value, after: 0 })]
          : [LoadBootstrap()],
      };
    },

    ClickedRename: () =>
      Option.match(AsyncData.getData(model.thread), {
        onNone: () => ({ model }),
        onSome: (state) => {
          const opened = openRename(model, state.thread.id, state.thread.title);
          return {
            model: { ...model, ui: opened.ui, renameThreadId: opened.renameThreadId },
            commands: opened.commands,
          };
        },
      }),
    ClickedCloseRename: () => {
      const closed = closeRename(model);
      return {
        model: { ...model, ui: closed.ui, renameThreadId: Option.none() },
        commands: closed.commands,
      };
    },
    ClickedSaveRename: () => {
      const title = model.ui.renameInput.value.trim();
      if (Option.isNone(model.renameThreadId) || title === "")
        return { model: withNotice(model, "Give the chat a name.") };
      return {
        model: { ...model, notice: Option.none() },
        commands: [RenameThread({ threadId: model.renameThreadId.value, title })],
      };
    },

    ClickedArchive: () => {
      const active = activeThread(model);
      if (Option.isNone(active)) return { model };
      if (Option.contains(model.armedArchive, active.value))
        return {
          model: { ...model, armedArchive: Option.none(), notice: Option.none() },
          commands: [ArchiveThread({ id: active.value })],
        };
      return {
        model: {
          ...model,
          armedArchive: Option.some(active.value),
          notice: Option.some("Press Archive again to confirm."),
        },
      };
    },

    ClickedApprove: ({ approvalId, action }) => {
      const active = activeThread(model);
      if (Option.isNone(active)) return { model };
      return {
        model: { ...model, notice: Option.none() },
        commands: [Approve({ threadId: active.value, approvalId, action })],
      };
    },

    ClickedPrompt: ({ text }) => {
      const filled = uiChange(model, "textarea", "composer", { value: text });
      return {
        model: { ...model, ui: filled.ui, notice: Option.none() },
        commands: filled.commands,
      };
    },

    ClickedChoice: ({ text }) => {
      const filled = uiChange(model, "textarea", "composer", { value: text });
      const sent = update({ ...model, ui: filled.ui }, Message.ClickedSend());
      return { model: sent.model, commands: [...filled.commands, ...(sent.commands ?? [])] };
    },

    ClickedDismissNotice: () => ({
      model: { ...model, notice: Option.none(), armedArchive: Option.none() },
    }),

    GotUiMessage: ({ message: child }) => {
      const result = kit.update(model.ui, child);
      const renameClosed = model.ui.rename.open && !result.model.rename.open;
      return {
        model: {
          ...model,
          ui: result.model,
          ...(renameClosed ? { renameThreadId: Option.none() } : {}),
        },
        commands: uiCommands(result.commands),
      };
    },
  });

export const subscriptions = Subscription.make<Model, Message>()(() => ({}));
