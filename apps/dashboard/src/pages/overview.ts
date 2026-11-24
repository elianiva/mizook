import { css } from "../../styled-system/css";
import { Option, Array } from "effect";
import type { Html } from "foldkit/html";
import { icon } from "@mizook/ui/icon";
import type { LogMessage, Overview } from "@mizook/admin-api";

import { summaryQuery, overviewQuery, recentQuery } from "../api.ts";
import { ago, count, usd, percent, until } from "../format.ts";
import type { Model } from "../model.ts";
import { entryRouter, overviewRouter, settingsRouter, routeChannel } from "../route.ts";
import { currentChannel } from "../channel.ts";
import {
  type H,
  kindBadge,
  when,
  remote,
  skeletonView,
  tableView,
  th,
  meterColor,
  actionButton,
  sectionView,
  emptyView,
} from "../view/common.ts";
import { ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  meter: css({ height: "3px", backgroundColor: "border", width: "100%" }),
  meterFill: css({ height: "100%", transition: "width 300ms" }),
  budgetRow: css({
    display: "flex",
    justifyContent: "space-between",
    color: "fgMuted",
    fontSize: "xs",
    fontVariantNumeric: "tabular-nums",
  }),

  needs: css({
    position: "relative",
    border: "1px solid {colors.warn}",
    backgroundColor: "bg",
    "&::before, &::after": {
      content: '""',
      position: "absolute",
      width: "9px",
      height: "9px",
      background:
        "linear-gradient(var(--colors-warn), var(--colors-warn)) center / 1px 9px no-repeat, linear-gradient(var(--colors-warn), var(--colors-warn)) center / 9px 1px no-repeat",
    },
    "&::before": { top: "-5px", left: "-5px" },
    "&::after": { bottom: "-5px", right: "-5px" },
  }),
  needsTitle: css({
    textStyle: "caps",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 16px",
    borderBottom: "1px solid {colors.border}",
    color: "warn",
  }),
  needsCount: css({
    minWidth: "20px",
    height: "20px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "warn",
    color: "white",
  }),
  needItem: css({
    display: "flex",
    alignItems: "center",
    gap: "14px",
    flexWrap: "wrap",
    padding: "12px 16px",
    "& + &": { borderTop: "1px solid {colors.border}" },
    "& > div:last-child": { marginTop: 0 },
  }),
  needIcon: css({ display: "inline-flex", color: "warn" }),
  needText: css({
    flex: "1",
    minWidth: "200px",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    fontSize: "sm",
  }),
  needMeta: css({ textStyle: "meta", color: "fgFaint" }),
  needQuiet: css({
    textStyle: "caps",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    color: "fgFaint",
    "& svg": { color: "ok" },
  }),
  heroHead: css({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    fontSize: "xs",
  }),
  spark: css({
    display: "flex",
    alignItems: "flex-end",
    gap: "4px",
    flex: "1 1 72px",
    minHeight: "72px",
    borderBottom: "1px solid {colors.border}",
  }),
  sparkBar: css({
    flex: "1",
    backgroundColor: "borderStrong",
    transition: "background-color 120ms",
    _hover: { backgroundColor: "fg" },
  }),
  alert: css({
    border: "1px solid",
    padding: "12px 16px",
    fontSize: "sm",
    display: "flex",
    justifyContent: "space-between",
    gap: "12px",
    backgroundColor: "bg",
  }),
};

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

type OverviewData = Overview;

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

export const overviewView = (model: Model, channel: string, h: H): Html =>
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
