import { Array, Option, Predicate } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import type { Attribute } from "foldkit/html";
import type { GlyphName } from "@mizook/design/icons";
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
import { button } from "../styled-system/recipes";

import type { Approval, ChatMessage, ThreadState, ThreadSummary } from "./api.ts";
import { clock, dayGroup, previewText, timeAgo } from "./format.ts";
import { icon } from "./icon.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { isArmed } from "./confirmation.ts";
import { TurnState } from "./turn-machine.ts";
import { AppRoute, routeThread } from "./route.ts";
import { ui } from "./ui.ts";
import { type Block, type Segment, segmentsOf } from "./generative.ts";
import { FollowLatest } from "./follow-latest.ts";
import { StreamMarkdown } from "./stream-markdown.ts";

type H = HtmlBuilder<Message>;

const configOf = (model: Model): PartsConfig<Message> => ({
  toMessage: (message: UiMessage) => Message.GotUiMessage({ message }),
  anchor: model.anchorId,
});

type Tone = "primary" | "line" | "ghost" | "danger";

/** A square icon button. The label is its accessible name and its tooltip. */
const iconButton = (
  h: H,
  glyph: GlyphName,
  label: string,
  message: Message,
  tone: Tone = "ghost",
  attributes: ReadonlyArray<Attribute<Message>> = [],
  size: "icon" | "iconSm" = "icon",
) =>
  h.button(
    [
      h.Type("button"),
      h.Class(button({ tone, size })),
      h.AriaLabel(label),
      h.Title(label),
      h.OnClick(message),
      ...attributes,
    ],
    [icon(h, glyph, size === "icon" ? 20 : 16)],
  );

/** A button with an icon and a short word, for the few places a word must stay. */
const labelButton = (
  h: H,
  glyph: GlyphName,
  label: string,
  message: Message,
  tone: Tone = "line",
  attributes: ReadonlyArray<Attribute<Message>> = [],
) =>
  h.button(
    [h.Type("button"), h.Class(button({ tone, size: "sm" })), h.OnClick(message), ...attributes],
    [icon(h, glyph, 16), label],
  );

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
  if (value === "") return "Agent";
  return Select.labelOf(model.ui.agent, value) || value;
};

const headerTitle = (model: Model): string =>
  AppRoute.match<string>(model.route, {
    Home: () => "New thread",
    Thread: () =>
      Option.match(AsyncData.getData(model.thread), {
        onNone: () => "Thread",
        onSome: (state) => state.thread.title,
      }),
    NotFound: () => "Not found",
  });

const threadButton = (model: Model, h: H, thread: ThreadSummary, webDefault: string): Html => {
  const active = Option.contains(routeThread(model.route), thread.id);
  return h.button(
    [
      h.Key(thread.id),
      h.Type("button"),
      h.Class(ui.thread),
      h.Attribute("aria-current", active ? "true" : "false"),
      h.OnClick(Message.ClickedThread({ id: thread.id })),
    ],
    [
      h.span(
        [h.Class(ui.threadTop)],
        [
          h.span([h.Class(ui.threadTitle)], [thread.title]),
          h.span([h.Class(ui.threadTime)], [timeAgo(thread.updated)]),
        ],
      ),
      h.span(
        [h.Class(ui.threadPreview)],
        [
          ...(thread.agent.slug === webDefault
            ? []
            : [h.span([h.Class(ui.threadAgent)], [`/${thread.agent.slug}`])]),
          thread.preview === "" ? "—" : previewText(thread.preview),
        ],
      ),
    ],
  );
};

const threadGroups = (
  model: Model,
  h: H,
  threads: ReadonlyArray<ThreadSummary>,
  webDefault: string,
): ReadonlyArray<Html> => {
  const groups = Array.groupBy(threads, (thread) => dayGroup(thread.updated));
  return (["Today", "Yesterday", "Earlier"] as const).flatMap((name) => {
    const rows = groups[name];
    return rows === undefined
      ? []
      : [
          h.keyed("div")(
            name,
            [h.Class(ui.threadGroup)],
            [
              h.div([h.Class(ui.sideLabel)], [name]),
              ...rows.map((thread) => threadButton(model, h, thread, webDefault)),
            ],
          ),
        ];
  });
};

const sidebarBody = (model: Model, h: H, inDrawer: boolean): Html => {
  const threads = AsyncData.matchData(model.bootstrap, {
    onEmpty: () => h.nav([h.Class(ui.threads), h.AriaLabel("Threads")], []),
    onFailure: (error) =>
      h.div([h.Class(ui.threads)], [h.div([h.Class(ui.sideError)], [icon(h, "alert", 16), error])]),
    onData: (data) => {
      const webDefault = data.agents.find((agent) => agent.isWebDefault)?.slug ?? "web";
      return h.nav(
        [h.Class(ui.threads), h.AriaLabel("Threads")],
        data.threads.length === 0
          ? [h.div([h.Class(ui.sideEmpty)], [icon(h, "thread", 28)])]
          : threadGroups(model, h, data.threads, webDefault),
      );
    },
  });
  return h.div(
    [h.Class(inDrawer ? ui.drawerSidebar : ui.sidebar)],
    [
      h.div(
        [h.Class(ui.sideTop)],
        [
          h.div(
            [h.Class(ui.brandRow)],
            [h.span([h.Class(ui.mark)], []), h.span([h.Class(ui.brand)], ["Mizook"])],
          ),
          h.button(
            [
              h.Type("button"),
              h.Class(cx(button({ tone: "ghost", size: "md" }), ui.newThread)),
              h.OnClick(Message.ClickedNewChat()),
              h.AriaLabel("New thread"),
              h.Title("New thread"),
            ],
            [icon(h, "plus", 22)],
          ),
        ],
      ),
      threads,
      h.div(
        [h.Class(ui.sideFoot)],
        [
          h.span([h.Class(ui.sideAgent)], [icon(h, "bot", 16), agentNameOf(model)]),
          h.a(
            [
              h.Class(ui.sideLink),
              h.Href("/admin"),
              h.AriaLabel("Dashboard"),
              h.Title("Dashboard"),
            ],
            [icon(h, "grid", 18)],
          ),
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
          icon(h, "alert", 18),
          h.span([h.Class(ui.noticeText)], [notice]),
          iconButton(h, "close", "Dismiss", Message.ClickedDismissNotice(), "ghost", [], "iconSm"),
        ],
      ),
  });

const savedText = (model: Model): string | undefined => {
  const hasData = Predicate.isTagged(model.route, "Home")
    ? Option.isSome(AsyncData.getData(model.bootstrap))
    : Predicate.isTagged(model.route, "Thread")
      ? Option.isSome(AsyncData.getData(model.thread))
      : false;
  const messages = Predicate.isTagged(model.route, "Thread");
  if (model.offline) {
    if (!hasData) return "Offline";
    return messages ? "Offline · saved messages" : "Offline · saved threads";
  }
  return model.saved && hasData ? (messages ? "Saved messages" : "Saved threads") : undefined;
};

const savedBar = (model: Model, h: H): Html => {
  const text = savedText(model);
  if (text === undefined) return null;
  return h.div(
    [h.Class(ui.savedBar), h.Role("status")],
    [
      icon(h, model.offline ? "alert" : "save", 14),
      h.span([h.Class(ui.spacer)], [text]),
      ...(model.offline
        ? []
        : [
            h.button(
              [
                h.Type("button"),
                h.Class(button({ tone: "ghost", size: "iconSm" })),
                h.AriaLabel("Retry"),
                h.Title("Retry"),
                h.OnClick(Message.ClickedRetry()),
              ],
              [icon(h, "refresh", 16)],
            ),
          ]),
    ],
  );
};

const agentRoleLabel = (thread: ThreadSummary): string =>
  thread.agent.slug === "web" ? "Web" : thread.agent.name;

const hostOf = (url: string): string => new URL(url).hostname.replace(/^www\./, "");

const TREND_GLYPH = { up: "↑ ", down: "↓ ", flat: "→ " } as const;

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

const titled = (h: H, title: string | undefined, body: Html): Html =>
  title === undefined || title === ""
    ? body
    : h.section([], [h.h3([h.Class(ui.blockTitle)], [title]), body]);

/** One catalog component. Every text is a child node, so nothing in the JSON becomes markup. */
const blockView = (h: H, { type, props: block }: Block): Html => {
  switch (type) {
    case "Metrics":
      return h.div(
        [h.Class(ui.metrics)],
        block.items.map((item) =>
          h.div(
            [h.Class(ui.metric)],
            [
              h.span([h.Class(ui.metricLabel)], [item.label]),
              h.span([h.Class(ui.metricValue)], [item.value]),
              ...(item.delta === undefined || item.delta === ""
                ? []
                : [
                    h.span(
                      [h.Class(ui.metricDelta(item.good === undefined ? {} : { good: item.good }))],
                      [`${item.trend === undefined ? "" : TREND_GLYPH[item.trend]}${item.delta}`],
                    ),
                  ]),
            ],
          ),
        ),
      );
    case "Bars": {
      const max = Math.max(...block.items.map((item) => Math.abs(item.value)), 0);
      return titled(
        h,
        block.title,
        h.dl(
          [h.Class(ui.bars)],
          block.items.flatMap((item) => [
            h.dt([h.Class(ui.barLabel), h.Title(item.label)], [item.label]),
            h.div(
              [h.Class(ui.barTrack), h.AriaHidden(true)],
              [
                h.div(
                  [
                    h.Class(ui.barFill),
                    h.Style({ width: `${max === 0 ? 0 : (Math.abs(item.value) / max) * 100}%` }),
                  ],
                  [],
                ),
              ],
            ),
            h.dd([h.Class(ui.barValue)], [number.format(item.value)]),
          ]),
        ),
      );
    }
    case "Steps":
      return titled(
        h,
        block.title,
        h.ol(
          [h.Class(ui.steps)],
          block.items.map((item) => {
            const state = item.state ?? "todo";
            return h.li(
              [
                h.Class(ui.step({ state })),
                ...(state === "current" ? [h.AriaCurrent("step")] : []),
              ],
              [...(state === "done" ? [h.span([h.Class(ui.srOnly)], ["Done: "])] : []), item.text],
            );
          }),
        ),
      );
    case "Sources":
      return h.ol(
        [h.Class(ui.sources), h.AriaLabel("Sources")],
        block.items.map((item) =>
          h.li(
            [h.Class(ui.source)],
            [
              h.a(
                [h.Href(item.url), h.Target("_blank"), h.Rel("noopener noreferrer")],
                [
                  h.span([h.Class(ui.sourceTitle)], [item.title]),
                  h.span([h.Class(ui.sourceHost)], [hostOf(item.url)]),
                ],
              ),
            ],
          ),
        ),
      );
    case "Callout": {
      const tone = block.tone ?? "info";
      return h.div(
        [h.Class(ui.callout({ tone })), h.Role(tone === "danger" ? "alert" : "note")],
        [
          ...(block.title === undefined || block.title === ""
            ? []
            : [h.strong([h.Class(ui.calloutTitle({ tone }))], [block.title])]),
          block.body,
        ],
      );
    }
    case "Choices":
      return titled(
        h,
        block.prompt,
        h.div(
          [h.Class(ui.choices)],
          block.items.map((text) =>
            h.button(
              [
                h.Type("button"),
                h.Class(button({ tone: "line", size: "sm" })),
                h.OnClick(Message.ClickedChoice({ text })),
              ],
              [text, icon(h, "arrowRight", 14)],
            ),
          ),
        ),
      );
  }
};

/**
 * Markdown the Words DOM renderer owns: the Mount patches the element as
 * `data-source` changes, so a streaming reply fades in word by word.
 */
const markdownView = (h: H, source: string, streaming: boolean): Html =>
  h.div(
    [
      h.Class(ui.markdown),
      h.OnMount(StreamMarkdown()),
      h.Attribute("data-source", source),
      h.Attribute("data-streaming", String(streaming)),
    ],
    [],
  );

const segmentView = (h: H, segment: Segment, streaming: boolean): Html =>
  segment.kind === "markdown"
    ? markdownView(h, segment.source, streaming)
    : segment.kind === "ui"
      ? h.div(
          [h.Class(ui.blocks)],
          segment.blocks.map((block) => blockView(h, block)),
        )
      : h.div([h.Class(ui.pending), h.AriaBusy(true)], []);

const replyView = (h: H, text: string, streaming: boolean): ReadonlyArray<Html> =>
  segmentsOf(text).map((segment) => segmentView(h, segment, streaming));

const messageView = (
  message: ChatMessage,
  h: H,
  agent: string,
  continued: boolean,
  copied: boolean,
): Html => {
  const user = message.role === "user";
  const time = h.time(
    [h.Class(ui.time), h.Attribute("datetime", new Date(message.at).toISOString())],
    [clock(message.at)],
  );
  return h.article(
    [h.Key(String(message.id)), h.Class(ui.message({ role: message.role, continued }))],
    user
      ? [
          h.div(
            [h.Class(ui.bubble)],
            [h.span([h.Class(ui.srOnly)], ["You said: "]), h.p([h.Class(ui.text)], [message.text])],
          ),
          ...(continued ? [] : [time]),
        ]
      : [
          ...(continued
            ? []
            : [
                h.div(
                  [h.Class(ui.meta)],
                  [h.span([h.Class(ui.metaMark)], []), h.span([], [agent]), time],
                ),
              ]),
          h.div([h.Class(ui.blocks)], replyView(h, message.text, false)),
          h.div(
            [h.Class(ui.messageActions)],
            [
              iconButton(
                h,
                copied ? "check" : "copy",
                copied ? "Copied" : "Copy",
                Message.ClickedCopy({ id: message.id, text: message.text }),
                "ghost",
                [],
                "iconSm",
              ),
            ],
          ),
        ],
  );
};

/**
 * The web chat is turn-based: every bubble an agent sends during one turn is
 * one answer. Join consecutive agent messages so the transcript reads as one
 * entry with one copy button, like the turn it was.
 */
const collapseAgentMessages = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ChatMessage> => {
  const collapsed: ChatMessage[] = [];
  for (const message of messages) {
    const previous = collapsed[collapsed.length - 1];
    if (message.role === "agent" && previous?.role === "agent") {
      collapsed[collapsed.length - 1] = {
        ...previous,
        text: `${previous.text}\n\n${message.text}`,
      };
    } else {
      collapsed.push(message);
    }
  }
  return collapsed;
};

/** An approval blocks the turn, so it sits on the composer, not in the scroll. */
const approvalView = (h: H, approval: Approval): Html =>
  h.div(
    [h.Key(`approval-${approval.id}`), h.Class(ui.approval), h.Role("alert")],
    [
      h.span([h.Class(ui.approvalIcon)], [icon(h, "shieldCheck", 22)]),
      h.div([h.Class(ui.approvalSummary)], [approval.summary]),
      h.div(
        [h.Class(ui.approvalActions)],
        [
          iconButton(
            h,
            "check",
            "Approve",
            Message.ClickedApprove({ approvalId: approval.id, action: "approve" }),
            "primary",
          ),
          ...(approval.match === ""
            ? []
            : [
                iconButton(
                  h,
                  "lock",
                  `Always allow ${approval.match}`,
                  Message.ClickedApprove({ approvalId: approval.id, action: "always" }),
                  "line",
                ),
              ]),
          iconButton(
            h,
            "close",
            "Deny",
            Message.ClickedApprove({ approvalId: approval.id, action: "deny" }),
            "danger",
          ),
        ],
      ),
    ],
  );

const threadMessages = (model: Model, state: ThreadState, h: H): Html => {
  const messages = collapseAgentMessages(state.messages);
  return h.div(
    [h.Class(ui.messagesWrap)],
    [
      h.section(
        [
          h.Class(ui.messages),
          // A thread of its own starts at its bottom and follows it.
          h.Key(`messages-${state.thread.id}`),
          h.OnMount(FollowLatest({ threadId: state.thread.id })),
          h.AriaLive("polite"),
        ],
        [
          h.div(
            [h.Class(ui.messagesInner)],
            [
              ...messages.map((message, index) =>
                messageView(
                  message,
                  h,
                  agentRoleLabel(state.thread),
                  messages[index - 1]?.role === message.role,
                  Option.exists(model.copied, (copied) => copied.id === message.id),
                ),
              ),
              ...(state.streaming !== undefined
                ? [
                    h.article(
                      [h.Key("live"), h.Class(ui.message({ role: "agent", continued: true }))],
                      [h.div([h.Class(ui.blocks)], replyView(h, state.streaming, true))],
                    ),
                  ]
                : []),
              ...(state.running
                ? [
                    h.div(
                      [h.Class(ui.working), h.Role("status")],
                      [
                        h.span([h.Class(ui.workingMark)], []),
                        h.span([h.Class(ui.workingMark)], []),
                        h.span([h.Class(ui.workingMark)], []),
                        h.span([h.Class(ui.srOnly)], ["Working"]),
                      ],
                    ),
                  ]
                : []),
            ],
          ),
          h.div([h.Id("messages-end"), h.Class(ui.messagesEnd)], []),
        ],
      ),
      ...(model.atBottom
        ? []
        : [
            h.div(
              [h.Class(ui.jump)],
              [
                h.div(
                  [h.Class(ui.jumpInner)],
                  [iconButton(h, "arrowDown", "Latest", Message.ClickedLatest(), "line")],
                ),
              ],
            ),
          ]),
    ],
  );
};

const agentPicker = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const select = Select.parts(model.ui.agent, h, config);
  const value = model.ui.agent.value;
  return select.root(
    {},
    [h.Class(ui.selectRoot)],
    [
      select.trigger(
        {},
        [h.Class(ui.selectTrigger), h.AriaLabel("Agent")],
        [
          h.span([h.Class(ui.selectBot)], [icon(h, "bot", 18)]),
          h.span(
            [h.Class(ui.selectText)],
            [
              h.span([h.Class(ui.selectValue)], [selectedAgentName(model)]),
              ...(value === "" ? [] : [h.span([h.Class(ui.selectMeta)], [`/${value}`])]),
            ],
          ),
          h.span([h.Class(ui.selectArrow)], [icon(h, "chevronDown", 16)]),
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
                [
                  h.span(
                    [h.Class(ui.selectText)],
                    [
                      select["item-text"](
                        { text: item.label },
                        [h.Class(ui.selectName)],
                        [item.label],
                      ),
                      h.span([h.Class(ui.selectMeta)], [`/${item.value}`]),
                    ],
                  ),
                  ...(item.value === value
                    ? [h.span([h.Class(ui.selectCheck)], [icon(h, "check", 16)])]
                    : []),
                ],
              ),
            ),
          ),
        ],
      ),
    ],
  );
};

/** Home puts the input first: the hero, then the composer. */
const homeView = (model: Model, h: H, config: PartsConfig<Message>, failure?: string): Html =>
  h.section(
    [h.Class(ui.home)],
    [
      h.div(
        [h.Class(ui.homeInner)],
        [
          h.h1(
            [h.Class(ui.homeTitle)],
            [
              h.span([h.Class(ui.homeDot)], []),
              failure === undefined ? "What are we doing?" : "Offline",
            ],
          ),
          ...(failure === undefined
            ? [agentPicker(model, h, config), composerBox(model, h, config, false)]
            : [
                h.div(
                  [h.Class(ui.errorBox), h.Role("alert")],
                  [
                    icon(h, "alert", 18),
                    h.span([h.Class(ui.spacer)], [failure]),
                    iconButton(h, "refresh", "Retry", Message.ClickedRetry(), "line"),
                  ],
                ),
              ]),
        ],
      ),
    ],
  );

const bigState = (h: H, glyph: GlyphName, title: string, action?: Html): Html =>
  h.section(
    [h.Class(ui.empty)],
    [
      h.div(
        [h.Class(ui.emptyInner)],
        [
          h.span([h.Class(ui.emptyIcon)], [icon(h, glyph, 40)]),
          h.h1([h.Class(ui.emptyTitle)], [title]),
          ...(action === undefined ? [] : [action]),
        ],
      ),
    ],
  );

const threadContent = (model: Model, h: H): Html =>
  AsyncData.matchData(model.thread, {
    onEmpty: () => h.section([h.Class(ui.messages)], [h.div([h.Class(ui.messagesInner)], [])]),
    onFailure: (error) =>
      bigState(
        h,
        "alert",
        error,
        iconButton(h, "refresh", "Retry", Message.ClickedRetry(), "line"),
      ),
    onData: (state) =>
      state.messages.length === 0 && !state.running
        ? bigState(h, "thread", "Empty")
        : threadMessages(model, state, h),
  });

const composerBox = (model: Model, h: H, config: PartsConfig<Message>, running: boolean): Html => {
  const textarea = Textarea.parts(model.ui.composer, h, config);
  const empty = model.ui.composer.value.trim() === "";
  const agent = agentNameOf(model);
  return h.div(
    [h.Class(ui.composerBox)],
    [
      textarea.root({}, [
        h.Class(ui.textarea),
        h.Placeholder(`Message ${agent}`),
        h.AriaLabel("Message"),
        h.Rows(1),
        ...(model.touch
          ? []
          : [
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
      ]),
      // One slot: Send while idle, Stop while a turn runs.
      running
        ? h.button(
            [
              h.Type("button"),
              h.Class(button({ tone: "danger", size: "icon" })),
              h.AriaLabel("Stop"),
              h.Title("Stop"),
              h.Disabled(TurnState.guards.Stopping(model.turn)),
              h.OnClick(Message.ClickedStop()),
            ],
            [icon(h, "stop", 16)],
          )
        : iconButton(h, "send", "Send", Message.ClickedSend(), "primary", [
            h.Disabled(empty || TurnState.guards.Sending(model.turn)),
          ]),
    ],
  );
};

const toastView = (model: Model, h: H): Html =>
  Option.match(model.toast, {
    onNone: () => null,
    onSome: (text) =>
      h.div(
        [h.Key(`toast-${text}`), h.Class(ui.toast), h.Role("status")],
        [icon(h, "check", 16), text],
      ),
  });

const composer = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const state = AsyncData.getData(model.thread);
  const running = Option.match(state, { onNone: () => false, onSome: (value) => value.running });
  const approvals = Option.match(state, {
    onNone: () => [],
    onSome: (value) => value.approvals,
  });
  return h.div(
    [h.Class(ui.composer)],
    [
      h.div(
        [h.Class(ui.composerInner)],
        [
          noticeView(model, h),
          toastView(model, h),
          ...approvals.map((approval) => approvalView(h, approval)),
          composerBox(model, h, config, running),
        ],
      ),
    ],
  );
};

const THREAD_MENU = "thread-menu";

/** `keepOpen` leaves the menu showing, for an item that asks again before it acts. */
const menuItem = (
  h: H,
  glyph: GlyphName,
  label: string,
  message: Message,
  danger = false,
  keepOpen = false,
) =>
  h.button(
    [
      h.Type("button"),
      h.Class(ui.menuItem({ danger })),
      ...(keepOpen ? [] : [h.Popovertarget(THREAD_MENU), h.Popovertargetaction("hide")]),
      h.OnClick(message),
    ],
    [icon(h, glyph, 18), label],
  );

const header = (model: Model, h: H, config: PartsConfig<Message>): Html => {
  const drawer = Drawer.parts(model.ui.drawer, h, config);
  const state = AsyncData.getData(model.thread);
  const hasThread = Predicate.isTagged(model.route, "Thread") && Option.isSome(state);
  const armed = Option.match(state, {
    onNone: () => false,
    onSome: (value) => isArmed(model.armedArchive, value.thread.id),
  });
  return h.header(
    [h.Class(ui.header)],
    [
      drawer.trigger(
        {},
        [
          h.Class(cx(button({ tone: "ghost", size: "icon" }), ui.mobileOnly)),
          h.AriaLabel("Threads"),
        ],
        [icon(h, "menu")],
      ),
      h.div(
        [h.Class(ui.headerText)],
        [
          h.span([h.Class(ui.headerTitle)], [headerTitle(model)]),
          h.span([h.Class(ui.headerAgent)], [`/${agentNameOf(model).toLowerCase()}`]),
        ],
      ),
      ...(hasThread
        ? [
            h.button(
              [
                h.Type("button"),
                h.Class(button({ tone: armed ? "danger" : "ghost", size: "icon" })),
                h.Popovertarget(THREAD_MENU),
                h.AriaLabel("Thread actions"),
                h.Title("Thread actions"),
              ],
              [icon(h, "more")],
            ),
            h.div(
              [h.Id(THREAD_MENU), h.Popover("auto"), h.Class(ui.menu)],
              [
                menuItem(h, "pencil", "Rename", Message.ClickedRename()),
                menuItem(
                  h,
                  "archive",
                  armed ? "Archive, sure?" : "Archive",
                  Message.ClickedArchive(),
                  true,
                  !armed,
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
      drawer.backdrop({}, [h.Class(ui.drawerBackdrop), h.Attribute("data-swipe-backdrop", "")], []),
      drawer.viewport(
        {},
        [h.Class(ui.drawerViewport)],
        [
          drawer.content(
            {},
            [h.Class(ui.drawerContent), h.Attribute("data-swipe-panel", "")],
            [
              drawer.title({}, [h.Class(ui.srOnly)], ["Threads"]),
              drawer.close(
                {},
                [
                  h.Class(cx(button({ tone: "ghost", size: "iconSm" }), ui.drawerClose)),
                  h.AriaLabel("Close"),
                ],
                [icon(h, "close", 18)],
              ),
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
          dialog.title({}, [h.Class(ui.dialogTitle)], [icon(h, "pencil", 20), "Rename"]),
          input.root(
            {},
            [h.Class(ui.input), h.Placeholder("Thread name"), h.AriaLabel("Thread name")],
            [],
          ),
          h.div(
            [h.Class(ui.dialogActions)],
            [
              iconButton(h, "close", "Cancel", Message.ClickedCloseRename(), "ghost"),
              iconButton(h, "check", "Save", Message.ClickedSaveRename(), "primary", [
                h.Disabled(model.ui.renameInput.value.trim() === ""),
              ]),
            ],
          ),
        ],
      ),
    ],
  );
};

export const view = (model: Model, h: H): Document => {
  const config = configOf(model);
  const home = Predicate.isTagged(model.route, "Home");
  const content = home
    ? AsyncData.matchData(model.bootstrap, {
        onEmpty: () => homeView(model, h, config),
        onFailure: (error) => homeView(model, h, config, error),
        onData: () => homeView(model, h, config),
      })
    : Predicate.isTagged(model.route, "Thread")
      ? threadContent(model, h)
      : bigState(
          h,
          "alert",
          "Not found",
          labelButton(h, "plus", "New thread", Message.ClickedNewChat(), "primary"),
        );
  const title = headerTitle(model);
  return {
    title: home ? "Mizook" : `${title} · Mizook`,
    body: h.div(
      [h.Class(ui.root)],
      [
        sidebarBody(model, h, false),
        h.main(
          [h.Class(ui.main)],
          [
            header(model, h, config),
            savedBar(model, h),
            content,
            ...(home ? [] : [composer(model, h, config)]),
          ],
        ),
        drawerLayer(model, h, config),
        renameDialog(model, h, config),
      ],
    ),
  };
};
