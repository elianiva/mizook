import { Array, Option } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import type { Attribute } from "foldkit/html";
import {
  Dialog,
  Drawer,
  Input,
  Select,
  Textarea,
  Message as UiMessage,
  type PartsConfig,
} from "@mizook/ui";
import { cx } from "../styled-system/css";

import type { Approval, ChatMessage, ThreadState, ThreadSummary } from "./api.ts";
import { clock, previewText, timeAgo } from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { AppRoute, routeThread } from "./route.ts";
import { ui } from "./ui.ts";
import { renderMarkdown } from "./markdown.ts";

type H = HtmlBuilder<Message>;

const configOf = (model: Model): PartsConfig<Message> => ({
  toMessage: (message: UiMessage) => Message.GotUiMessage({ message }),
  anchor: model.anchorId,
});

const actionButton = (
  h: H,
  label: string,
  attributes: ReadonlyArray<Attribute<Message>>,
  variant?: "primary" | "danger",
  small = false,
) =>
  h.button(
    [
      h.Type("button"),
      h.Class(
        cx(
          ui.button,
          small ? ui.buttonSmall : undefined,
          variant === "primary" ? ui.buttonPrimary : undefined,
          variant === "danger" ? ui.buttonDanger : undefined,
        ),
      ),
      ...attributes,
    ],
    [label],
  );

const nativeButton = (
  h: H,
  label: string,
  message: Message,
  className: string,
  attributes: ReadonlyArray<Attribute<Message>> = [],
) => h.button([h.Type("button"), h.Class(className), h.OnClick(message), ...attributes], [label]);

const agentNameOf = (model: Model): string =>
  Option.match(AsyncData.getData(model.thread), {
    onNone: () =>
      Option.match(AsyncData.getData(model.bootstrap), {
        onNone: () => "Web",
        onSome: (data) => data.defaultAgent.name,
      }),
    onSome: (state) => state.thread.agent.name,
  });

const selectedAgentName = (model: Model): string => {
  const value = model.ui.agent.value;
  if (value === "") return "Choose an agent";
  return Select.labelOf(model.ui.agent, value) || value;
};

const headerTitle = (model: Model): string =>
  AppRoute.match<string>(model.route, {
    Home: () => "New chat",
    Thread: ({ threadId }) =>
      Option.match(AsyncData.getData(model.thread), {
        onNone: () => (threadId === "" ? "Chat" : "Loading"),
        onSome: (state) => state.thread.title,
      }),
    NotFound: () => "Not found",
  });

const threadButton = (model: Model, h: H, thread: ThreadSummary): Html => {
  const active = Option.contains(routeThread(model.route), thread.id);
  return h.button(
    [
      h.Key(thread.id),
      h.Type("button"),
      h.Class(cx(ui.thread, active ? ui.threadActive : undefined)),
      h.OnClick(Message.ClickedThread({ id: thread.id })),
    ],
    [
      h.span([h.Class(ui.threadTitle)], [thread.title]),
      h.span(
        [h.Class(ui.threadPreview)],
        [thread.preview === "" ? "No messages yet" : previewText(thread.preview)],
      ),
      h.span([h.Class(ui.threadTime)], [timeAgo(thread.updated)]),
    ],
  );
};

const sidebarBody = (model: Model, h: H, inDrawer: boolean): Html => {
  const threads = AsyncData.matchData(model.bootstrap, {
    onEmpty: () =>
      h.div(
        [h.Class(ui.threads)],
        Array.makeBy(4, (index) =>
          h.keyed("div")(
            String(index),
            [h.Class(ui.skeleton), h.Style({ margin: "8px 10px" })],
            [],
          ),
        ),
      ),
    onFailure: (error) =>
      h.div([h.Class(ui.threads)], [h.div([h.Class(ui.errorBox)], [h.span([], [error])])]),
    onData: (data) =>
      h.nav(
        [h.Class(ui.threads), h.AriaLabel("Chats")],
        data.threads.length === 0
          ? [
              h.div(
                [h.Class(ui.muted), h.Style({ padding: "8px 10px", fontSize: "12px" })],
                ["No chats yet."],
              ),
            ]
          : data.threads.map((thread) => threadButton(model, h, thread)),
      ),
  });
  return h.div(
    [h.Class(inDrawer ? ui.drawerSidebar : ui.sidebar)],
    [
      h.div(
        [h.Class(ui.sideTop)],
        [
          h.div(
            [h.Class(ui.brandRow)],
            [
              h.span([h.Class(ui.mark)], []),
              h.span(
                [h.Class(ui.brand)],
                [
                  "Mizook ",
                  h.span([h.Class(ui.slash)], ["/"]),
                  " ",
                  h.span([h.Class(ui.brandPlace)], ["Web"]),
                ],
              ),
            ],
          ),
          nativeButton(h, "New chat", Message.ClickedNewChat(), ui.newChat),
        ],
      ),
      h.div([h.Class(ui.sideLabel)], ["Recent"]),
      threads,
      h.div(
        [h.Class(ui.sideFoot)],
        [
          h.span([h.Class(ui.agentBadge)], [agentNameOf(model)]),
          h.a([h.Class(ui.adminLink), h.Href("/admin")], ["Admin"]),
        ],
      ),
    ],
  );
};

const noticeView = (model: Model, h: H): Html =>
  Option.match(model.notice, {
    onNone: () => null,
    onSome: (notice) =>
      h.div(
        [h.Class(ui.notice), h.Role("alert")],
        [
          h.span([], [notice]),
          h.button(
            [h.Type("button"), h.Class(ui.noticeButton), h.OnClick(Message.ClickedDismissNotice())],
            ["Dismiss"],
          ),
        ],
      ),
  });

const agentRoleLabel = (thread: ThreadSummary): string =>
  thread.agent.slug === "web" ? "Web" : thread.agent.name;

const messageView = (message: ChatMessage, h: H, agent: string): Html => {
  const user = message.role === "user";
  return h.article(
    [h.Key(String(message.id)), h.Class(ui.message)],
    [
      h.div(
        [h.Class(ui.meta)],
        [
          h.span([h.Class(cx(ui.roleMark, user ? ui.roleUser : ui.roleAgent))], []),
          h.span([], [user ? "You" : agent]),
          h.time(
            [h.Class(ui.time), h.Attribute("datetime", new Date(message.at).toISOString())],
            [clock(message.at)],
          ),
        ],
      ),
      h.div(
        [h.Class(cx(ui.body, user ? ui.bodyUser : ui.bodyAgent))],
        user
          ? [h.p([h.Class(ui.text)], [message.text])]
          : [h.div([h.Class(ui.markdown), h.InnerHTML(renderMarkdown(message.text))], [])],
      ),
    ],
  );
};

const approvalView = (h: H, approval: Approval): Html =>
  h.div(
    [h.Key(`approval-${approval.id}`), h.Class(ui.approval)],
    [
      h.div([h.Class(ui.approvalTitle)], ["Approval needed"]),
      h.div([h.Class(ui.approvalSummary)], [approval.summary]),
      h.div(
        [h.Class(ui.approvalActions)],
        [
          actionButton(
            h,
            "Approve",
            [h.OnClick(Message.ClickedApprove({ approvalId: approval.id, action: "approve" }))],
            "primary",
            true,
          ),
          ...(approval.match === ""
            ? []
            : [
                actionButton(
                  h,
                  "Always allow",
                  [
                    h.OnClick(
                      Message.ClickedApprove({ approvalId: approval.id, action: "always" }),
                    ),
                  ],
                  undefined,
                  true,
                ),
              ]),
          actionButton(
            h,
            "Deny",
            [h.OnClick(Message.ClickedApprove({ approvalId: approval.id, action: "deny" }))],
            "danger",
            true,
          ),
        ],
      ),
    ],
  );

const threadMessages = (state: ThreadState, h: H): Html =>
  h.section(
    [h.Class(ui.messages), h.Key("messages"), h.AriaLive("polite")],
    [
      h.div(
        [h.Class(ui.messagesInner)],
        [
          ...state.messages.map((message) => messageView(message, h, agentRoleLabel(state.thread))),
          ...state.approvals.map((approval) => approvalView(h, approval)),
          ...(state.running
            ? [
                h.div(
                  [h.Class(ui.working)],
                  [h.span([h.Class(ui.workingMark)], []), h.span([], ["Working"])],
                ),
              ]
            : []),
          h.div([h.Id("messages-end")], []),
        ],
      ),
    ],
  );

const emptyState = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const select = Select.parts(model.ui.agent, h, config);
  return h.section(
    [h.Class(ui.empty)],
    [
      h.div(
        [h.Class(ui.emptyInner)],
        [
          h.span([h.Class(ui.emptyMark)], []),
          h.h1([h.Class(ui.emptyTitle)], ["What are we doing?"]),
          h.div(
            [h.Class(ui.agentPicker)],
            [
              h.span([h.Class(ui.selectLabel)], ["Chat with"]),
              select.root(
                {},
                [h.Class(ui.selectRoot)],
                [
                  select.trigger(
                    {},
                    [h.Class(ui.selectTrigger)],
                    [
                      h.span([h.Class(ui.selectValue)], [selectedAgentName(model)]),
                      select.arrow({}, [h.Class(ui.selectArrow)], ["▾"]),
                    ],
                  ),
                  select.content(
                    {},
                    [h.Class(ui.selectContent)],
                    [
                      select.list(
                        {},
                        [],
                        model.ui.agent.items.map((item) =>
                          select.item(
                            { value: item.value, label: item.label },
                            [h.Class(ui.selectItem)],
                            [select["item-text"]({ text: item.label }, [], [item.label])],
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          h.div(
            [h.Class(ui.prompts)],
            [
              promptButton(h, "Compare the iPhone 17 Pro and Pixel 11 Pro cameras"),
              promptButton(h, "Read this page and summarize it: https://"),
              promptButton(h, "Chart my spending this month"),
            ],
          ),
        ],
      ),
    ],
  );
};

const promptButton = (h: H, text: string): Html =>
  h.button(
    [h.Type("button"), h.Class(ui.prompt), h.OnClick(Message.ClickedPrompt({ text }))],
    [h.span([], [text]), h.span([h.Class(ui.promptArrow)], ["→"])],
  );

const threadContent = (model: Model, h: H): Html =>
  AsyncData.matchData(model.thread, {
    onEmpty: () =>
      h.section(
        [h.Class(ui.messages)],
        [
          h.div(
            [h.Class(ui.messagesInner)],
            Array.makeBy(3, (index) =>
              h.keyed("div")(String(index), [h.Class(ui.skeletonBlock)], []),
            ),
          ),
        ],
      ),
    onFailure: (error) =>
      h.section(
        [h.Class(ui.messages)],
        [
          h.div(
            [h.Class(ui.messagesInner)],
            [
              h.div(
                [h.Class(ui.errorBox), h.Role("alert")],
                [
                  h.span([], [error]),
                  nativeButton(h, "Retry", Message.ClickedRetry(), cx(ui.button, ui.buttonSmall)),
                ],
              ),
            ],
          ),
        ],
      ),
    onData: (state) =>
      state.messages.length === 0 && !state.running
        ? h.section(
            [h.Class(ui.empty)],
            [
              h.div(
                [h.Class(ui.emptyInner)],
                [
                  h.span([h.Class(ui.emptyMark)], []),
                  h.h1([h.Class(ui.emptyTitle)], ["Start the conversation"]),
                ],
              ),
            ],
          )
        : threadMessages(state, h),
  });

const composer = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const textarea = Textarea.parts(model.ui.composer, h, config);
  const empty = model.ui.composer.value.trim() === "";
  const agent = agentNameOf(model);
  return h.div(
    [h.Class(ui.composer)],
    [
      h.div(
        [h.Class(ui.composerInner)],
        [
          noticeView(model, h),
          h.div(
            [h.Class(ui.composerBox)],
            [
              textarea.root({}, [
                h.Class(ui.textarea),
                h.Placeholder(`Message ${agent}`),
                h.AriaLabel("Message"),
                h.Rows(1),
                h.OnKeyDownPreventDefault((key, modifiers) =>
                  key === "Enter" &&
                  !modifiers.shiftKey &&
                  !modifiers.ctrlKey &&
                  !modifiers.metaKey &&
                  !modifiers.altKey
                    ? Option.some(Message.ClickedSend())
                    : Option.none(),
                ),
              ]),
              h.div(
                [h.Class(ui.composerFoot)],
                [
                  h.span([h.Class(ui.composerMeta)], [model.sending ? "Sending" : ""]),
                  h.span([h.Class(ui.spacer)], []),
                  actionButton(
                    h,
                    "Send",
                    [
                      h.AriaLabel("Send message"),
                      h.Disabled(empty || model.sending),
                      h.OnClick(Message.ClickedSend()),
                    ],
                    "primary",
                    true,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const header = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const drawer = Drawer.parts(model.ui.drawer, h, config);
  const state = AsyncData.getData(model.thread);
  const running = Option.match(state, { onNone: () => false, onSome: (value) => value.running });
  const hasThread = model.route._tag === "Thread";
  const armed = Option.match(state, {
    onNone: () => false,
    onSome: (value) => Option.contains(model.armedArchive, value.thread.id),
  });
  return h.header(
    [h.Class(ui.header)],
    [
      drawer.trigger(
        {},
        [h.Class(cx(ui.iconButton, ui.mobileOnly)), h.AriaLabel("Open chats")],
        [h.span([h.AriaHidden(true)], ["☰"])],
      ),
      h.span([h.Class(ui.headerTitle)], [headerTitle(model)]),
      h.span([h.Class(ui.headerBadge)], [agentNameOf(model)]),
      h.span([h.Class(ui.spacer)], []),
      ...(running
        ? [
            h.button(
              [
                h.Type("button"),
                h.Class(ui.stopButton),
                h.Disabled(model.stopping),
                h.OnClick(Message.ClickedStop()),
              ],
              [h.span([h.Class(ui.stopMark)], []), "Stop"],
            ),
          ]
        : []),
      ...(hasThread
        ? [
            h.div(
              [h.Class(ui.headerActions)],
              [
                nativeButton(h, "Rename", Message.ClickedRename(), ui.textButton),
                nativeButton(
                  h,
                  "Archive",
                  Message.ClickedArchive(),
                  cx(ui.textButton, armed ? ui.archiveArmed : undefined),
                ),
              ],
            ),
          ]
        : []),
    ],
  );
};

const drawerLayer = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const drawer = Drawer.parts(model.ui.drawer, h, config);
  return h.div(
    [],
    [
      drawer.backdrop({}, [h.Class(ui.drawerBackdrop)], []),
      drawer.viewport(
        {},
        [h.Class(ui.drawerViewport)],
        [
          drawer.content(
            {},
            [h.Class(ui.drawerContent)],
            [
              drawer.title({}, [h.Class(ui.srOnly)], ["Chats"]),
              drawer.close({}, [h.Class(ui.drawerClose), h.AriaLabel("Close chats")], ["×"]),
              sidebarBody(model, h, true),
            ],
          ),
        ],
      ),
    ],
  );
};

const renameDialog = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const dialog = Dialog.parts(model.ui.rename, h, config);
  const input = Input.parts(model.ui.renameInput, h, config);
  return h.div(
    [],
    [
      dialog.backdrop({}, [h.Class(ui.dialogBackdrop)], []),
      dialog.content(
        {},
        [h.Class(ui.dialogContent)],
        [
          dialog.title({}, [h.Class(ui.dialogTitle)], ["Rename chat"]),
          input.root(
            {},
            [h.Class(ui.input), h.Placeholder("Chat name"), h.AriaLabel("Chat name")],
            [],
          ),
          h.div(
            [h.Class(ui.dialogActions)],
            [
              nativeButton(
                h,
                "Cancel",
                Message.ClickedCloseRename(),
                cx(ui.button, ui.buttonSmall),
              ),
              actionButton(
                h,
                "Save",
                [
                  h.Disabled(model.ui.renameInput.value.trim() === ""),
                  h.OnClick(Message.ClickedSaveRename()),
                ],
                "primary",
                true,
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

export const view = (model: Model, h: H): Document => {
  const config = configOf(model);
  const content =
    model.route._tag === "Home"
      ? emptyState(model, h, config)
      : model.route._tag === "Thread"
        ? threadContent(model, h)
        : h.section(
            [h.Class(ui.empty)],
            [
              h.div(
                [h.Class(ui.emptyInner)],
                [
                  h.span([h.Class(ui.emptyMark)], []),
                  h.h1([h.Class(ui.emptyTitle)], ["That page is not a chat"]),
                  h.div(
                    [h.Class(ui.prompts)],
                    [
                      nativeButton(
                        h,
                        "New chat",
                        Message.ClickedNewChat(),
                        cx(ui.button, ui.buttonSmall),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          );
  return {
    title: "Mizook",
    body: h.div(
      [h.Class(ui.root)],
      [
        sidebarBody(model, h, false),
        h.main([h.Class(ui.main)], [header(model, h, config), content, composer(model, h, config)]),
        drawerLayer(model, h, config),
        renameDialog(model, h, config),
      ],
    ),
  };
};
