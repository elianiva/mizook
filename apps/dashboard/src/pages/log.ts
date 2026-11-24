import { css } from "../../styled-system/css";
import { Option, Predicate, Array, pipe } from "effect";
import type { Html } from "foldkit/html";
import { icon } from "@mizook/ui/icon";
import { MESSAGE_KINDS, type LogMessage } from "@mizook/admin-api";

import { logQuery, entryQuery } from "../api.ts";
import { count } from "../format.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { routeChannel, logRouter, entryRouter, textOf } from "../route.ts";
import {
  type H,
  kindBadge,
  when,
  remote,
  skeletonView,
  emptyView,
  tableView,
  th,
  PAGE_SIZE,
} from "../view/common.ts";
import { motion, ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  fill: css({
    flex: "0 1 auto",
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  }),
  segments: css({ display: "flex", flexWrap: "wrap", border: "1px solid {colors.border}" }),
  searchBox: css({
    flex: "1",
    minWidth: "220px",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "36px",
    paddingInline: "12px",
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
    color: "fgFaint",
    ...motion,
    _focusWithin: { borderColor: "accent", color: "accent" },
  }),
  searchInput: css({
    flex: "1",
    minWidth: 0,
    height: "100%",
    border: 0,
    backgroundColor: "transparent",
    color: "fg",
    fontSize: { base: "lg", md: "sm" },
    outline: "none",
    _placeholder: { color: "fgFaint" },
    _focusVisible: { outline: "none" },
  }),
  back: css({ color: "fgMuted", fontSize: "sm", _hover: { color: "accent" } }),
  footer: css({ display: "flex", justifyContent: "center" }),
};

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
          ...Array.map(MESSAGE_KINDS, (kind) =>
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

export const logView = (model: Model, channel: string, h: H): Html => {
  const route = model.route;
  const [kind, q, before] = Predicate.isTagged(route, "Log")
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

export const entryView = (model: Model, channel: string, entryId: number, h: H): Html =>
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
