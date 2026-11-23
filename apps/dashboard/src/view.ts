import { Array, Option, Order, Record, pipe } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import {
  type LogMessage,
  type ActionKind,
  type SettingKey,
  type Overview,
  type ScheduleRow,
  type ViewLine,
  type UsageReport,
  artifactQuery,
  artifactsQuery,
  type ArtifactRow,
  AgentKind,
  IntentRow,
  PolicyRow,
  RunRow,
  SkillRow,
  auditQuery,
  recentQuery,
  summaryQuery,
  entryQuery,
  intentsQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  policiesQuery,
  profileQuery,
  runsQuery,
  schedulesQuery,
  skillsQuery,
  usageQuery,
} from "./api.ts";
import {
  ago,
  count,
  describeSpec,
  epochDateTime,
  inZone,
  localDateTime,
  percent,
  until,
  usd,
} from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import {
  AppRoute,
  USAGE_DAYS,
  daysOf,
  entryRouter,
  logRouter,
  artifactsRouter,
  overviewRouter,
  settingsRouter,
  routeChannel,
  routeHref,
  textOf,
  usageRouter,
} from "./route.ts";
import { currentChannel } from "./update.ts";
import { channelsQuery } from "./api.ts";
import type { GlyphName } from "@mizook/design/icons";
import { icon } from "./icon.ts";
import { type Destination, matches, sections } from "./palette.ts";
import { PaletteState } from "./palette-machine.ts";

const channelsRead = channelsQuery.read;
import { ui } from "./ui.ts";

type H = HtmlBuilder<Message>;

const PAGE_SIZE = 50;

const remote = <A>(
  data: AsyncData.AsyncData<A, string>,
  h: H,
  skeleton: Html,
  view: (value: A) => Html,
): Html =>
  AsyncData.matchData(data, {
    onEmpty: () => skeleton,
    onFailure: (error) => errorView(error, h),
    onData: view,
  });

const errorView = (error: string, h: H): Html =>
  h.div(
    [h.Class(ui.errorBox), h.Role("alert")],
    [
      h.span([], [error]),
      h.button(
        [h.Type("button"), h.Class(ui.button), h.OnClick(Message.ClickedRetry())],
        ["Retry"],
      ),
    ],
  );

const skeletonView = (h: H, rows: number): Html =>
  h.div(
    [h.Class(ui.section), h.AriaBusy(true)],
    Array.makeBy(rows, (index) => h.keyed("div")(String(index), [h.Class(ui.skeletonBlock)])),
  );

const emptyView = (text: string, h: H): Html => h.div([h.Class(ui.empty)], [text]);

const sectionView = (title: string, body: Html, h: H): Html =>
  h.section([h.Class(ui.section)], [h.h2([h.Class(ui.sectionTitle)], [title]), body]);

const titleView = (title: string, actions: ReadonlyArray<Html>, h: H): Html =>
  h.div([h.Class(ui.titleRow)], [h.h1([h.Class(ui.title)], [title]), ...actions]);

const ACTION_GLYPH: Record<ActionKind, GlyphName> = {
  approve: "check",
  deny: "close",
  cancel: "trash",
  stop: "stop",
};

const actionButton = (model: Model, action: ActionKind, id: number, label: string, h: H): Html => {
  const armed = Option.contains(model.armed, `${action}:${id}`);
  return h.button(
    [
      h.Type("button"),
      h.Class(armed ? ui.buttonSmallArmed : ui.buttonSmall),
      h.OnClick(Message.ClickedAction({ action, id })),
    ],
    [icon(h, ACTION_GLYPH[action], 14), armed ? `Sure? ${label}` : label],
  );
};

const KIND_GLYPH: Record<string, GlyphName> = {
  user: "user",
  agent: "bot",
  tool: "zap",
  echo: "arrowLeft",
  note: "book",
};

/** Kinds differ by glyph, so color stays for status. Only yours is filled. */
const kindBadge = (kind: string, h: H): Html =>
  h.span(
    [h.Class(kind === "user" ? ui.badgeUser : ui.badge), h.Title(kind)],
    [icon(h, KIND_GLYPH[kind] ?? "log", 13), kind],
  );

/** A time in the reader's zone; the UTC original is in the tooltip. */
const when = (epochMs: number, h: H): Html =>
  h.time(
    [h.Attribute("datetime", new Date(epochMs).toISOString()), h.Title(epochDateTime(epochMs))],
    [localDateTime(epochMs)],
  );

const th = (label: string, h: H, numeric = false): Html =>
  h.th([h.Class(numeric ? ui.thNum : ui.th), h.Scope("col")], [label]);

const tableView = (headers: ReadonlyArray<Html>, rows: ReadonlyArray<Html>, h: H): Html =>
  h.div(
    [h.Class(ui.tableWrap)],
    [h.table([h.Class(ui.table)], [h.thead([], [h.tr([], headers)]), h.tbody([], rows)])],
  );

const meterColor = (used: number): string =>
  used >= 90 ? "var(--colors-danger)" : used >= 70 ? "var(--colors-warn)" : "var(--colors-ok)";

const recentRow = (m: LogMessage, channel: Option.Option<string>, h: H): Html =>
  h.keyed("tr")(
    String(m.i),
    [h.Class(ui.row)],
    [
      h.td(
        [h.Class(ui.tdMono)],
        [h.a([h.Href(entryRouter({ entryId: m.i, channel })), h.Class(ui.link)], [String(m.i)])],
      ),
      h.td([h.Class(ui.td)], [kindBadge(m.kind, h)]),
      h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [m.cut ? `${m.text} …` : m.text])]),
      h.td([h.Class(ui.tdFitMono)], [when(Date.parse(m.date), h)]),
    ],
  );

const channelsTable = (model: Model, h: H): Html =>
  remote(summaryQuery.read(model.summary), h, skeletonView(h, 1), (rows) => {
    const current = Option.getOrElse(currentChannel(model), () => "");
    return tableView(
      [
        th("Agent", h),
        th("Active", h),
        th("Messages", h, true),
        th("24 h", h, true),
        th("7 d", h, true),
        th("Needs you", h, true),
      ],
      Array.map(rows, (row) =>
        h.keyed("tr")(
          row.doName,
          [h.Class(ui.row)],
          [
            h.td(
              [h.Class(ui.td)],
              [
                h.a(
                  [
                    h.Class(row.doName === current ? `${ui.link} ${ui.strong}` : ui.link),
                    h.Href(overviewRouter({ channel: Option.some(row.doName) })),
                  ],
                  [row.name],
                ),
              ],
            ),
            h.td([h.Class(ui.tdFit)], [ago(row.lastActive)]),
            h.td([h.Class(ui.tdNum)], [count(row.messages)]),
            h.td(
              [h.Class(ui.tdNum)],
              [
                row.budget > 0
                  ? `${usd(row.spend24h)} · ${percent(row.spend24h, row.budget)}%`
                  : usd(row.spend24h),
              ],
            ),
            h.td([h.Class(ui.tdNum)], [usd(row.spend7d)]),
            h.td(
              [h.Class(ui.tdNum)],
              [
                row.pending + row.approvals === 0
                  ? "–"
                  : [
                      row.pending > 0 ? `${row.pending} running` : "",
                      row.approvals > 0
                        ? `${row.approvals} approval${row.approvals === 1 ? "" : "s"}`
                        : "",
                    ]
                      .filter((part) => part !== "")
                      .join(" · "),
              ],
            ),
          ],
        ),
      ),
      h,
    );
  });

const budgetAlert = (used: number, channel: Option.Option<string>, h: H): Html =>
  used < 80
    ? h.empty
    : h.div(
        [
          h.Class(ui.alert),
          h.Role("alert"),
          h.Style({ "border-color": used >= 100 ? "var(--colors-danger)" : "var(--colors-warn)" }),
        ],
        [
          h.span(
            [],
            [
              used >= 100
                ? "Today's spend has passed the daily budget."
                : `Today's spend is at ${used}% of the daily budget.`,
            ],
          ),
          h.a([h.Class(ui.link), h.Href(settingsRouter({ channel }))], ["Settings"]),
        ],
      );

type OverviewData = typeof Overview.Type;

const heroView = (data: OverviewData, budget: number, used: number, h: H): Html => {
  const days = data.daily;
  const peak = Array.reduce(days, 0, (max, day) => Math.max(max, day.cost));
  const today = days[days.length - 1]?.cost ?? 0;
  const yesterday = days[days.length - 2]?.cost ?? 0;
  const delta = yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100) : undefined;
  const ratio = Math.max(Math.round(data.messages / Math.max(data.viewLines, 1)), 1);
  const linesWidth = Math.max(percent(data.viewLines, data.messages), 2);
  return h.div(
    [h.Class(ui.hero)],
    [
      h.div(
        [h.Class(ui.heroSpend)],
        [
          h.div(
            [h.Class(ui.heroHead)],
            [
              h.span([h.Class(ui.statLabel)], ["Spend today"]),
              delta === undefined
                ? h.empty
                : h.span(
                    [
                      h.Class(ui.mono),
                      h.Style({
                        color: delta > 0 ? "var(--colors-warn)" : "var(--colors-ok)",
                      }),
                    ],
                    [`${delta > 0 ? "↑" : "↓"} ${Math.abs(delta)}% vs yesterday`],
                  ),
            ],
          ),
          h.span([h.Class(ui.heroValue)], [usd(data.spend.last24h)]),
          h.div(
            [h.Class(ui.spark)],
            Array.map(days, (day, index) =>
              h.keyed("span")(day.day, [
                h.Class(ui.sparkBar),
                h.Title(`${day.day}: ${usd(day.cost)}`),
                h.Style({
                  height: `${Math.max(percent(day.cost, peak), 3)}%`,
                  ...(index === days.length - 1 && {
                    "background-color": "var(--colors-accent)",
                  }),
                }),
              ]),
            ),
          ),
          h.div(
            [h.Class(ui.axis)],
            [h.span([], ["14 days ago"]), h.span([], [`peak ${usd(peak)}`]), h.span([], ["today"])],
          ),
          h.div(
            [h.Class(ui.heroFoot)],
            [
              h.span([], [`7 d ${usd(data.spend.last7d)}`]),
              h.span([], [`all time ${usd(data.spend.total)}`]),
            ],
          ),
          budget > 0
            ? h.div(
                [h.Class(ui.heroBudget)],
                [
                  h.div(
                    [h.Class(ui.budgetRow)],
                    [
                      h.span([], ["Daily budget"]),
                      h.span([], [`${usd(data.spend.last24h)} of ${usd(budget)} · ${used}%`]),
                    ],
                  ),
                  h.div(
                    [h.Class(ui.meter)],
                    [
                      h.div([
                        h.Class(ui.meterFill),
                        h.Style({
                          width: `${Math.min(used, 100)}%`,
                          "background-color": meterColor(used),
                        }),
                      ]),
                    ],
                  ),
                ],
              )
            : h.empty,
        ],
      ),
      h.div(
        [h.Class(ui.heroSide)],
        [
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Messages"]),
              h.span([h.Class(ui.miniValue)], [count(data.messages)]),
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [`${count(data.nodes)} memory nodes built`],
              ),
            ],
          ),
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Memory compression"]),
              h.span([h.Class(ui.miniValue)], [`${ratio}×`]),
              h.div(
                [h.Class(ui.ratio)],
                [h.div([h.Class(ui.ratioFill), h.Style({ width: `${linesWidth}%` })])],
              ),
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [`${count(data.viewLines)} lines stand for ${count(data.messages)} messages`],
              ),
            ],
          ),
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Automations"]),
              h.span([h.Class(ui.miniValue)], [count(data.schedules)]),
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [data.nextSchedule === null ? "none queued" : `next ${until(data.nextSchedule)}`],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

/** What the operator must act on goes first: approvals and running turns. */
const needsYouView = (model: Model, data: OverviewData, h: H): Html => {
  const items = [
    ...Array.map(data.approvals, (approval) =>
      h.keyed("div")(
        `approval-${approval.id}`,
        [h.Class(ui.needItem)],
        [
          h.span([h.Class(ui.needIcon)], [icon(h, "shieldCheck", 22)]),
          h.div(
            [h.Class(ui.needText)],
            [
              h.span(
                [h.Class(ui.needMeta)],
                [`#${approval.id}${approval.posted ? "" : " · not posted"}`],
              ),
              h.span([], [approval.summary]),
            ],
          ),
          h.div(
            [h.Class(ui.actions)],
            [
              actionButton(model, "approve", approval.id, "Approve", h),
              actionButton(model, "deny", approval.id, "Deny", h),
            ],
          ),
        ],
      ),
    ),
    ...Array.map(data.turns, (turn) =>
      h.keyed("div")(
        `turn-${turn.chatId}`,
        [h.Class(ui.needItem)],
        [
          h.span([h.Class(ui.needIcon)], [icon(h, "pulse", 22)]),
          h.div(
            [h.Class(ui.needText)],
            [h.span([h.Class(ui.needMeta)], [turn.chatId]), h.span([], [turn.text])],
          ),
          h.div([h.Class(ui.actions)], [actionButton(model, "stop", 0, "Stop", h)]),
        ],
      ),
    ),
  ];
  return items.length === 0
    ? h.div([h.Class(ui.needQuiet)], [icon(h, "check", 18), "Nothing needs you"])
    : h.section(
        [h.Class(ui.needs), h.AriaLabel("Needs you")],
        [
          h.h2(
            [h.Class(ui.needsTitle)],
            [h.span([h.Class(ui.needsCount)], [String(items.length)]), "Needs you"],
          ),
          ...items,
        ],
      );
};

const overviewView = (model: Model, channel: string, h: H): Html =>
  remote(overviewQuery.read(model.overview, { channel }), h, skeletonView(h, 3), (data) => {
    const budget = Number(data.settings["budget"] ?? 0);
    const used = percent(data.spend.last24h, budget);
    const maybeChannel = routeChannel(model.route);
    return h.div(
      [h.Class(ui.stack)],
      [
        budget > 0 ? budgetAlert(used, maybeChannel, h) : h.empty,
        needsYouView(model, data, h),
        heroView(data, budget, used, h),
        sectionView("Agents", channelsTable(model, h), h),
        sectionView(
          "Recent messages",
          remote(recentQuery.read(model.recent, { channel }), h, skeletonView(h, 1), (rows) =>
            Array.match(rows, {
              onEmpty: () => emptyView("No messages yet.", h),
              onNonEmpty: (list) =>
                tableView(
                  [th("ID", h), th("Kind", h), th("Message", h), th("Date", h)],
                  Array.map(list, (row) => recentRow(row, maybeChannel, h)),
                  h,
                ),
            }),
          ),
          h,
        ),
      ],
    );
  });

const KINDS = ["user", "agent", "tool", "echo", "note"];

/** Kind is a row of links, search runs on Enter: no Filter button to press. */
const filterView = (model: Model, h: H): Html => {
  const channel = routeChannel(model.route);
  const kindLink = (kind: string, label: Html | string) =>
    h.a(
      [
        h.Class(ui.segment),
        h.AriaCurrent(model.draftKind === kind ? "true" : "false"),
        h.Href(
          logRouter({
            channel,
            kind: Option.liftPredicate(kind, (text) => text !== ""),
            q: Option.liftPredicate(model.draftSearch.trim(), (text) => text !== ""),
            before: Option.none(),
          }),
        ),
      ],
      [label],
    );
  return h.div(
    [h.Class(ui.toolbar)],
    [
      h.nav(
        [h.Class(ui.segments), h.AriaLabel("Kind")],
        [
          kindLink("", "All"),
          ...Array.map(KINDS, (kind) =>
            h.keyed("span")(kind, [], [kindLink(kind, kindBadge(kind, h))]),
          ),
        ],
      ),
      h.form(
        [h.Class(ui.searchBox), h.Role("search"), h.OnSubmit(Message.SubmittedFilter())],
        [
          icon(h, "search", 16),
          h.input([
            h.Class(ui.searchInput),
            h.Id("log-search"),
            h.Type("search"),
            h.AriaLabel("Search"),
            h.Placeholder("Search  /"),
            h.Value(model.draftSearch),
            h.OnInput((value) => Message.UpdatedSearchDraft({ value })),
          ]),
        ],
      ),
    ],
  );
};

const logRowView = (m: LogMessage, channel: Option.Option<string>, h: H): Html =>
  h.keyed("tr")(
    String(m.i),
    [h.Class(ui.row)],
    [
      h.td(
        [h.Class(ui.tdMono)],
        [h.a([h.Href(entryRouter({ entryId: m.i, channel })), h.Class(ui.link)], [String(m.i)])],
      ),
      h.td([h.Class(ui.td)], [kindBadge(m.kind, h)]),
      h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [m.cut ? `${m.text} …` : m.text])]),
      h.td([h.Class(ui.tdFitMono)], [when(Date.parse(m.date), h)]),
    ],
  );

const logView = (model: Model, channel: string, h: H): Html => {
  const route = model.route;
  const [kind, q, before] =
    route._tag === "Log"
      ? [textOf(route.kind), textOf(route.q), textOf(route.before)]
      : ["", "", ""];
  const maybeChannel = routeChannel(route);
  return h.div(
    [h.Class(ui.page)],
    [
      filterView(model, h),
      remote(
        logQuery.read(model.log, { channel, kind, q, before }),
        h,
        skeletonView(h, 2),
        (messages) =>
          Array.match(messages, {
            onEmpty: () => emptyView("No messages match.", h),
            onNonEmpty: (rows) =>
              h.div(
                [h.Class(ui.fill)],
                [
                  tableView(
                    [th("ID", h), th("Kind", h), th("Message", h), th("Date", h)],
                    Array.map(rows, (row) => logRowView(row, maybeChannel, h)),
                    h,
                  ),
                  pipe(
                    Array.last(rows),
                    Option.filter(() => rows.length >= PAGE_SIZE),
                    Option.match({
                      onNone: () => h.empty,
                      onSome: (last) =>
                        h.div(
                          [h.Class(ui.footer)],
                          [
                            h.a(
                              [
                                h.Class(ui.button),
                                h.Href(
                                  logRouter({
                                    channel: maybeChannel,
                                    kind: Option.liftPredicate(kind, (text) => text !== ""),
                                    q: Option.liftPredicate(q, (text) => text !== ""),
                                    before: Option.some(String(last.i)),
                                  }),
                                ),
                              ],
                              ["Older messages"],
                            ),
                          ],
                        ),
                    }),
                  ),
                ],
              ),
          }),
      ),
    ],
  );
};

const entryView = (model: Model, channel: string, entryId: number, h: H): Html =>
  h.div(
    [h.Class(ui.page)],
    [
      h.a(
        [
          h.Class(ui.back),
          h.Href(
            logRouter({
              channel: routeChannel(model.route),
              kind: Option.none(),
              q: Option.none(),
              before: Option.none(),
            }),
          ),
        ],
        ["← Log"],
      ),
      remote(entryQuery.read(model.entry, { channel, entryId }), h, skeletonView(h, 1), (data) =>
        h.div(
          [h.Class(ui.fill)],
          [
            h.div(
              [h.Class(ui.metaRow)],
              [
                kindBadge(data.kind, h),
                h.span([h.Class(ui.mono)], [when(Date.parse(data.date), h)]),
                h.span([h.Class(ui.mono)], [`${count(data.size)} bytes`]),
              ],
            ),
            h.pre([h.Class(ui.pre)], [data.text]),
          ],
        ),
      ),
    ],
  );

const KIND_PREFIX = /^(user|agent|tool|echo|note): ?([\s\S]*)$/;

const spanOf = (
  startPlusCountLabel: string,
): { readonly start: number; readonly count: number } => {
  const [firstMessage, messageCount] = startPlusCountLabel.split("+").map(Number);
  return { start: firstMessage ?? 0, count: messageCount ?? 1 };
};

const levelShade = (level: number): string =>
  level === 0
    ? "var(--colors-border-strong)"
    : `color-mix(in oklab, var(--colors-accent) ${Math.min(30 + level * 14, 100)}%, var(--colors-border-strong))`;

const memoryLine = (line: typeof ViewLine.Type, h: H): Html => {
  const { start, count: covered } = spanOf(line.label);
  const said = KIND_PREFIX.exec(line.text);
  const range = covered === 1 ? `#${start}` : `#${start}–${start + covered - 1}`;
  return h.keyed("div")(
    line.label,
    [h.Class(ui.memRow)],
    [
      h.div(
        [h.Class(ui.memGutter)],
        [
          h.span([h.Class(ui.mono)], [range]),
          h.span([h.Class(ui.memDot), h.Style({ "background-color": levelShade(line.level) })]),
        ],
      ),
      line.level === 0 && said
        ? h.div(
            [h.Class(ui.memBubble)],
            [kindBadge(said[1] ?? "note", h), h.div([h.Class(ui.clamp4)], [said[2] ?? ""])],
          )
        : h.div(
            [h.Class(ui.memSpan)],
            [
              h.span([h.Class(`${ui.muted} ${ui.mono}`)], [`${count(covered)} msgs`]),
              h.div([h.Class(ui.clamp4)], [line.text]),
            ],
          ),
    ],
  );
};

const VIEW_BUDGET_BYTES = 128 * 1024;

const kilobytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;

const memoryHero = (
  rows: ReadonlyArray<typeof ViewLine.Type>,
  total: number,
  bytes: number,
  levels: Record<number, number>,
  h: H,
): Html => {
  const ratio = Math.max(Math.round(total / Math.max(rows.length, 1)), 1);
  const deepest = Array.reduce(rows, 0, (max, row) => Math.max(max, spanOf(row.label).count));
  const used = percent(bytes, VIEW_BUDGET_BYTES);
  return h.div(
    [h.Class(ui.hero)],
    [
      h.div(
        [h.Class(ui.heroSpend)],
        [
          h.span([h.Class(ui.statLabel)], ["The agent reads"]),
          h.span([h.Class(ui.heroValue)], [`${count(rows.length)} lines`]),
          h.span(
            [h.Class(ui.muted)],
            [`standing in for ${count(total)} messages, ${ratio}× smaller than the raw chat`],
          ),
          h.div(
            [h.Class(ui.ratio)],
            [
              h.div([
                h.Class(ui.ratioFill),
                h.Style({ width: `${Math.max(percent(rows.length, total), 2)}%` }),
              ]),
            ],
          ),
          h.div(
            [h.Class(ui.heroFoot)],
            [h.span([], [`${count(rows.length)} lines`]), h.span([], [`${count(total)} messages`])],
          ),
          h.div(
            [h.Class(ui.heroBudget)],
            [
              h.span([h.Class(ui.statLabel)], ["Lines by depth"]),
              h.div(
                [h.Class(ui.depth)],
                Array.map(Array.sort(Object.keys(levels).map(Number), Order.Number), (level) =>
                  h.keyed("span")(String(level), [
                    h.Class(ui.depthSeg),
                    h.Title(`L${level}: ${levels[level]} lines`),
                    h.Style({
                      "flex-grow": String(levels[level] ?? 0),
                      "background-color": levelShade(level),
                    }),
                  ]),
                ),
              ),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class(ui.heroSide)],
        [
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Summary size"]),
              h.span([h.Class(ui.miniValue)], [kilobytes(bytes)]),
              h.div(
                [h.Class(ui.ratio)],
                [
                  h.div([
                    h.Class(ui.ratioFill),
                    h.Style({ width: `${Math.min(Math.max(used, 2), 100)}%` }),
                  ]),
                ],
              ),
              h.span([h.Class(`${ui.muted} ${ui.mono}`)], [`${used}% of the 128 KB view`]),
            ],
          ),
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Compression"]),
              h.span([h.Class(ui.miniValue)], [`${ratio}×`]),
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [`${count(Math.round(bytes / Math.max(rows.length, 1)))} bytes a line on average`],
              ),
            ],
          ),
          h.div(
            [h.Class(ui.miniCard)],
            [
              h.span([h.Class(ui.statLabel)], ["Widest line"]),
              h.span([h.Class(ui.miniValue)], [`${count(deepest)} msgs`]),
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [`one summary, ${deepest === 1 ? "nothing merged yet" : "zoom to expand"}`],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const memoryView = (model: Model, channel: string, h: H): Html =>
  remote(memoryQuery.read(model.memory, { channel }), h, skeletonView(h, 2), (lines) =>
    Array.match(lines, {
      onEmpty: () => emptyView("The view is empty.", h),
      onNonEmpty: (rows) => {
        const total = Array.reduce(rows, 0, (sum, row) => sum + spanOf(row.label).count);
        const bytes = Array.reduce(rows, 0, (sum, row) => sum + row.size);
        const levels = Array.reduce(rows, {} as Record<number, number>, (acc, row) => ({
          ...acc,
          [row.level]: (acc[row.level] ?? 0) + 1,
        }));
        return h.div(
          [h.Class(ui.stack)],
          [
            memoryHero(rows, total, bytes, levels, h),
            sectionView(
              "The whole chat, oldest to newest",
              h.div(
                [h.Class(ui.memMapWrap)],
                [
                  h.div(
                    [h.Class(ui.memMap)],
                    Array.map(rows, (row) =>
                      h.keyed("span")(row.label, [
                        h.Class(ui.memSeg),
                        h.Title(`${row.label}: ${row.text.slice(0, 120)}`),
                        h.Style({
                          "flex-grow": String(spanOf(row.label).count),
                          "background-color": levelShade(row.level),
                        }),
                      ]),
                    ),
                  ),
                  h.div(
                    [h.Class(ui.memLegend)],
                    Array.map(Array.sort(Object.keys(levels).map(Number), Order.Number), (level) =>
                      h.keyed("span")(
                        String(level),
                        [h.Class(ui.memLegendItem)],
                        [
                          h.span([
                            h.Class(ui.memDot),
                            h.Style({ "background-color": levelShade(level) }),
                          ]),
                          `L${level} · ${levels[level]} line${levels[level] === 1 ? "" : "s"}${level === 0 ? "" : `, ${2 ** level} messages each`}`,
                        ],
                      ),
                    ),
                  ),
                ],
              ),
              h,
            ),
            sectionView(
              "What the agent sees",
              h.div(
                [h.Class(ui.memList)],
                Array.map(rows, (row) => memoryLine(row, h)),
              ),
              h,
            ),
          ],
        );
      },
    }),
  );

const dailySection = (report: typeof UsageReport.Type, h: H): Html =>
  sectionView(
    "By day",
    tableView(
      [
        th("Day", h),
        th("Calls", h, true),
        th("Input", h, true),
        th("Output", h, true),
        th("Cache hit", h, true),
        th("Cost", h, true),
      ],
      Array.map(Array.reverse(report.byDay), (day) =>
        h.keyed("tr")(
          day.day,
          [h.Class(ui.row)],
          [
            h.td([h.Class(ui.tdMono)], [day.day]),
            h.td([h.Class(ui.tdNum)], [count(day.calls)]),
            h.td([h.Class(ui.tdNum)], [count(day.input)]),
            h.td([h.Class(ui.tdNum)], [count(day.output)]),
            h.td([h.Class(ui.tdNum)], [`${percent(day.cacheRead, day.input + day.cacheRead)}%`]),
            h.td([h.Class(ui.tdNum)], [usd(day.cost)]),
          ],
        ),
      ),
      h,
    ),
    h,
  );

const toolsSection = (report: typeof UsageReport.Type, h: H): Html =>
  sectionView(
    "Tools used",
    Array.match(report.byTool, {
      onEmpty: () => emptyView("No tool calls.", h),
      onNonEmpty: (tools) =>
        tableView(
          [th("Tool", h), th("Calls", h, true)],
          Array.map(tools, (tool) =>
            h.keyed("tr")(
              tool.tool,
              [h.Class(ui.row)],
              [
                h.td([h.Class(ui.tdMono)], [tool.tool]),
                h.td([h.Class(ui.tdNum)], [count(tool.calls)]),
              ],
            ),
          ),
          h,
        ),
    }),
    h,
  );

const usageView = (model: Model, channel: string, days: number, h: H): Html =>
  remote(usageQuery.read(model.usage, { channel, days }), h, skeletonView(h, 3), (report) => {
    const peak = Array.reduce(report.byDay, 0, (max, day) => Math.max(max, day.cost));
    return h.div(
      [h.Class(ui.page)],
      [
        sectionView(
          "Spend per day",
          Array.match(report.byDay, {
            onEmpty: () => emptyView("Nothing was spent in this range.", h),
            onNonEmpty: (byDay) =>
              h.div(
                [h.Class(ui.chart)],
                [
                  h.div(
                    [h.Class(ui.bars)],
                    Array.map(byDay, (day) =>
                      h.keyed("div")(day.day, [
                        h.Class(ui.bar),
                        h.Title(`${day.day}: ${usd(day.cost)}, ${day.calls} calls`),
                        h.Style({ height: `${Math.max(percent(day.cost, peak), 1)}%` }),
                      ]),
                    ),
                  ),
                  h.div(
                    [h.Class(ui.axis)],
                    [
                      h.span([], [byDay[0]?.day ?? ""]),
                      h.span([], [`peak ${usd(peak)}`]),
                      h.span([], [byDay[byDay.length - 1]?.day ?? ""]),
                    ],
                  ),
                ],
              ),
          }),
          h,
        ),
        h.div(
          [h.Class(ui.stack)],
          [
            dailySection(report, h),
            sectionView(
              "By model",
              tableView(
                [
                  th("Model", h),
                  th("Calls", h, true),
                  th("Input", h, true),
                  th("Output", h, true),
                  th("Cache hit", h, true),
                  th("Cost", h, true),
                ],
                Array.map(report.byModel, (model_) =>
                  h.keyed("tr")(
                    model_.model,
                    [h.Class(ui.row)],
                    [
                      h.td([h.Class(ui.tdMono)], [model_.model]),
                      h.td([h.Class(ui.tdNum)], [count(model_.calls)]),
                      h.td([h.Class(ui.tdNum)], [count(model_.input)]),
                      h.td([h.Class(ui.tdNum)], [count(model_.output)]),
                      h.td(
                        [h.Class(ui.tdNum)],
                        [`${percent(model_.cacheRead, model_.input + model_.cacheRead)}%`],
                      ),
                      h.td([h.Class(ui.tdNum)], [usd(model_.cost)]),
                    ],
                  ),
                ),
                h,
              ),
              h,
            ),
            h.div(
              [h.Class(ui.columns)],
              [
                toolsSection(report, h),
                sectionView(
                  "By kind",
                  tableView(
                    [th("Kind", h), th("Calls", h, true), th("Cost", h, true)],
                    Array.map(report.byKind, (kind) =>
                      h.keyed("tr")(
                        kind.kind,
                        [h.Class(ui.row)],
                        [
                          h.td([h.Class(ui.td)], [kindBadge(kind.kind, h)]),
                          h.td([h.Class(ui.tdNum)], [count(kind.calls)]),
                          h.td([h.Class(ui.tdNum)], [usd(kind.cost)]),
                        ],
                      ),
                    ),
                    h,
                  ),
                  h,
                ),
              ],
            ),
          ],
        ),
      ],
    );
  });

const rangeView = (model: Model, days: number, h: H): Html =>
  h.nav(
    [h.Class(ui.segmented), h.AriaLabel("Range")],
    Array.map(USAGE_DAYS, (option) =>
      h.a(
        [
          h.Class(ui.segment),
          h.AriaCurrent(option === days ? "page" : "false"),
          h.Href(
            usageRouter({
              channel: routeChannel(model.route),
              days: Option.some(String(option)),
            }),
          ),
        ],
        [`${option} days`],
      ),
    ),
  );

const scheduleCard = (model: Model, schedule: typeof ScheduleRow.Type, h: H): Html => {
  const info = describeSpec(schedule.spec);
  return h.keyed("div")(
    String(schedule.id),
    [h.Class(ui.card)],
    [
      h.div(
        [h.Class(ui.cardWhen)],
        [
          h.span([h.Class(ui.cardCountdown)], [until(schedule.nextAt)]),
          h.span(
            [h.Class(`${ui.muted} ${ui.mono}`)],
            [
              `${inZone(schedule.nextAt, info.timezone)} ${info.timezone === "UTC" ? "UTC" : ""}`.trim(),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class(ui.cardBody)],
        [
          h.div(
            [h.Class(ui.cardHead)],
            [
              h.span([h.Class(ui.badge)], [info.kind]),
              h.span([h.Class(ui.strong)], [info.cadence]),
              h.span([h.Class(`${ui.muted} ${ui.mono}`)], [`#${schedule.id}`]),
            ],
          ),
          h.div([h.Class(ui.clamp3)], [schedule.prompt]),
          h.div(
            [h.Class(ui.cardFoot)],
            [
              h.span(
                [h.Class(`${ui.muted} ${ui.mono}`)],
                [info.kind === "cron" ? `${info.detail} · ${info.timezone}` : info.detail],
              ),
              actionButton(model, "cancel", schedule.id, "Cancel", h),
            ],
          ),
        ],
      ),
    ],
  );
};

const schedulesView = (model: Model, channel: string, h: H): Html =>
  remote(schedulesQuery.read(model.schedules, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("No active schedules.", h),
      onNonEmpty: (schedules) =>
        h.div(
          [h.Class(ui.stack)],
          [
            h.p(
              [h.Class(ui.muted)],
              [
                `${schedules.length} active, soonest first. Times are in each schedule's own time zone.`,
              ],
            ),
            h.div(
              [h.Class(ui.cards)],
              Array.map(schedules, (schedule) => scheduleCard(model, schedule, h)),
            ),
          ],
        ),
    }),
  );

type AgentEditor = {
  readonly kind: AgentKind;
  readonly id: string;
  readonly fields: { readonly [key: string]: string };
};

const editorFor = (model: Model, kind: AgentKind): Option.Option<AgentEditor> =>
  Option.flatMap(model.editor, (editor) =>
    editor.kind === kind ? Option.some(editor) : Option.none(),
  );

const agentField = (label: string, control: Html, h: H): Html =>
  h.div(
    [h.Class(ui.field)],
    [h.div([h.Class(ui.fieldLabel)], [h.span([h.Class(ui.strong)], [label])]), control, h.empty],
  );

const agentText = (
  key: string,
  label: string,
  value: string,
  h: H,
  placeholder?: string,
  disabled = false,
): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("text"),
      h.AriaLabel(label),
      ...(placeholder === undefined ? [] : [h.Placeholder(placeholder)]),
      ...(disabled ? [h.Disabled(true)] : []),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentTextarea = (
  key: string,
  label: string,
  value: string,
  h: H,
  placeholder?: string,
  tall = false,
): Html =>
  agentField(
    label,
    h.textarea([
      h.Class(ui.textarea),
      ...(tall ? [h.Style({ minHeight: "260px" })] : []),
      h.AriaLabel(label),
      ...(placeholder === undefined ? [] : [h.Placeholder(placeholder)]),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentNumber = (key: string, label: string, value: string, min: string, h: H): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("number"),
      h.Min(min),
      h.Step("1"),
      h.AriaLabel(label),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentDate = (key: string, label: string, value: string, h: H): Html =>
  agentField(
    label,
    h.input([
      h.Class(`${ui.input} ${ui.fullWidth}`),
      h.Type("date"),
      h.AriaLabel(label),
      h.Value(value),
      h.OnInput((next) => Message.UpdatedAgentField({ key, value: next })),
    ]),
    h,
  );

const agentPinned = (value: string, h: H): Html =>
  agentField("Pinned", h.span([h.Class(ui.badge)], [value === "1" ? "yes" : "no"]), h);

const agentDecision = (value: string, h: H): Html =>
  agentField(
    "Decision",
    h.select(
      [
        h.Class(ui.select),
        h.AriaLabel("Decision"),
        h.OnChange((next) => Message.UpdatedAgentField({ key: "decision", value: next })),
      ],
      Array.map(["allow", "ask", "deny"], (choice) =>
        h.option([h.Value(choice), h.Selected(value === choice)], [choice]),
      ),
    ),
    h,
  );

const agentReady = (editor: AgentEditor): boolean => {
  const fields = editor.fields;
  if (editor.kind === "profile") return true;
  if (editor.kind === "skills") {
    const name = editor.id || (fields.name ?? "");
    return (
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) &&
      (fields.description ?? "").trim() !== "" &&
      (fields.body ?? "").trim() !== ""
    );
  }
  if (editor.kind === "intents") {
    const maxFires = Number(fields.maxFires);
    const cooldownHours = Number(fields.cooldownHours);
    return (
      (fields.description ?? "").trim() !== "" &&
      (fields.triggers ?? "").trim() !== "" &&
      (fields.expires ?? "") !== "" &&
      Number.isInteger(maxFires) &&
      maxFires >= 1 &&
      Number.isFinite(cooldownHours) &&
      cooldownHours >= 0
    );
  }
  return (fields.match ?? "").trim() !== "";
};

const agentForm = (
  model: Model,
  editor: AgentEditor,
  h: H,
  destructive?: { readonly label: string },
): Html => {
  const fields = editor.fields;
  const ready = agentReady(editor);
  const armed = Option.contains(model.armed, `agent-remove:${editor.kind}:${editor.id}`);
  const controls =
    editor.kind === "profile"
      ? [
          agentTextarea(
            "about",
            "About",
            fields.about ?? "",
            h,
            "Who the user is, in a few lines.",
          ),
          agentTextarea("rules", "Rules", fields.rules ?? "", h, "One rule per line."),
        ]
      : editor.kind === "skills"
        ? [
            agentText(
              "name",
              "Name",
              editor.id || (fields.name ?? ""),
              h,
              "weekly-review",
              editor.id !== "",
            ),
            agentText("description", "When to use it", fields.description ?? "", h, "One line."),
            agentTextarea(
              "body",
              "Steps",
              fields.body ?? "",
              h,
              "Inputs, steps, output, checks, and what needs approval.",
              true,
            ),
            agentPinned(fields.pinned ?? "0", h),
          ]
        : editor.kind === "intents"
          ? [
              agentTextarea(
                "description",
                "What to do",
                fields.description ?? "",
                h,
                "An instruction to yourself.",
              ),
              agentText("triggers", "Triggers", fields.triggers ?? "", h, "launch, rollback"),
              agentDate("expires", "Expires", fields.expires ?? "", h),
              agentNumber("maxFires", "Max fires", fields.maxFires ?? "3", "1", h),
              agentNumber("cooldownHours", "Cooldown hours", fields.cooldownHours ?? "24", "0", h),
            ]
          : [
              agentText("match", "Match", fields.match ?? "", h, "gmail.send"),
              agentDecision(fields.decision ?? "ask", h),
            ];

  return h.div(
    [h.Class(ui.stack)],
    [
      h.div([h.Class(ui.form)], controls),
      h.div(
        [h.Class(ui.actions)],
        [
          h.button(
            [
              h.Type("button"),
              h.Class(ready ? ui.buttonPrimary : ui.button),
              h.Disabled(!ready),
              h.OnClick(Message.ClickedAgentSave()),
            ],
            ["Save"],
          ),
          ...(destructive === undefined || editor.id === ""
            ? []
            : [
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.buttonDanger),
                    h.OnClick(
                      Message.ClickedAgentRemove({
                        kind: editor.kind,
                        id: editor.id,
                      }),
                    ),
                  ],
                  [armed ? `Confirm ${destructive.label.toLowerCase()}` : destructive.label],
                ),
              ]),
          h.button(
            [h.Type("button"), h.Class(ui.button), h.OnClick(Message.ClickedAgentClose())],
            ["Close"],
          ),
        ],
      ),
    ],
  );
};

const agentNew = (kind: AgentKind, label: string, h: H): Html =>
  h.button(
    [h.Type("button"), h.Class(ui.buttonSmall), h.OnClick(Message.ClickedAgentNew({ kind }))],
    [label],
  );

const agentEdit = (kind: AgentKind, id: string, h: H): Html =>
  h.button(
    [h.Type("button"), h.Class(ui.buttonSmall), h.OnClick(Message.ClickedAgentEdit({ kind, id }))],
    ["Edit"],
  );

const profileBody = (model: Model, h: H) => {
  const editor = editorFor(model, "profile");
  if (Option.isSome(editor)) return agentForm(model, editor.value, h);
  return remote(profileQuery.read(model.profile), h, skeletonView(h, 1), (profile) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.titleRow)],
          [
            h.p([h.Class(ui.muted)], ["Shared by every agent."]),
            h.button(
              [
                h.Type("button"),
                h.Class(ui.buttonSmall),
                h.OnClick(Message.ClickedAgentEdit({ kind: "profile", id: "" })),
              ],
              ["Edit"],
            ),
          ],
        ),
        h.div(
          [h.Class(ui.listStatic)],
          [
            h.div(
              [h.Class(ui.keyValue)],
              [
                h.span([h.Class(ui.strong)], ["About"]),
                h.span(
                  [h.Class(ui.text)],
                  [profile.about.trim() === "" ? "Nothing saved yet." : profile.about],
                ),
              ],
            ),
            h.div(
              [h.Class(ui.keyValue)],
              [
                h.span([h.Class(ui.strong)], ["Rules"]),
                profile.rules.length === 0
                  ? h.span([h.Class(ui.muted)], ["None yet."])
                  : h.ul(
                      [h.Class(ui.bullets)],
                      profile.rules.map((rule, index) => h.keyed("li")(String(index), [], [rule])),
                    ),
              ],
            ),
          ],
        ),
      ],
    ),
  );
};

const skillsBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "skills");
  if (Option.isSome(editor)) {
    return agentForm(
      model,
      editor.value,
      h,
      editor.value.fields.pinned === "1" ? undefined : { label: "Delete skill" },
    );
  }
  return remote(skillsQuery.read(model.skills, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("skills", "New skill", h)]),
        Array.match(rows, {
          onEmpty: () =>
            emptyView("No skills yet. The agent saves one after a repeatable task.", h),
          onNonEmpty: (list) =>
            tableView(
              [
                th("Skill", h),
                th("When to use it", h),
                th("Pinned", h),
                th("Uses", h, true),
                th("Last used", h),
                th("Actions", h),
              ],
              Array.map(list, (skill: typeof SkillRow.Type) =>
                h.keyed("tr")(
                  skill.name,
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [skill.name]),
                    h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [skill.description])]),
                    h.td([h.Class(ui.tdFit)], [skill.pinned ? "yes" : "–"]),
                    h.td([h.Class(ui.tdNum)], [count(skill.useCount)]),
                    h.td(
                      [h.Class(ui.tdFit)],
                      [skill.usedAt === null ? "never" : ago(skill.usedAt)],
                    ),
                    h.td([h.Class(ui.td)], [agentEdit("skills", skill.name, h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

const intentStateColor = (state: string): string =>
  state === "armed"
    ? "var(--colors-ok)"
    : state === "expired"
      ? "var(--colors-warn)"
      : "var(--colors-fg-muted)";

const intentsBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "intents");
  if (Option.isSome(editor)) {
    const current = Option.getOrElse(
      AsyncData.getData(intentsQuery.read(model.intents, { channel })),
      () => [],
    ).find((intent) => String(intent.id) === editor.value.id);
    return agentForm(
      model,
      editor.value,
      h,
      current?.state === "armed" ? { label: "Cancel intent" } : undefined,
    );
  }
  return remote(intentsQuery.read(model.intents, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("intents", "New intent", h)]),
        Array.match(rows, {
          onEmpty: () => emptyView("No standing intents.", h),
          onNonEmpty: (list) =>
            tableView(
              [
                th("#", h),
                th("State", h),
                th("Triggers", h),
                th("What to do", h),
                th("Fires", h, true),
                th("Expires", h),
                th("Actions", h),
              ],
              Array.map(list, (intent: typeof IntentRow.Type) =>
                h.keyed("tr")(
                  String(intent.id),
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [`#${intent.id}`]),
                    h.td(
                      [h.Class(ui.td)],
                      [
                        h.span(
                          [h.Class(ui.badge), h.Style({ color: intentStateColor(intent.state) })],
                          [intent.state],
                        ),
                      ],
                    ),
                    h.td([h.Class(ui.tdMono)], [intent.triggers.join(", ")]),
                    h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [intent.description])]),
                    h.td([h.Class(ui.tdNum)], [`${intent.fireCount}/${intent.maxFires}`]),
                    h.td([h.Class(ui.tdFitMono)], [when(intent.expires, h)]),
                    h.td([h.Class(ui.td)], [agentEdit("intents", String(intent.id), h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

const decisionColor = (decision: string): string =>
  decision === "allow"
    ? "var(--colors-ok)"
    : decision === "deny"
      ? "var(--colors-danger)"
      : "var(--colors-warn)";

const policiesBody = (model: Model, channel: string, h: H): Html => {
  const editor = editorFor(model, "policies");
  if (Option.isSome(editor)) {
    return agentForm(model, editor.value, h, { label: "Remove policy" });
  }
  return remote(policiesQuery.read(model.policies, { channel }), h, skeletonView(h, 1), (rows) =>
    h.div(
      [h.Class(ui.section)],
      [
        h.div([h.Class(ui.toolbar)], [agentNew("policies", "New policy", h)]),
        Array.match(rows, {
          onEmpty: () =>
            emptyView("No policies. Every executor action asks or runs as it did before.", h),
          onNonEmpty: (list) =>
            tableView(
              [th("#", h), th("Decision", h), th("Match", h), th("Actions", h)],
              Array.map(list, (policy: typeof PolicyRow.Type) =>
                h.keyed("tr")(
                  String(policy.id),
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(ui.tdMono)], [`#${policy.id}`]),
                    h.td(
                      [h.Class(ui.td)],
                      [
                        h.span(
                          [h.Class(ui.badge), h.Style({ color: decisionColor(policy.decision) })],
                          [policy.decision],
                        ),
                      ],
                    ),
                    h.td([h.Class(ui.tdMono)], [policy.match]),
                    h.td([h.Class(ui.td)], [agentEdit("policies", String(policy.id), h)]),
                  ],
                ),
              ),
              h,
            ),
        }),
      ],
    ),
  );
};

const agentView = (model: Model, channel: string, h: H): Html =>
  h.div(
    [h.Class(ui.stack)],
    [
      sectionView("Skills", skillsBody(model, channel, h), h),
      sectionView("Standing intents", intentsBody(model, channel, h), h),
      sectionView("Policies", policiesBody(model, channel, h), h),
    ],
  );

const runStatusColor = (status: string): string =>
  status === "succeeded"
    ? "var(--colors-ok)"
    : status === "failed"
      ? "var(--colors-danger)"
      : status === "running"
        ? "var(--colors-warn)"
        : "var(--colors-fg-muted)";

const duration = (run: typeof RunRow.Type): string => {
  if (run.finished === null) return "running";
  const ms = Math.max(0, run.finished - run.started);
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
};

const runsView = (model: Model, channel: string, h: H): Html =>
  remote(runsQuery.read(model.runs, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("No schedule has run yet.", h),
      onNonEmpty: (list) =>
        tableView(
          [
            th("#", h),
            th("Schedule", h),
            th("Status", h),
            th("Started", h),
            th("Took", h),
            th("Result", h),
          ],
          Array.map(list, (run: typeof RunRow.Type) =>
            h.keyed("tr")(
              String(run.id),
              [h.Class(ui.row)],
              [
                h.td([h.Class(ui.tdMono)], [`#${run.id}`]),
                h.td([h.Class(ui.tdMono)], [`#${run.scheduleId}`]),
                h.td(
                  [h.Class(ui.td)],
                  [
                    h.span(
                      [h.Class(ui.badge), h.Style({ color: runStatusColor(run.status) })],
                      [run.status],
                    ),
                  ],
                ),
                h.td([h.Class(ui.tdFitMono)], [when(run.started, h)]),
                h.td([h.Class(ui.tdFit)], [duration(run)]),
                h.td(
                  [h.Class(ui.td)],
                  [
                    h.div(
                      [h.Class(run.error === null ? ui.clamp : `${ui.text} ${ui.danger}`)],
                      [run.error ?? run.output],
                    ),
                  ],
                ),
              ],
            ),
          ),
          h,
        ),
    }),
  );

const SETTINGS: ReadonlyArray<{
  readonly key: SettingKey;
  readonly label: string;
  readonly hint: string;
  readonly multiline: boolean;
}> = [
  { key: "model", label: "Model", hint: "provider/model id", multiline: false },
  { key: "budget", label: "Daily budget", hint: "dollars, 0 for none", multiline: false },
  { key: "timezone", label: "Time zone", hint: "IANA name, like Asia/Jakarta", multiline: false },
  {
    key: "instructions",
    label: "Instructions",
    hint: "added to the system prompt",
    multiline: true,
  },
];

const settingsView = (model: Model, channel: string, h: H): Html =>
  remote(overviewQuery.read(model.overview, { channel }), h, skeletonView(h, 2), (data) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.p(
          [h.Class(ui.muted)],
          [
            "Saved on this channel only, as its slash commands would. Empty it and save, or reset, to use the default again.",
          ],
        ),
        h.div(
          [h.Class(ui.form)],
          Array.map(SETTINGS, (setting) => {
            const saved = data.settings[setting.key];
            const draft = Record.get(model.drafts, setting.key);
            const shown = Option.getOrElse(draft, () => saved ?? "");
            const changed = Option.isSome(draft) && shown !== (saved ?? "");
            const field = setting.multiline
              ? h.textarea([
                  h.Class(ui.textarea),
                  h.AriaLabel(setting.label),
                  h.Placeholder("default"),
                  h.Value(shown),
                  h.OnInput((value) => Message.UpdatedDraft({ key: setting.key, value })),
                ])
              : h.input([
                  h.Class(`${ui.input} ${ui.fullWidth}`),
                  h.Type("text"),
                  h.AriaLabel(setting.label),
                  h.Placeholder("default"),
                  h.Value(shown),
                  h.OnInput((value) => Message.UpdatedDraft({ key: setting.key, value })),
                ]);
            return h.keyed("div")(
              setting.key,
              [h.Class(ui.field)],
              [
                h.div(
                  [h.Class(ui.fieldLabel)],
                  [
                    h.span([h.Class(ui.strong)], [setting.label]),
                    h.span([h.Class(`${ui.muted} ${ui.mono}`)], [setting.hint]),
                  ],
                ),
                field,
                h.div(
                  [h.Class(ui.toolbar)],
                  [
                    h.button(
                      [
                        h.Type("button"),
                        h.Class(changed ? ui.buttonPrimary : ui.button),
                        h.Disabled(!changed),
                        h.OnClick(Message.ClickedSave({ key: setting.key })),
                      ],
                      ["Save"],
                    ),
                    saved === undefined
                      ? h.empty
                      : h.button(
                          [
                            h.Type("button"),
                            h.Class(ui.button),
                            h.OnClick(Message.ClickedResetSetting({ key: setting.key })),
                          ],
                          ["Reset"],
                        ),
                  ],
                ),
              ],
            );
          }),
        ),
      ],
    ),
  );

const deleteButton = (model: Model, row: typeof ArtifactRow.Type, h: H): Html => {
  const armed = Option.contains(model.armed, `artifact-delete:${row.name}`);
  return h.button(
    [
      h.Type("button"),
      h.Class(armed ? ui.buttonSmallArmed : ui.buttonSmall),
      h.OnClick(Message.ClickedArtifact({ name: row.name, action: "delete" })),
    ],
    [armed ? "Confirm delete" : "Delete"],
  );
};

const kindLabel = (contentType: string): string => {
  const type = contentType.split(";")[0] ?? "";
  return type.includes("table")
    ? "table"
    : type.includes("chart")
      ? "chart"
      : type.includes("markdown")
        ? "markdown"
        : type.includes("html")
          ? "html"
          : (type.split("/")[1] ?? "file");
};

const visibilityToggle = (row: typeof ArtifactRow.Type, h: H): Html =>
  h.div(
    [h.Class(ui.segmented), h.Role("group"), h.AriaLabel(`Link of ${row.name}`)],
    Array.map(["public", "private"] as const, (choice) => {
      const on = row.visibility === choice;
      return h.button(
        [
          h.Type("button"),
          h.Class(ui.segment),
          h.AriaCurrent(on ? "page" : "false"),
          ...(on ? [] : [h.OnClick(Message.ClickedArtifact({ name: row.name, action: choice }))]),
        ],
        [choice],
      );
    }),
  );

const artifactCard = (model: Model, channel: string, row: typeof ArtifactRow.Type, h: H): Html => {
  const isPublic = row.visibility === "public";
  return h.keyed("div")(
    row.name,
    [h.Class(ui.card)],
    [
      h.div(
        [h.Class(isPublic ? ui.cardWhen : `${ui.cardWhen} ${ui.tileHatch}`)],
        [
          h.span([h.Class(ui.tileKind)], [kindLabel(row.contentType)]),
          h.span([h.Class(`${ui.muted} ${ui.mono}`)], [`v${row.version}`]),
        ],
      ),
      h.div(
        [h.Class(ui.cardBody)],
        [
          h.div(
            [h.Class(ui.cardHead)],
            [h.span([h.Class(`${ui.strong} ${ui.artifactName}`)], [row.name])],
          ),
          h.div(
            [h.Class(`${ui.muted} ${ui.mono}`)],
            [`${row.contentType.split(";")[0] ?? ""} · updated ${ago(row.updated)}`],
          ),
          h.div(
            [h.Class(`${ui.urlLine} ${isPublic ? "" : ui.urlOff}`)],
            [isPublic ? row.url : "Link closed"],
          ),
          h.div(
            [h.Class(ui.cardFoot)],
            [
              visibilityToggle(row, h),
              h.div(
                [h.Class(ui.actionsRow)],
                [
                  ...(isPublic
                    ? [
                        h.a(
                          [
                            h.Class(ui.buttonSmall),
                            h.Href(row.url),
                            h.Target("_blank"),
                            h.Rel("noopener noreferrer"),
                          ],
                          ["Open"],
                        ),
                      ]
                    : []),
                  h.a(
                    [
                      h.Class(ui.buttonSmall),
                      h.Href(
                        artifactsRouter({
                          channel: Option.some(channel),
                          name: Option.some(row.name),
                        }),
                      ),
                    ],
                    ["Source"],
                  ),
                  deleteButton(model, row, h),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  );
};

const artifactSourceView = (model: Model, channel: string, name: string, h: H): Html =>
  remote(artifactQuery.read(model.artifact, { channel, name }), h, skeletonView(h, 1), (data) =>
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.metaRow)],
          [
            h.span([h.Class(ui.strong)], [data.artifact.name]),
            h.span([h.Class(ui.mono)], [data.artifact.contentType]),
            h.span([h.Class(ui.mono)], [`${count(data.size)} bytes`]),
            h.a(
              [
                h.Class(ui.link),
                h.Href(artifactsRouter({ channel: Option.some(channel), name: Option.none() })),
              ],
              ["Close"],
            ),
          ],
        ),
        h.pre([h.Class(ui.pre)], [data.text]),
      ],
    ),
  );

const composerView = (model: Model, h: H): Html => {
  const { name, kind, content } = model.composer;
  const ready = name.trim() !== "" && content.trim() !== "";
  return sectionView(
    "Publish",
    h.div(
      [h.Class(ui.stack)],
      [
        h.div(
          [h.Class(ui.toolbar)],
          [
            h.input([
              h.Class(ui.input),
              h.Type("text"),
              h.AriaLabel("Name"),
              h.Placeholder(kind === "html" ? "my-page.html" : "my-notes"),
              h.Value(name),
              h.OnInput((value) => Message.UpdatedComposer({ field: "name", value })),
            ]),
            h.div(
              [h.Class(ui.segmented), h.Role("group"), h.AriaLabel("Kind")],
              Array.map(["markdown", "html"] as const, (choice) =>
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.segment),
                    h.AriaCurrent(kind === choice ? "page" : "false"),
                    h.OnClick(Message.UpdatedComposer({ field: "kind", value: choice })),
                  ],
                  [choice],
                ),
              ),
            ),
          ],
        ),
        h.textarea([
          h.Class(ui.composerBody),
          h.AriaLabel("Content"),
          h.Placeholder(kind === "html" ? "<h1>Paste HTML</h1>" : "# Paste Markdown"),
          h.Value(content),
          h.OnInput((value) => Message.UpdatedComposer({ field: "content", value })),
        ]),
        h.div(
          [h.Class(ui.toolbar)],
          [
            h.button(
              [
                h.Type("button"),
                h.Class(ui.buttonPrimary),
                h.Disabled(!ready),
                h.OnClick(Message.ClickedPublish()),
              ],
              ["Publish"],
            ),
          ],
        ),
      ],
    ),
    h,
  );
};

const artifactsView = (model: Model, channel: string, name: Option.Option<string>, h: H): Html =>
  remote(artifactsQuery.read(model.artifacts, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("No artifacts have been published.", h),
      onNonEmpty: (list) =>
        h.div(
          [h.Class(ui.stack)],
          [
            h.div(
              [h.Class(ui.cards)],
              Array.map(list, (row) => artifactCard(model, channel, row, h)),
            ),
            ...Option.match(name, {
              onNone: () => [],
              onSome: (value) => [
                sectionView("Source", artifactSourceView(model, channel, value, h), h),
              ],
            }),
          ],
        ),
    }),
  );

const auditView = (model: Model, channel: string, h: H): Html =>
  remote(auditQuery.read(model.audit, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("Nothing has been done from the dashboard yet.", h),
      onNonEmpty: (list) =>
        tableView(
          [th("When (UTC)", h), th("Who", h), th("Action", h), th("Target", h), th("Result", h)],
          Array.map(list, (row) =>
            h.keyed("tr")(
              `${row.at}:${row.action}:${row.target}`,
              [h.Class(ui.row)],
              [
                h.td([h.Class(ui.tdFitMono)], [when(row.at, h)]),
                h.td([h.Class(ui.td)], [row.who]),
                h.td([h.Class(ui.tdMono)], [row.action]),
                h.td([h.Class(ui.tdMono)], [row.target === 0 ? "–" : `#${row.target}`]),
                h.td(
                  [h.Class(ui.td)],
                  [
                    h.span(
                      [
                        h.Class(ui.badge),
                        h.Style({ color: row.ok ? "var(--colors-ok)" : "var(--colors-danger)" }),
                      ],
                      [row.ok ? "done" : "gone"],
                    ),
                  ],
                ),
              ],
            ),
          ),
          h,
        ),
    }),
  );

const channelSelect = (model: Model, h: H): Html =>
  AsyncData.matchData(channelsRead(model.channels), {
    onEmpty: () => h.div([h.Class(ui.skeleton), h.Style({ width: "160px", height: "36px" })]),
    onFailure: () => h.empty,
    onData: (channels) => {
      const selected = Option.getOrElse(currentChannel(model), () => "");
      return h.select(
        [
          h.Class(ui.select),
          h.AriaLabel("Agent"),
          h.OnChange((channel) => Message.SelectedChannel({ channel })),
        ],
        Array.map(channels, (channel) =>
          h.option(
            [h.Value(channel.doName), h.Selected(channel.doName === selected)],
            [channel.name],
          ),
        ),
      );
    },
  });

/** Destinations grouped in order, keeping the first appearance of each group. */
const groupsOf = (items: ReadonlyArray<Destination>) =>
  items.reduce<Array<readonly [string, Array<Destination>]>>((groups, item) => {
    const last = groups[groups.length - 1];
    if (last !== undefined && last[0] === item.group) last[1].push(item);
    else groups.push([item.group, [item]]);
    return groups;
  }, []);

const modKey = (model: Model): string => (model.apple ? "⌘" : "Ctrl ");

const jumpButton = (model: Model, h: H): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(ui.jump),
      h.AriaKeyshortcuts(model.apple ? "Meta+K" : "Control+K"),
      h.OnClick(Message.PressedPalette()),
    ],
    [
      icon(h, "search", 14),
      "Jump to",
      h.span([h.Class(ui.spacer)]),
      h.kbd([h.Class(ui.railKey)], [`${modKey(model)}K`]),
    ],
  );

/** The ⌘K menu: every section, then every agent, filtered as you type. */
const paletteView = (model: Model, h: H): Html =>
  PaletteState.match(model.palette, {
    Closed: () => h.empty,
    Open: (open) => openPaletteView(model, h, open),
  });

const openPaletteView = (
  model: Model,
  h: H,
  open: Extract<PaletteState, { readonly _tag: "Open" }>,
): Html => {
  const found = matches(model, currentChannel(model));
  const index = Math.min(open.index, Math.max(found.length - 1, 0));
  const optionId = (at: number) => `palette-option-${at}`;
  let at = -1;
  return h.div(
    [h.Class(ui.paletteLayer)],
    [
      h.div([h.Class(ui.paletteBackdrop), h.OnClick(Message.ClosedPalette())], []),
      h.div(
        [h.Class(ui.palette), h.Role("dialog"), h.AriaModal(true), h.AriaLabel("Jump to")],
        [
          h.div(
            [h.Class(ui.paletteSearch)],
            [
              icon(h, "search", 18),
              h.input([
                h.Id("palette-input"),
                h.Class(ui.paletteInput),
                h.Type("text"),
                h.Role("combobox"),
                h.AriaExpanded(true),
                h.AriaControls("palette-list"),
                h.AriaAutocomplete("list"),
                ...(found.length === 0 ? [] : [h.AriaActiveDescendant(optionId(index))]),
                h.Placeholder("Jump to a section or agent"),
                h.Autocomplete("off"),
                h.Value(open.query),
                h.OnInput((value) => Message.TypedPaletteQuery({ value })),
                h.OnKeyDownPreventDefault((key) =>
                  key === "ArrowDown"
                    ? Option.some(Message.MovedPaletteSelection({ by: 1 }))
                    : key === "ArrowUp"
                      ? Option.some(Message.MovedPaletteSelection({ by: -1 }))
                      : key === "Enter"
                        ? Option.some(Message.ChosePalette({ index }))
                        : Option.none(),
                ),
              ]),
              h.kbd([h.Class(ui.railKey)], ["Esc"]),
            ],
          ),
          found.length === 0
            ? h.div([h.Class(ui.paletteEmpty)], ["No match"])
            : h.div(
                [h.Id("palette-list"), h.Class(ui.paletteList), h.Role("listbox")],
                Array.map(groupsOf(found), ([group, items]) =>
                  h.keyed("div")(
                    group,
                    [h.Role("group"), h.AriaLabel(group)],
                    [
                      h.div([h.Class(ui.railLabel), h.AriaHidden(true)], [group]),
                      ...items.map((item) => {
                        at += 1;
                        const mine = at;
                        return h.keyed("div")(
                          item.id,
                          [
                            h.Id(optionId(mine)),
                            h.Class(ui.paletteItem),
                            h.Role("option"),
                            h.AriaSelected(mine === index),
                            h.OnClick(Message.ChosePalette({ index: mine })),
                          ],
                          [
                            icon(h, item.glyph, 16),
                            h.span([h.Class(ui.spacer)], [item.label]),
                            ...(item.active ? [h.span([h.Class(ui.paletteHere)], ["Here"])] : []),
                            ...(item.key === undefined
                              ? []
                              : [h.kbd([h.Class(ui.railKey)], [`G ${item.key.toUpperCase()}`])]),
                          ],
                        );
                      }),
                    ],
                  ),
                ),
              ),
        ],
      ),
    ],
  );
};

const railView = (model: Model, h: H): Html =>
  h.nav(
    [h.Class(ui.rail), h.AriaLabel("Sections")],
    [
      h.div(
        [h.Class(ui.railTop)],
        [
          h.a([h.Class(ui.brand), h.Href("/c")], [h.span([h.Class(ui.mark)]), "Mizook"]),
          channelSelect(model, h),
          jumpButton(model, h),
        ],
      ),
      ...Array.map(groupsOf(sections(model)), ([group, items]) =>
        h.keyed("div")(
          group,
          [h.Class(ui.railGroup)],
          [
            h.div([h.Class(ui.railLabel)], [group]),
            ...items.map((item) =>
              h.keyed("a")(
                item.id,
                [
                  h.Class(ui.railItem),
                  h.Href(item.href),
                  h.AriaCurrent(item.active ? "page" : "false"),
                  ...(item.key === undefined ? [] : [h.AriaKeyshortcuts(`g ${item.key}`)]),
                ],
                [
                  icon(h, item.glyph, 16),
                  item.label,
                  ...(item.key === undefined
                    ? []
                    : [
                        h.kbd(
                          [h.Class(ui.railKey), h.AriaHidden(true)],
                          [`G ${item.key.toUpperCase()}`],
                        ),
                      ]),
                ],
              ),
            ),
          ],
        ),
      ),
      h.a(
        [h.Class(ui.railFoot), h.Href("/c")],
        [icon(h, "thread", 16), "Web chat", h.span([h.Class(ui.spacer)]), icon(h, "external", 14)],
      ),
    ],
  );

const PAGE_NAMES: Record<AppRoute["_tag"], string> = {
  Overview: "Overview",
  Log: "Log",
  Entry: "Log",
  Memory: "Memory",
  Usage: "Usage",
  Schedules: "Automations",
  Agent: "Skills",
  Profile: "Profile",
  Runs: "Runs",
  Settings: "Settings",
  Audit: "Audit",
  Artifacts: "Artifacts",
  NotFound: "Not found",
};

const agentName = (model: Model): string =>
  AsyncData.matchData(channelsRead(model.channels), {
    onEmpty: () => "",
    onFailure: () => "",
    onData: (channels) => {
      const selected = Option.getOrElse(currentChannel(model), () => "");
      return channels.find((channel) => channel.doName === selected)?.name ?? "";
    },
  });

const noticeView = (model: Model, h: H): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (text) => h.div([h.Class(ui.notice), h.Role("status")], [text]),
  });

const pageView = (model: Model, h: H): Html =>
  Option.match(currentChannel(model), {
    onNone: () =>
      AsyncData.matchData(channelsRead(model.channels), {
        onEmpty: () => skeletonView(h, 2),
        onFailure: (error) => errorView(error, h),
        onData: () => emptyView("No channel has been used yet.", h),
      }),
    onSome: (channel) =>
      AppRoute.match<Html>(model.route, {
        Overview: () =>
          h.div(
            [h.Class(ui.page)],
            [titleView("Overview", [], h), overviewView(model, channel, h)],
          ),
        Log: () => h.div([h.Class(ui.page)], [titleView("Log", [], h), logView(model, channel, h)]),
        Entry: ({ entryId }) =>
          h.div(
            [h.Class(ui.page)],
            [titleView(`Message ${entryId}`, [], h), entryView(model, channel, entryId, h)],
          ),
        Memory: () =>
          h.div([h.Class(ui.page)], [titleView("Memory", [], h), memoryView(model, channel, h)]),
        Usage: ({ days }) =>
          h.div(
            [h.Class(ui.page)],
            [
              titleView("Usage", [rangeView(model, daysOf(days), h)], h),
              usageView(model, channel, daysOf(days), h),
            ],
          ),
        Schedules: () =>
          h.div(
            [h.Class(ui.page)],
            [titleView("Automations", [], h), schedulesView(model, channel, h)],
          ),
        Agent: () =>
          h.div([h.Class(ui.page)], [titleView("Skills", [], h), agentView(model, channel, h)]),
        Profile: () =>
          h.div(
            [h.Class(ui.page)],
            [
              titleView("Profile", [], h),
              sectionView("Shared by every agent", profileBody(model, h), h),
            ],
          ),
        Runs: () =>
          h.div([h.Class(ui.page)], [titleView("Runs", [], h), runsView(model, channel, h)]),
        Settings: () =>
          h.div(
            [h.Class(ui.page)],
            [titleView("Settings", [], h), settingsView(model, channel, h)],
          ),
        Artifacts: ({ name }) =>
          h.div(
            [h.Class(ui.page)],
            [
              titleView("Artifacts", [], h),
              composerView(model, h),
              artifactsView(model, channel, name, h),
            ],
          ),
        Audit: () =>
          h.div([h.Class(ui.page)], [titleView("Audit", [], h), auditView(model, channel, h)]),
        NotFound: () =>
          h.div(
            [h.Class(ui.page)],
            [
              titleView("Not found", [], h),
              h.a(
                [
                  h.Class(ui.link),
                  h.Href(routeHref(AppRoute.Overview({ channel: Option.none() }))),
                ],
                ["Back to the overview"],
              ),
            ],
          ),
      }),
  });

export const view = (model: Model, h: H): Document => {
  const page = PAGE_NAMES[model.route._tag];
  const agent = agentName(model);
  return {
    title: agent === "" ? `${page} · Mizook` : `${page} · ${agent} · Mizook`,
    body: h.div(
      [h.Class(ui.root)],
      [
        railView(model, h),
        h.div(
          [h.Class(ui.column)],
          [
            h.header(
              [h.Class(ui.header)],
              [
                h.details(
                  [h.Class(ui.mobileNav)],
                  [
                    h.summary(
                      [h.Class(ui.mobileNavButton), h.AriaLabel("Sections")],
                      [icon(h, "menu", 20)],
                    ),
                    railView(model, h),
                  ],
                ),
                h.span([h.Class(ui.crumb)], [agent]),
                h.span([h.Class(ui.crumbSlash), h.AriaHidden(true)], ["/"]),
                h.span([h.Class(ui.crumbPage)], [page]),
                h.span([h.Class(ui.spacer)]),
                h.button(
                  [
                    h.Type("button"),
                    h.Class(ui.headerJump),
                    h.AriaLabel("Jump to"),
                    h.Title(`Jump to (${modKey(model)}K)`),
                    h.OnClick(Message.PressedPalette()),
                  ],
                  [icon(h, "search", 18)],
                ),
              ],
            ),
            h.main([h.Class(ui.main)], [noticeView(model, h), pageView(model, h)]),
          ],
        ),
        paletteView(model, h),
      ],
    ),
  };
};
