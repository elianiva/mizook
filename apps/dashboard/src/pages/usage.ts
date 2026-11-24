import { css } from "../../styled-system/css";
import { Array, Option } from "effect";
import type { Html } from "foldkit/html";
import type { UsageReport } from "@mizook/admin-api";

import { usageQuery } from "../api.ts";
import { count, percent, usd } from "../format.ts";
import type { Model } from "../model.ts";
import { USAGE_DAYS, usageRouter, routeChannel } from "../route.ts";
import {
  type H,
  sectionView,
  tableView,
  th,
  emptyView,
  remote,
  skeletonView,
  kindBadge,
} from "../view/common.ts";
import { ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  columns: css({
    display: "grid",
    gridTemplateColumns: { base: "1fr", md: "repeat(2, minmax(0, 1fr))" },
    gap: "22px",
    alignItems: "start",
  }),
  chart: css({
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  }),
  bars: css({
    height: "100px",
    display: "flex",
    alignItems: "flex-end",
    gap: "3px",
    borderBottom: "1px solid {colors.border}",
  }),
  bar: css({
    flex: "1",
    backgroundColor: "borderStrong",
    minHeight: "2px",
    transition: "background-color 120ms",
    _hover: { backgroundColor: "accent" },
  }),
};

const dailySection = (report: UsageReport, h: H): Html =>
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

const toolsSection = (report: UsageReport, h: H): Html =>
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

export const usageView = (model: Model, channel: string, days: number, h: H): Html =>
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

export const rangeView = (model: Model, days: number, h: H): Html =>
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
