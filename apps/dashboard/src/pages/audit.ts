import { Array } from "effect";
import type { Html } from "foldkit/html";

import { auditQuery } from "../api.ts";
import type { Model } from "../model.ts";
import { type H, remote, skeletonView, emptyView, tableView, th, when } from "../view/common.ts";
import { ui } from "../ui.ts";

export const auditView = (model: Model, channel: string, h: H): Html =>
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
