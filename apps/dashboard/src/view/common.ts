import { Array, Record } from "effect";
import { AsyncData } from "foldkit";
import type { HtmlBuilder, Html } from "foldkit/html";
import { icon } from "@mizook/ui/icon";
import { isArmed } from "@mizook/ui/confirmation";
import type { ActionKind } from "@mizook/admin-api";
import type { GlyphName } from "@mizook/design/icons";

import { epochDateTime, localDateTime } from "../format.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { ui } from "../ui.ts";

export type H = HtmlBuilder<Message>;

export const PAGE_SIZE = 50;

export const remote = <A>(
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

export const errorView = (error: string, h: H): Html =>
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

export const skeletonView = (h: H, rows: number): Html =>
  h.div(
    [h.Class(ui.section), h.AriaBusy(true)],
    Array.makeBy(rows, (index) => h.keyed("div")(String(index), [h.Class(ui.skeletonBlock)])),
  );

export const emptyView = (text: string, h: H): Html => h.div([h.Class(ui.empty)], [text]);

export const sectionView = (title: string, body: Html, h: H): Html =>
  h.section([h.Class(ui.section)], [h.h2([h.Class(ui.sectionTitle)], [title]), body]);

export const titleView = (title: string, actions: ReadonlyArray<Html>, h: H): Html =>
  h.div([h.Class(ui.titleRow)], [h.h1([h.Class(ui.title)], [title]), ...actions]);

const ACTION_GLYPH: Record<ActionKind, GlyphName> = {
  approve: "check",
  deny: "close",
  cancel: "trash",
  stop: "stop",
};

export const actionButton = (
  model: Model,
  action: ActionKind,
  id: number,
  label: string,
  h: H,
): Html => {
  const armed = isArmed(model.armed, `${action}:${id}`);
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
export const kindBadge = (kind: string, h: H): Html =>
  h.span(
    [h.Class(kind === "user" ? ui.badgeUser : ui.badge), h.Title(kind)],
    [icon(h, KIND_GLYPH[kind] ?? "log", 13), kind],
  );

/** A time in the reader's zone; the UTC original is in the tooltip. */
export const when = (epochMs: number, h: H): Html =>
  h.time(
    [h.Attribute("datetime", new Date(epochMs).toISOString()), h.Title(epochDateTime(epochMs))],
    [localDateTime(epochMs)],
  );

export const th = (label: string, h: H, numeric = false): Html =>
  h.th([h.Class(numeric ? ui.thNum : ui.th), h.Scope("col")], [label]);

export const tableView = (headers: ReadonlyArray<Html>, rows: ReadonlyArray<Html>, h: H): Html =>
  h.div(
    [h.Class(ui.tableWrap)],
    [h.table([h.Class(ui.table)], [h.thead([], [h.tr([], headers)]), h.tbody([], rows)])],
  );

export const meterColor = (used: number): string =>
  used >= 90 ? "var(--colors-danger)" : used >= 70 ? "var(--colors-warn)" : "var(--colors-ok)";
