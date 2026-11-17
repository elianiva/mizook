import { Array, Option, Record, pipe } from "effect";
import { AsyncData } from "foldkit";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import {
  type LogMessage,
  type ActionKind,
  type SettingKey,
  type UsageReport,
  auditQuery,
  recentQuery,
  summaryQuery,
  entryQuery,
  logQuery,
  memoryQuery,
  overviewQuery,
  schedulesQuery,
  usageQuery,
} from "./api.ts";
import { ago, count, dateTime, epochDateTime, percent, usd } from "./format.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import {
  AppRoute,
  USAGE_DAYS,
  daysOf,
  entryRouter,
  logRouter,
  memoryRouter,
  auditRouter,
  overviewRouter,
  settingsRouter,
  routeChannel,
  routeHref,
  schedulesRouter,
  textOf,
  usageRouter,
} from "./route.ts";
import { currentChannel } from "./update.ts";
import { channelsQuery } from "./api.ts";

const channelsRead = channelsQuery.read;
import { ui } from "./ui.ts";

type H = HtmlBuilder<Message>;

const PAGE_SIZE = 50;

// PIECES

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

const statView = (label: string, value: string, h: H): Html =>
  h.div(
    [h.Class(ui.stat)],
    [h.span([h.Class(ui.statLabel)], [label]), h.span([h.Class(ui.statValue)], [value])],
  );

const sectionView = (title: string, body: Html, h: H): Html =>
  h.section([h.Class(ui.section)], [h.h2([h.Class(ui.sectionTitle)], [title]), body]);

const titleView = (title: string, actions: ReadonlyArray<Html>, h: H): Html =>
  h.div([h.Class(ui.titleRow)], [h.h1([h.Class(ui.title)], [title]), ...actions]);

const badgeColor = (kind: string): string =>
  kind === "user"
    ? "var(--colors-accent)"
    : kind === "agent"
      ? "var(--colors-ok)"
      : kind === "tool"
        ? "var(--colors-warn)"
        : "var(--colors-fg-muted)";

const actionButton = (model: Model, action: ActionKind, id: number, label: string, h: H): Html => {
  const armed = Option.contains(model.armed, `${action}:${id}`);
  return h.button(
    [
      h.Type("button"),
      h.Class(armed ? `${ui.buttonSmall} ${ui.buttonArmed}` : ui.buttonSmall),
      h.OnClick(Message.ClickedAction({ action, id })),
    ],
    [armed ? `Confirm ${label.toLowerCase()}` : label],
  );
};

const kindBadge = (kind: string, h: H): Html =>
  h.span([h.Class(ui.badge), h.Style({ color: badgeColor(kind) })], [kind]);

const th = (label: string, h: H, numeric = false): Html =>
  h.th([h.Class(numeric ? `${ui.th} ${ui.thNum}` : ui.th), h.Scope("col")], [label]);

const tableView = (headers: ReadonlyArray<Html>, rows: ReadonlyArray<Html>, h: H): Html =>
  h.div(
    [h.Class(ui.tableWrap)],
    [h.table([h.Class(ui.table)], [h.thead([], [h.tr([], headers)]), h.tbody([], rows)])],
  );

// OVERVIEW

const meterColor = (used: number): string =>
  used >= 90 ? "var(--colors-danger)" : used >= 70 ? "var(--colors-warn)" : "var(--colors-ok)";

const recentRow = (m: LogMessage, channel: Option.Option<string>, h: H): Html =>
  h.keyed("tr")(
    String(m.i),
    [h.Class(ui.row)],
    [
      h.td(
        [h.Class(`${ui.td} ${ui.mono}`)],
        [h.a([h.Href(entryRouter({ entryId: m.i, channel })), h.Class(ui.link)], [String(m.i)])],
      ),
      h.td([h.Class(ui.td)], [kindBadge(m.kind, h)]),
      h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [m.cut ? `${m.text} …` : m.text])]),
      h.td([h.Class(`${ui.td} ${ui.tdFit} ${ui.mono}`)], [dateTime(m.date)]),
    ],
  );

const channelsTable = (model: Model, h: H): Html =>
  remote(summaryQuery.read(model.summary), h, skeletonView(h, 1), (rows) => {
    const current = Option.getOrElse(currentChannel(model), () => "");
    return tableView(
      [
        th("Channel", h),
        th("Active", h),
        th("Messages", h, true),
        th("24 h", h, true),
        th("7 d", h, true),
        th("Waiting", h, true),
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
            h.td([h.Class(`${ui.td} ${ui.tdFit}`)], [ago(row.lastActive)]),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(row.messages)]),
            h.td(
              [h.Class(`${ui.td} ${ui.tdNum}`)],
              [
                row.budget > 0
                  ? `${usd(row.spend24h)} · ${percent(row.spend24h, row.budget)}%`
                  : usd(row.spend24h),
              ],
            ),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [usd(row.spend7d)]),
            h.td(
              [h.Class(`${ui.td} ${ui.tdNum}`)],
              [
                row.pending + row.approvals === 0
                  ? "–"
                  : `${row.pending} turn${row.pending === 1 ? "" : "s"}, ${row.approvals} ask${row.approvals === 1 ? "" : "s"}`,
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

const overviewView = (model: Model, channel: string, h: H): Html =>
  remote(overviewQuery.read(model.overview, { channel }), h, skeletonView(h, 3), (data) => {
    const budget = Number(data.settings["budget"] ?? 0);
    const used = percent(data.spend.last24h, budget);
    const maybeChannel = routeChannel(model.route);
    return h.div(
      [h.Class(ui.stack)],
      [
        budget > 0 ? budgetAlert(used, maybeChannel, h) : h.empty,
        h.div(
          [],
          [
            h.div(
              [h.Class(ui.grid)],
              [
                statView("Messages", count(data.messages), h),
                statView("Memory nodes", count(data.nodes), h),
                statView("View lines", count(data.viewLines), h),
                statView("Schedules", count(data.schedules), h),
                statView("Spend 24 h", usd(data.spend.last24h), h),
                statView("Spend 7 d", usd(data.spend.last7d), h),
                statView("Spend total", usd(data.spend.total), h),
              ],
            ),
            budget > 0
              ? h.div(
                  [h.Class(ui.budget)],
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
        sectionView("Channels", channelsTable(model, h), h),
        h.div(
          [h.Class(ui.columns)],
          [
            sectionView(
              "Running now",
              Array.match(data.turns, {
                onEmpty: () => emptyView("Nothing is running.", h),
                onNonEmpty: (turns) =>
                  h.div(
                    [h.Class(ui.list)],
                    Array.map(turns, (turn) =>
                      h.keyed("div")(
                        turn.chatId,
                        [h.Class(ui.listItem)],
                        [
                          h.span([h.Class(ui.text)], [turn.text]),
                          h.div([h.Class(ui.actions)], [actionButton(model, "stop", 0, "Stop", h)]),
                        ],
                      ),
                    ),
                  ),
              }),
              h,
            ),
            sectionView(
              "Approvals",
              Array.match(data.approvals, {
                onEmpty: () => emptyView("Nothing is waiting.", h),
                onNonEmpty: (approvals) =>
                  h.div(
                    [h.Class(ui.list)],
                    Array.map(approvals, (approval) =>
                      h.keyed("div")(
                        String(approval.id),
                        [h.Class(ui.listItem)],
                        [
                          h.span(
                            [h.Class(`${ui.mono} ${ui.muted}`)],
                            [`#${approval.id}${approval.posted ? "" : " · not posted"}`],
                          ),
                          h.span([h.Class(ui.text)], [approval.summary]),
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
                  ),
              }),
              h,
            ),
          ],
        ),
        sectionView(
          "Recent messages",
          remote(recentQuery.read(model.recent, { channel }), h, skeletonView(h, 1), (rows) =>
            Array.match(rows, {
              onEmpty: () => emptyView("No messages yet.", h),
              onNonEmpty: (list) =>
                tableView(
                  [th("ID", h), th("Kind", h), th("Message", h), th("Date (UTC)", h)],
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

// LOG

const KINDS = ["user", "agent", "tool", "echo", "note"];

const filterView = (model: Model, h: H): Html =>
  h.form(
    [h.Class(ui.toolbar), h.OnSubmit(Message.SubmittedFilter())],
    [
      h.select(
        [
          h.Class(ui.select),
          h.AriaLabel("Kind"),
          h.OnChange((value) => Message.UpdatedKindDraft({ value })),
        ],
        [
          h.option([h.Value(""), h.Selected(model.draftKind === "")], ["All kinds"]),
          ...Array.map(KINDS, (kind) =>
            h.option([h.Value(kind), h.Selected(model.draftKind === kind)], [kind]),
          ),
        ],
      ),
      h.input([
        h.Class(ui.input),
        h.Type("search"),
        h.AriaLabel("Search"),
        h.Placeholder("Search messages"),
        h.Value(model.draftSearch),
        h.OnInput((value) => Message.UpdatedSearchDraft({ value })),
      ]),
      h.button([h.Type("submit"), h.Class(ui.buttonPrimary)], ["Filter"]),
    ],
  );

const logRowView = (m: LogMessage, channel: Option.Option<string>, h: H): Html =>
  h.keyed("tr")(
    String(m.i),
    [h.Class(ui.row)],
    [
      h.td(
        [h.Class(`${ui.td} ${ui.mono}`)],
        [h.a([h.Href(entryRouter({ entryId: m.i, channel })), h.Class(ui.link)], [String(m.i)])],
      ),
      h.td([h.Class(ui.td)], [kindBadge(m.kind, h)]),
      h.td([h.Class(ui.td)], [h.div([h.Class(ui.clamp)], [m.cut ? `${m.text} …` : m.text])]),
      h.td([h.Class(`${ui.td} ${ui.tdFit} ${ui.mono}`)], [dateTime(m.date)]),
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
                    [th("ID", h), th("Kind", h), th("Message", h), th("Date (UTC)", h)],
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
                h.span([h.Class(ui.mono)], [dateTime(data.date)]),
                h.span([h.Class(ui.mono)], [`${count(data.size)} bytes`]),
              ],
            ),
            h.pre([h.Class(ui.pre)], [data.text]),
          ],
        ),
      ),
    ],
  );

// MEMORY

const memoryView = (model: Model, channel: string, h: H): Html =>
  remote(memoryQuery.read(model.memory, { channel }), h, skeletonView(h, 2), (lines) =>
    Array.match(lines, {
      onEmpty: () => emptyView("The view is empty.", h),
      onNonEmpty: (rows) =>
        h.div(
          [h.Class(ui.page)],
          [
            h.p(
              [h.Class(ui.muted)],
              [
                `${count(rows.length)} lines, ${count(Array.reduce(rows, 0, (sum, row) => sum + row.size))} bytes of summaries. A line named id+n covers n messages from id.`,
              ],
            ),
            tableView(
              [th("Line", h), th("Level", h), th("Summary", h)],
              Array.map(rows, (row) =>
                h.keyed("tr")(
                  row.label,
                  [h.Class(ui.row)],
                  [
                    h.td([h.Class(`${ui.td} ${ui.mono}`)], [row.label]),
                    h.td([h.Class(ui.td)], [h.span([h.Class(ui.badge)], [`L${row.level}`])]),
                    h.td([h.Class(ui.td)], [h.div([h.Class(ui.text)], [row.text])]),
                  ],
                ),
              ),
              h,
            ),
          ],
        ),
    }),
  );

// USAGE

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
            h.td([h.Class(`${ui.td} ${ui.mono}`)], [day.day]),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(day.calls)]),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(day.input)]),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(day.output)]),
            h.td(
              [h.Class(`${ui.td} ${ui.tdNum}`)],
              [`${percent(day.cacheRead, day.input + day.cacheRead)}%`],
            ),
            h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [usd(day.cost)]),
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
                h.td([h.Class(`${ui.td} ${ui.mono}`)], [tool.tool]),
                h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(tool.calls)]),
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
                      h.td([h.Class(`${ui.td} ${ui.mono}`)], [model_.model]),
                      h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(model_.calls)]),
                      h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(model_.input)]),
                      h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(model_.output)]),
                      h.td(
                        [h.Class(`${ui.td} ${ui.tdNum}`)],
                        [`${percent(model_.cacheRead, model_.input + model_.cacheRead)}%`],
                      ),
                      h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [usd(model_.cost)]),
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
                          h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [count(kind.calls)]),
                          h.td([h.Class(`${ui.td} ${ui.tdNum}`)], [usd(kind.cost)]),
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

// SCHEDULES

const schedulesView = (model: Model, channel: string, h: H): Html =>
  remote(schedulesQuery.read(model.schedules, { channel }), h, skeletonView(h, 1), (rows) =>
    Array.match(rows, {
      onEmpty: () => emptyView("No active schedules.", h),
      onNonEmpty: (schedules) =>
        tableView(
          [th("ID", h), th("Schedule", h), th("Next run", h), th("Prompt", h), th("", h)],
          Array.map(schedules, (schedule) =>
            h.keyed("tr")(
              String(schedule.id),
              [h.Class(ui.row)],
              [
                h.td([h.Class(`${ui.td} ${ui.mono}`)], [`#${schedule.id}`]),
                h.td([h.Class(`${ui.td} ${ui.mono}`)], [schedule.spec]),
                h.td(
                  [h.Class(`${ui.td} ${ui.tdFit} ${ui.mono}`)],
                  [epochDateTime(schedule.nextAt)],
                ),
                h.td([h.Class(ui.td)], [h.div([h.Class(ui.text)], [schedule.prompt])]),
                h.td([h.Class(ui.td)], [actionButton(model, "cancel", schedule.id, "Cancel", h)]),
              ],
            ),
          ),
          h,
        ),
    }),
  );

// SETTINGS

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

// AUDIT

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
                h.td([h.Class(`${ui.td} ${ui.tdFit} ${ui.mono}`)], [epochDateTime(row.at)]),
                h.td([h.Class(ui.td)], [row.who]),
                h.td([h.Class(`${ui.td} ${ui.mono}`)], [row.action]),
                h.td([h.Class(`${ui.td} ${ui.mono}`)], [row.target === 0 ? "–" : `#${row.target}`]),
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

// SHELL

const channelSelect = (model: Model, h: H): Html =>
  AsyncData.matchData(channelsRead(model.channels), {
    onEmpty: () => h.div([h.Class(ui.skeleton), h.Style({ width: "160px", height: "36px" })]),
    onFailure: () => h.empty,
    onData: (channels) => {
      const selected = Option.getOrElse(currentChannel(model), () => "");
      return h.select(
        [
          h.Class(ui.select),
          h.AriaLabel("Channel"),
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

const tabsView = (model: Model, h: H): Html => {
  const channel = routeChannel(model.route);
  const tag = model.route._tag;
  const tabs: ReadonlyArray<readonly [string, string, boolean]> = [
    ["Overview", overviewRouter({ channel }), tag === "Overview"],
    [
      "Log",
      logRouter({
        channel,
        kind: Option.none(),
        q: Option.none(),
        before: Option.none(),
      }),
      tag === "Log" || tag === "Entry",
    ],
    ["Memory", memoryRouter({ channel }), tag === "Memory"],
    ["Usage", usageRouter({ channel, days: Option.none() }), tag === "Usage"],
    ["Schedules", schedulesRouter({ channel }), tag === "Schedules"],
    ["Settings", settingsRouter({ channel }), tag === "Settings"],
    ["Audit", auditRouter({ channel }), tag === "Audit"],
  ];
  return h.nav(
    [h.Class(ui.tabs), h.AriaLabel("Sections")],
    Array.map(tabs, ([label, href, active]) =>
      h.a([h.Class(ui.tab), h.Href(href), h.AriaCurrent(active ? "page" : "false")], [label]),
    ),
  );
};

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
            [titleView("Schedules", [], h), schedulesView(model, channel, h)],
          ),
        Settings: () =>
          h.div(
            [h.Class(ui.page)],
            [titleView("Settings", [], h), settingsView(model, channel, h)],
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

export const view = (model: Model, h: H): Document => ({
  title: "Mizook",
  body: h.div(
    [h.Class(ui.root)],
    [
      h.header(
        [h.Class(ui.header)],
        [
          h.div(
            [h.Class(ui.topbar)],
            [
              h.div([h.Class(ui.brand)], [h.span([h.Class(ui.mark)]), "mizook"]),
              h.span([h.Class(ui.slash), h.AriaHidden(true)], ["/"]),
              channelSelect(model, h),
            ],
          ),
          tabsView(model, h),
        ],
      ),
      h.main([h.Class(ui.main)], [noticeView(model, h), pageView(model, h)]),
    ],
  ),
});
