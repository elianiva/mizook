import { Array } from "effect";
import type { Html } from "foldkit/html";
import { RunRow } from "@mizook/admin-api";

import { runsQuery } from "../api.ts";
import type { Model } from "../model.ts";
import { type H, remote, skeletonView, emptyView, tableView, th, when } from "../view/common.ts";
import { ui } from "../ui.ts";

const runStatusColor = (status: string): string =>
  status === "succeeded"
    ? "var(--colors-ok)"
    : status === "failed"
      ? "var(--colors-danger)"
      : status === "running"
        ? "var(--colors-warn)"
        : "var(--colors-fg-muted)";

const duration = (run: RunRow): string => {
  if (run.finished === null) return "running";
  const ms = Math.max(0, run.finished - run.started);
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
};

export const runsView = (model: Model, channel: string, h: H): Html =>
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
          Array.map(list, (run: RunRow) =>
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
