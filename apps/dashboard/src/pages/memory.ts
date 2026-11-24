import { css } from "../../styled-system/css";
import { Record, Array, Order } from "effect";
import type { Html } from "foldkit/html";
import { MESSAGE_KINDS, type ViewLine } from "@mizook/admin-api";

import { memoryQuery } from "../api.ts";
import { count, percent } from "../format.ts";
import type { Model } from "../model.ts";
import { type H, kindBadge, remote, skeletonView, emptyView, sectionView } from "../view/common.ts";
import { ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  clamp4: css({
    lineClamp: "4",
    wordBreak: "break-word",
    lineHeight: "1.55",
    whiteSpace: "pre-wrap",
  }),
  memMapWrap: css({
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  }),
  memMap: css({ display: "flex", height: "28px", gap: "1px" }),
  memSeg: css({
    flexBasis: "2px",
    flexShrink: 1,
    minWidth: "1px",
    transition: "opacity 120ms",
    _hover: { opacity: "0.6" },
  }),
  memLegend: css({
    display: "flex",
    gap: "16px",
    flexWrap: "wrap",
    fontSize: "xs",
    color: "fgMuted",
  }),
  memLegendItem: css({ display: "inline-flex", alignItems: "center", gap: "6px" }),
  memDot: css({ width: "6px", height: "6px", flexShrink: 0, display: "inline-block" }),
  memList: css({
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
    maxHeight: "clamp(260px, 50dvh, 640px)",
    overflowY: "auto",
  }),
  memRow: css({
    display: "grid",
    gridTemplateColumns: "76px 1fr",
    gap: "10px",
    padding: "6px 14px",
    alignItems: "baseline",
    "& + &": { borderTop: "1px solid {colors.border}" },
  }),
  memGutter: css({
    display: "flex",
    alignItems: "center",
    gap: "6px",
    color: "fgMuted",
    fontSize: "xs",
    whiteSpace: "nowrap",
  }),
  memBubble: css({
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    minWidth: "0",
  }),
  memSpan: css({
    display: "flex",
    "& > :first-child": { whiteSpace: "nowrap", flexShrink: 0 },
    alignItems: "baseline",
    gap: "8px",
    paddingLeft: "10px",
    borderLeft: "2px dashed {colors.borderStrong}",
    backgroundColor: "bgSubtle",
    minWidth: "0",
  }),
  depth: css({ display: "flex", height: "10px", gap: "1px" }),
  depthSeg: css({ flexBasis: "2px", minWidth: "2px" }),
};

const KIND_PREFIX = new RegExp(`^(${MESSAGE_KINDS.join("|")}): ?([\\s\\S]*)$`);

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

const memoryLine = (line: ViewLine, h: H): Html => {
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
  rows: ReadonlyArray<ViewLine>,
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

export const memoryView = (model: Model, channel: string, h: H): Html =>
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
