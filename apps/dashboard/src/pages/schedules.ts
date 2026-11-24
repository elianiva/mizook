import { css } from "../../styled-system/css";
import { Array } from "effect";
import type { Html } from "foldkit/html";
import type { ScheduleRow } from "@mizook/admin-api";

import { schedulesQuery } from "../api.ts";
import { describeSpec, until, inZone } from "../format.ts";
import type { Model } from "../model.ts";
import { type H, actionButton, remote, skeletonView, emptyView } from "../view/common.ts";
import { ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  cardCountdown: css({
    fontSize: "2xl",
    fontWeight: "700",
    letterSpacing: "tight",
    color: "accent",
    lineHeight: "1.1",
  }),
  clamp3: css({ lineClamp: "3", wordBreak: "break-word", lineHeight: "1.55" }),
};

const scheduleCard = (model: Model, schedule: ScheduleRow, h: H): Html => {
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

export const schedulesView = (model: Model, channel: string, h: H): Html =>
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
