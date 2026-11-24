import { AsyncData, Command, Subscription, Update } from "foldkit";
import { focus, scrollIntoViewAfterPaint, streamFromKeyBindings } from "foldkit/dom";
import { load, pushUrl, UrlRequest } from "foldkit/navigation";
import { toString as urlToString, type Url } from "foldkit/url";
import { Duration, Effect, Equal, Option, Predicate, Schedule, Schema, Stream } from "effect";
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
import { WebChat, type ChatState } from "@mizook/chat-sync";
import { swipeDrawer } from "@mizook/ui/swipe";

import { type Bootstrap, type ThreadState } from "./api.ts";
import { ChatSync } from "./sync.ts";
import { kit } from "./kit.ts";
import { Message } from "./message.ts";
import { Confirmation, isArmed } from "./confirmation.ts";
import { Model } from "./model.ts";
import { TurnState, turnMachine } from "./turn-machine.ts";
import { AppRoute, routeHref, routeThread, urlToAppRoute } from "./route.ts";

export const Flags = Schema.Struct({ anchorId: Schema.String });
export type Flags = typeof Flags.Type;

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

const describe = (error: unknown): string => {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "object" && error !== null) {
    if ("reason" in error && typeof error.reason === "string" && error.reason !== "")
      return error.reason;
    if ("message" in error && typeof error.message === "string" && error.message !== "")
      return error.message;
  }
  return "Something went wrong on my side.";
};

const SendMessage = Command.define("SendMessage", {
  args: {
    threadId: Schema.String,
    text: Schema.String,
    requestId: Schema.String,
    agent: Schema.optionalKey(Schema.String),
  },
  messages: [Message.SentMessage, Message.FailedSend],
  execute: ({ threadId, text, requestId, agent }) =>
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      if (agent !== undefined) yield* sync.submit(WebChat.actions.create, { id: threadId, agent });
      const command = yield* sync.submit(WebChat.actions.send, {
        threadId,
        text,
        requestId,
      });
      yield* command.awaitResult;
      return Message.SentMessage({ threadId, text });
    }).pipe(
      Effect.catch((error) => {
        return Effect.succeed(Message.FailedSend({ reason: describe(error), text, threadId }));
      }),
    ),
});

const StopThread = Command.define("StopThread", {
  args: { threadId: Schema.String },
  messages: [Message.Stopped, Message.FailedStop],
  execute: ({ threadId }) =>
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      const command = yield* sync.submit(WebChat.actions.stop, { threadId });
      const result = yield* command.awaitResult;
      return Message.Stopped({ ok: result.ok });
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedStop({ reason: describe(error) }))),
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
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      const command = yield* sync.submit(WebChat.actions.approve, {
        threadId,
        approvalId,
        action,
      });
      const result = yield* command.awaitResult;
      return Message.Approved({ ok: result.ok });
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedApprove({ reason: describe(error) }))),
    ),
});

const RenameThread = Command.define("RenameThread", {
  args: { threadId: Schema.String, title: Schema.String },
  messages: [Message.Renamed, Message.FailedRename],
  execute: ({ threadId, title }) =>
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      const command = yield* sync.submit(WebChat.actions.rename, { threadId, title });
      const result = yield* command.awaitResult;
      return Message.Renamed({ thread: result.thread });
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedRename({ reason: describe(error) }))),
    ),
});

const ArchiveThread = Command.define("ArchiveThread", {
  args: { id: Schema.String },
  messages: [Message.Archived, Message.FailedArchive],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      const command = yield* sync.submit(WebChat.actions.archive, { threadId: id });
      yield* command.awaitResult;
      return Message.Archived({ id });
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedArchive({ reason: describe(error) }))),
    ),
});

const RefreshThread = Command.define("RefreshThread", {
  args: { threadId: Schema.String },
  messages: [Message.Refreshed, Message.FailedRefresh],
  execute: ({ threadId }) =>
    Effect.gen(function* () {
      const sync = yield* ChatSync;
      const command = yield* sync.submit(WebChat.actions.refresh, { threadId });
      yield* command.awaitResult;
      return Message.Refreshed();
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedRefresh({ reason: describe(error) }))),
    ),
});

const RefreshAll = Command.define("RefreshAll", {
  messages: [Message.Refreshed, Message.FailedRefresh],
  execute: Effect.gen(function* () {
    const sync = yield* ChatSync;
    const command = yield* sync.submit(WebChat.actions.refresh, {});
    yield* command.awaitResult;
    return Message.Refreshed();
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedRefresh({ reason: describe(error) }))),
  ),
});

const Recover = Command.define("Recover", {
  messages: [Message.Recovered, Message.FailedRecover],
  execute: Effect.gen(function* () {
    const sync = yield* ChatSync;
    yield* sync.recover;
    return Message.Recovered();
  }).pipe(
    Effect.catch((error) => Effect.succeed(Message.FailedRecover({ reason: describe(error) }))),
  ),
});

const ScrollToBottom = Command.define("ScrollToBottom", {
  messages: [Message.CompletedScroll],
  // The newest message sits at the bottom, like a chat, with no empty runway.
  execute: scrollIntoViewAfterPaint("#messages-end", { block: "end" }).pipe(
    Effect.as(Message.CompletedScroll()),
    Effect.catchCause(() => Effect.succeed(Message.CompletedScroll())),
  ),
});

const COMPOSER = 'textarea[aria-label="Message"]';

/**
 * Puts the caret in the composer. A touch screen would raise its keyboard for
 * focus the user did not ask for, so `always` is for the moments they did:
 * they just sent or pressed the shortcut.
 */
const FocusComposer = Command.define("FocusComposer", {
  args: { always: Schema.Boolean },
  messages: [Message.CompletedFocus],
  execute: ({ always }) =>
    Effect.suspend(() =>
      always || window.matchMedia("(hover: hover) and (pointer: fine)").matches
        ? focus(COMPOSER)
        : Effect.void,
    ).pipe(
      Effect.as(Message.CompletedFocus()),
      Effect.orElseSucceed(() => Message.CompletedFocus()),
    ),
});

const BlurComposer = Command.define("BlurComposer", {
  messages: [Message.CompletedFocus],
  execute: Effect.sync(() => {
    const composer = document.querySelector(COMPOSER);
    if (composer instanceof HTMLElement) composer.blur();
    return Message.CompletedFocus();
  }),
});

/** After a send: a touch screen drops its keyboard, a desktop keeps typing. */
const settleComposer = (model: Model) =>
  model.touch ? BlurComposer() : FocusComposer({ always: true });

const COPIED_FOR = Duration.millis(1600);
const TOAST_FOR = Duration.seconds(3);
const ARMED_FOR = Duration.seconds(4);

const ExpireCopied = Command.define("ExpireCopied", {
  args: { id: Schema.Finite, count: Schema.Finite },
  messages: [Message.ExpiredCopied],
  execute: ({ id, count }) =>
    Effect.sleep(COPIED_FOR).pipe(Effect.as(Message.ExpiredCopied({ id, count }))),
});

const ExpireToast = Command.define("ExpireToast", {
  args: { text: Schema.String },
  messages: [Message.ExpiredToast],
  execute: ({ text }) => Effect.sleep(TOAST_FOR).pipe(Effect.as(Message.ExpiredToast({ text }))),
});

const ExpireArmed = Command.define("ExpireArmed", {
  args: { key: Schema.String },
  messages: [Message.ExpiredArmed],
  execute: ({ key }) => Effect.sleep(ARMED_FOR).pipe(Effect.as(Message.ExpiredArmed({ key }))),
});

const CopyText = Command.define("CopyText", {
  args: { id: Schema.Finite, text: Schema.String },
  messages: [Message.Copied, Message.FailedSend],
  execute: ({ id, text }) =>
    Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
      Effect.as(Message.Copied({ id })),
      Effect.orElseSucceed(() => Message.FailedSend({ reason: "Could not copy." })),
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

const activeThread = (model: Model): Option.Option<string> => routeThread(model.route);

const defaultAgent = (model: Model): string =>
  Option.match(AsyncData.getData(model.bootstrap), {
    onNone: () => "",
    onSome: (data) => model.ui.agent.value || data.defaultAgent.slug,
  });

const bootstrapOf = (chat: ChatState): Bootstrap => ({
  agents: chat.agents,
  threads: chat.threads.filter((thread) => !thread.archived),
  defaultAgent: chat.defaultAgent,
});

const threadStateOf = (chat: ChatState, threadId: string): Option.Option<ThreadState> => {
  const thread = chat.threads.find((candidate) => candidate.id === threadId);
  if (thread === undefined) return Option.none();
  const transcript = chat.transcripts[threadId] ?? {
    messages: [],
    running: false,
    approvals: [],
  };
  return Option.some({
    thread,
    messages: transcript.messages,
    running: transcript.running,
    approvals: transcript.approvals,
    ...(transcript.streaming !== undefined && { streaming: transcript.streaming }),
  });
};

const threadDataFor = (
  model: Model,
  chat: Option.Option<ChatState>,
): AsyncData.AsyncData<ThreadState, string> =>
  Option.match(activeThread(model), {
    onNone: () => AsyncData.Idle(),
    onSome: (threadId) =>
      Option.match(chat, {
        onNone: () => model.thread,
        onSome: (state) =>
          Option.match(threadStateOf(state, threadId), {
            onNone: () => AsyncData.Failure({ error: "That chat is gone." }),
            onSome: (data) => AsyncData.Success({ data }),
          }),
      }),
  });

const applyBootstrap = (
  model: Model,
  data: Bootstrap,
  thread: AsyncData.AsyncData<ThreadState, string>,
) => {
  const current = Option.match(AsyncData.getData(thread), {
    onNone: () => model.ui.agent.value,
    onSome: (state) => state.thread.agent.slug,
  });
  const wanted = current === "" ? data.defaultAgent.slug : current;
  const value = data.agents.some((agent) => agent.slug === wanted)
    ? wanted
    : data.defaultAgent.slug;
  const items = data.agents.map((agent) => ({ value: agent.slug, label: agent.name }));
  const sameItems =
    model.ui.agent.items.length === items.length &&
    model.ui.agent.items.every(
      (item, index) => item.value === items[index]?.value && item.label === items[index]?.label,
    );
  const next: Model = { ...model, bootstrap: AsyncData.Success({ data }) };
  if (sameItems && model.ui.agent.value === value) return { model: next, commands: [] };
  const agent = setAgent(next, items, value);
  return {
    model: { ...next, ui: agent.ui, bootstrap: AsyncData.Success({ data }) },
    commands: agent.commands,
  };
};

export const init = (flags: Flags, url: Url) => {
  const route = urlToAppRoute(url);
  const model = Model.make({
    anchorId: flags.anchorId,
    route,
    bootstrap: AsyncData.Idle(),
    thread: AsyncData.Idle(),
    chat: Option.none(),
    ui: {
      composer: Textarea.init({ key: "composer" }),
      agent: Select.init({ key: "agent", items: [], value: "" }),
      drawer: Drawer.init({ key: "drawer", described: false, side: "left" }),
      rename: Dialog.init({ key: "rename", described: false }),
      renameInput: Input.init({ key: "rename-input" }),
    },
    turn: turnMachine.initial,
    notice: Option.none(),
    offline: typeof navigator !== "undefined" && !navigator.onLine,
    touch: typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches,
    saved: false,
    armedArchive: Confirmation.Resting(),
    renameThreadId: Option.none(),
    copied: Option.none(),
    toast: Option.none(),
  });
  return { model, commands: [FocusComposer({ always: false })] };
};

type UpdateReturn = Update.Return<Model, Message, UiRegistry | ChatSync>;

const stepTurn = (model: Model, message: Message): TurnState =>
  turnMachine.transition(model.turn, message).model;

const withNotice = (model: Model, notice: string): Model => ({
  ...model,
  notice: Option.some(notice),
  armedArchive: Confirmation.Resting(),
});

/** A confirmation that is not an error: it shows for a moment and leaves by itself. */
const withToast = (model: Model, text: string) => ({
  model: { ...model, toast: Option.some(text) },
  commands: [ExpireToast({ text })],
});

/** Leaves an archived chat at once; the server's answer only matters if it refuses. */
const archivedNow = (model: Model, id: string) => {
  const active = activeThread(model);
  const wasActive = Option.contains(active, id);
  const route = AppRoute.Home();
  const toast = withToast(
    {
      ...model,
      route: wasActive ? route : model.route,
      thread: wasActive ? AsyncData.Idle() : model.thread,
      armedArchive: Confirmation.Resting(),
      notice: Option.none(),
    },
    "Chat archived.",
  );
  return {
    model: toast.model,
    commands: [
      ...toast.commands,
      ...(wasActive
        ? [NavigateInternal({ url: routeHref(route) }), FocusComposer({ always: false })]
        : []),
    ],
  };
};

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
      if (Equal.equals(model.route, route)) return { model };
      const thread = threadDataFor(model, model.chat);
      const next: Model = {
        ...model,
        route,
        thread,
        notice: Option.none(),
        armedArchive: Confirmation.Resting(),
      };
      const drawer = setDrawer(next, false);
      return { model: { ...next, ui: drawer.ui }, commands: drawer.commands };
    },

    CompletedNavigation: () => ({ model }),
    CompletedScroll: () => ({ model }),

    Synced: ({ view }) => {
      const notice = Option.isSome(view.error) ? view.error : model.notice;
      if (Option.isNone(view.state)) {
        return { model: { ...model, saved: false, notice } };
      }
      const chat = view.state.value;
      const bootstrap = bootstrapOf(chat);
      const thread = threadDataFor(model, view.state);
      const applied = applyBootstrap({ ...model, chat: view.state, thread }, bootstrap, thread);
      return {
        model: {
          ...applied.model,
          thread,
          chat: view.state,
          saved: view.saved,
          notice,
        },
        commands: applied.commands ?? [],
      };
    },

    RefreshTick: () => {
      const active = activeThread(model);
      const running = Option.match(AsyncData.getData(model.thread), {
        onNone: () => false,
        onSome: (state) => state.running,
      });
      return Option.isSome(active) && running
        ? { model, commands: [RefreshThread({ threadId: active.value })] }
        : { model };
    },
    Refreshed: () => ({ model }),
    FailedRefresh: () => ({ model }),
    Recovered: () => ({ model: { ...model, notice: Option.none() } }),
    FailedRecover: ({ reason }) => ({ model: withNotice(model, reason) }),

    WentOffline: () => ({ model: { ...model, offline: true } }),
    WentOnline: () => ({
      model: { ...model, offline: false },
      commands: [Recover(), RefreshAll()],
    }),

    SentMessage: ({ threadId }) => {
      const current = AsyncData.getData(model.thread);
      if (Option.isSome(current) && current.value.thread.id !== threadId) return { model };
      const turn = stepTurn(model, message);
      // The composer was cleared on press; a draft typed since must survive.
      return {
        model: { ...model, turn, notice: Option.none() },
        commands: [ScrollToBottom(), settleComposer(model)],
      };
    },
    FailedSend: ({ reason, text, threadId }) => {
      const turn = stepTurn(model, message);
      const next: Model = { ...model, turn, notice: Option.some(reason) };
      // Put the unsent text back, unless the user has moved on or started
      // something new.
      const sameThread = threadId === undefined || Option.contains(activeThread(model), threadId);
      if (text === undefined || !sameThread || model.ui.composer.value.trim() !== "")
        return { model: next };
      const restored = uiChange(next, "textarea", "composer", { value: text });
      return { model: { ...next, ui: restored.ui }, commands: restored.commands };
    },

    Stopped: ({ ok }) => {
      const toast = withToast(
        { ...model, turn: stepTurn(model, message), notice: Option.none() },
        ok ? "Stopped." : "Nothing was running.",
      );
      return {
        model: toast.model,
        commands: [...toast.commands, FocusComposer({ always: false })],
      };
    },
    FailedStop: ({ reason }) => ({
      model: { ...model, turn: stepTurn(model, message), notice: Option.some(reason) },
    }),

    Approved: ({ ok }) => ({
      model: { ...model, notice: ok ? Option.none() : Option.some("That approval expired.") },
    }),
    FailedApprove: ({ reason }) => ({ model: withNotice(model, reason) }),

    Renamed: () => ({ model }),
    FailedRename: ({ reason }) => ({ model: withNotice(model, reason) }),

    Archived: () => ({ model }),
    FailedArchive: ({ reason }) => ({ model: withNotice(model, reason) }),

    ClickedThread: ({ id }) => {
      const route = AppRoute.Thread({ threadId: id });
      const thread = threadDataFor({ ...model, route }, model.chat);
      const next: Model = {
        ...model,
        route,
        thread,
        notice: Option.none(),
        armedArchive: Confirmation.Resting(),
      };
      const drawer = setDrawer(next, false);
      return {
        model: { ...next, ui: drawer.ui },
        commands: [
          NavigateInternal({ url: routeHref(route) }),
          ...drawer.commands,
          ScrollToBottom(),
          FocusComposer({ always: false }),
        ],
      };
    },
    SwipedRight: () => {
      const drawer = setDrawer(model, true);
      return { model: { ...model, ui: drawer.ui }, commands: drawer.commands };
    },
    SwipedLeft: () => {
      const drawer = setDrawer(model, false);
      return { model: { ...model, ui: drawer.ui }, commands: drawer.commands };
    },

    ClickedNewChat: () => {
      const route = AppRoute.Home();
      const next: Model = {
        ...model,
        route,
        thread: AsyncData.Idle(),
        turn: stepTurn(model, message),
        notice: Option.none(),
        armedArchive: Confirmation.Resting(),
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
          FocusComposer({ always: false }),
        ],
      };
    },

    ClickedSend: () => {
      const text = model.ui.composer.value.trim();
      if (text === "" || !TurnState.guards.Idle(model.turn)) return { model };
      const requestId = crypto.randomUUID();
      const turn = stepTurn(model, message);
      // Clear on press, not on the server's answer: the message is already on its way.
      const cleared = clearComposer({ ...model, turn, notice: Option.none() });
      const writing: Model = { ...model, ui: cleared.ui, turn, notice: Option.none() };
      const active = activeThread(model);
      if (Option.isSome(active))
        return {
          model: writing,
          commands: [
            ...cleared.commands,
            SendMessage({ threadId: active.value, text, requestId }),
            settleComposer(model),
          ],
        };
      if (!Predicate.isTagged(model.route, "Home"))
        return { model: withNotice(model, "That page is not a chat.") };
      const agent = defaultAgent(model);
      if (agent === "") return { model: withNotice(model, "Choose an agent first.") };
      const threadId = crypto.randomUUID();
      const route = AppRoute.Thread({ threadId });
      return {
        model: {
          ...writing,
          route,
          thread: AsyncData.Idle(),
          armedArchive: Confirmation.Resting(),
        },
        commands: [
          ...cleared.commands,
          NavigateInternal({ url: routeHref(route) }),
          SendMessage({ threadId, text, requestId, agent }),
          settleComposer(model),
        ],
      };
    },

    ClickedStop: () => {
      const active = activeThread(model);
      const running = Option.match(AsyncData.getData(model.thread), {
        onNone: () => false,
        onSome: (state) => state.running,
      });
      if (Option.isNone(active) || !running || !TurnState.guards.Idle(model.turn)) return { model };
      return {
        model: { ...model, turn: stepTurn(model, message), notice: Option.none() },
        commands: [StopThread({ threadId: active.value })],
      };
    },

    ClickedRetry: () => ({
      model: { ...model, notice: Option.none() },
      commands: [Recover()],
    }),

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
      const closed = closeRename(model);
      return {
        model: { ...model, ui: closed.ui, renameThreadId: Option.none(), notice: Option.none() },
        commands: [
          ...closed.commands,
          RenameThread({ threadId: model.renameThreadId.value, title }),
        ],
      };
    },

    ClickedArchive: () => {
      const active = activeThread(model);
      if (Option.isNone(active)) return { model };
      if (isArmed(model.armedArchive, active.value)) {
        const gone = archivedNow(model, active.value);
        return {
          model: gone.model,
          commands: [...gone.commands, ArchiveThread({ id: active.value })],
        };
      }
      return {
        // The menu stays open and its item asks "sure?"; the question lapses by itself.
        model: { ...model, armedArchive: Confirmation.Armed({ key: active.value }) },
        commands: [ExpireArmed({ key: active.value })],
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

    ClickedChoice: ({ text }) => {
      const filled = uiChange(model, "textarea", "composer", { value: text });
      const sent = update({ ...model, ui: filled.ui }, Message.ClickedSend());
      return { model: sent.model, commands: [...filled.commands, ...(sent.commands ?? [])] };
    },

    ClickedLatest: () => ({ model, commands: [ScrollToBottom()] }),

    ClickedCopy: ({ id, text }) => ({ model, commands: [CopyText({ id, text })] }),

    Copied: ({ id }) => {
      // Pressing Copy again restarts the timer: only the newest press may end the state.
      const count = Option.match(model.copied, {
        onNone: () => 1,
        onSome: (copied) => (copied.id === id ? copied.count + 1 : 1),
      });
      return {
        model: { ...model, copied: Option.some({ id, count }) },
        commands: [ExpireCopied({ id, count })],
      };
    },
    ExpiredCopied: ({ id, count }) => ({
      model: Option.exists(model.copied, (copied) => copied.id === id && copied.count === count)
        ? { ...model, copied: Option.none() }
        : model,
    }),
    ExpiredToast: ({ text }) => ({
      model: Option.contains(model.toast, text) ? { ...model, toast: Option.none() } : model,
    }),
    ExpiredArmed: ({ key }) => ({
      model: isArmed(model.armedArchive, key)
        ? { ...model, armedArchive: Confirmation.Resting() }
        : model,
    }),
    PressedSlash: () => ({ model, commands: [FocusComposer({ always: true })] }),
    CompletedFocus: () => ({ model }),

    ClickedDismissNotice: () => ({
      model: { ...model, notice: Option.none(), armedArchive: Confirmation.Resting() },
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

export const subscriptions = Subscription.make<Model, Message, ChatSync>()((entry) => ({
  connection: Subscription.persistentEntry(
    Stream.merge(
      Stream.merge(
        Stream.fromEventListener(window, "online").pipe(Stream.map(() => Message.WentOnline())),
        Stream.fromEventListener(window, "offline").pipe(Stream.map(() => Message.WentOffline())),
      ),
      // Reopening the app fires no `online` event, yet the socket died while it was closed.
      Stream.fromEventListener(document, "visibilitychange").pipe(
        Stream.filter(() => document.visibilityState === "visible" && navigator.onLine),
        Stream.map(() => Message.WentOnline()),
      ),
    ),
  ),
  sync: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Stream.unwrap(
          Effect.map(ChatSync, (sync) =>
            sync.changes.pipe(Stream.map((view) => Message.Synced({ view }))),
          ),
        ),
    },
  ),
  keys: Subscription.persistentEntry(
    streamFromKeyBindings<Message>({
      bindings: [{ keys: "/", preventDefault: true, mapEvent: () => Message.PressedSlash() }],
    }),
  ),
  swipe: Subscription.persistentEntry(
    swipeDrawer<Message>({
      maxWidth: 767,
      width: (viewport) => Math.min(340, viewport * 0.9),
      open: () => Message.SwipedRight(),
      close: () => Message.SwipedLeft(),
    }),
  ),
  timer: Subscription.persistentEntry(
    Stream.fromEffectSchedule(Effect.succeed(Message.RefreshTick()), Schedule.spaced("2 seconds")),
  ),
}));
