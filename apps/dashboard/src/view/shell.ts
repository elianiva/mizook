import { css } from "../../styled-system/css";
import { Option, Array } from "effect";
import { AsyncData } from "foldkit";
import type { Html, Document } from "foldkit/html";
import { icon, logo } from "@mizook/ui/icon";

import { channelsQuery } from "../api.ts";
import { Message } from "../message.ts";
import type { Model } from "../model.ts";
import { AppRoute, daysOf, routeHref } from "../route.ts";
import { type Destination, matches, sections } from "../palette.ts";
import { NavState } from "../nav.ts";
import { PaletteState } from "../palette-machine.ts";
import { currentChannel } from "../channel.ts";
import { type H, skeletonView, errorView, emptyView, titleView, sectionView } from "./common.ts";
import { overviewView } from "../pages/overview.ts";
import { logView, entryView } from "../pages/log.ts";
import { memoryView } from "../pages/memory.ts";
import { rangeView, usageView } from "../pages/usage.ts";
import { schedulesView } from "../pages/schedules.ts";
import { agentView } from "../pages/agent.ts";
import { agentsView } from "../pages/agents.ts";
import { profileBody } from "../pages/profile.ts";
import { runsView } from "../pages/runs.ts";
import { settingsView } from "../pages/settings.ts";
import { composerView, artifactsView } from "../pages/artifacts.ts";
import { auditView } from "../pages/audit.ts";
import { motion, ui as shared } from "../ui.ts";

const ui = {
  ...shared,
  root: css({
    height: "100dvh",
    display: "flex",
    overflow: "hidden",
    background: "linear-gradient(135deg, #fff5f0 0%, #fff9f5 50%, #fff0f5 100%)",
    _dark: { background: "bg" },
  }),
  rail: css({
    width: "240px",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
    borderRight: "1px solid {colors.border}",
    "@media (max-width: 899px)": { display: "none" },
  }),
  railTop: css({
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    padding: "20px",
    borderBottom: "1px solid {colors.border}",
  }),
  railGroup: css({ display: "flex", flexDirection: "column", paddingBottom: "6px" }),
  railLabel: css({
    textStyle: "caps",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "18px 20px 6px",
    color: "fgFaint",
    "&::after": { content: '""', flex: "1", height: "1px", backgroundColor: "border" },
  }),
  railItem: css({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "34px",
    paddingInline: "20px",
    color: "fgMuted",
    fontSize: "sm",
    ...motion,
    "& svg": { color: "fgFaint" },
    "& kbd": { marginLeft: "auto", opacity: 0, ...motion },
    _hover: { backgroundColor: "accentSubtle", color: "fg", "& kbd": { opacity: 1 } },
    '&[aria-current="page"]': {
      backgroundColor: "bgHover",
      color: "heading",
      fontWeight: "600",
      "& svg": { color: "accent" },
      "&::before": {
        content: '""',
        position: "absolute",
        left: 0,
        top: "8px",
        bottom: "8px",
        width: "2px",
        backgroundColor: "accent",
      },
    },
  }),
  railFoot: css({
    textStyle: "caps",
    marginTop: "auto",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "48px",
    paddingInline: "20px",
    borderTop: "1px solid {colors.border}",
    color: "fgMuted",
    ...motion,
    _hover: { backgroundColor: "accentSubtle", color: "accent" },
  }),
  spacer: css({ flex: "1", minWidth: 0 }),
  railKey: css({
    textStyle: "meta",
    flexShrink: 0,
    paddingInline: "5px",
    border: "1px solid {colors.border}",
    color: "fgFaint",
    fontSize: "10px",
    lineHeight: "16px",
  }),
  jump: css({
    textStyle: "caps",
    display: "flex",
    alignItems: "center",
    gap: "8px",
    height: "34px",
    paddingInline: "10px",
    border: "1px solid {colors.border}",
    backgroundColor: "bg",
    color: "fgMuted",
    cursor: "pointer",
    ...motion,
    _hover: { borderColor: "borderStrong", color: "accent" },
  }),
  headerJump: css({
    width: "40px",
    height: "40px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: 0,
    backgroundColor: "transparent",
    color: "fgMuted",
    cursor: "pointer",
    ...motion,
    _hover: { color: "accent" },
    "@media (min-width: 900px)": { display: "none" },
  }),
  paletteLayer: css({
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    paddingTop: "14vh",
    paddingInline: "16px",
  }),
  paletteBackdrop: css({
    position: "absolute",
    inset: 0,
    backgroundColor: "rgb(67 20 7 / 0.18)",
    animation: "fadeIn 140ms {easings.out}",
  }),
  palette: css({
    position: "relative",
    width: "min(560px, 100%)",
    display: "flex",
    flexDirection: "column",
    maxHeight: "min(460px, 70dvh)",
    border: "1px solid {colors.borderStrong}",
    backgroundColor: "bg",
    animation: "popIn 140ms {easings.out}",
    "&::before, &::after": {
      content: '""',
      position: "absolute",
      width: "9px",
      height: "9px",
      background:
        "linear-gradient(var(--colors-accent), var(--colors-accent)) center / 1px 9px no-repeat, linear-gradient(var(--colors-accent), var(--colors-accent)) center / 9px 1px no-repeat",
    },
    "&::before": { top: "-5px", left: "-5px" },
    "&::after": { bottom: "-5px", right: "-5px" },
  }),
  paletteSearch: css({
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "10px",
    height: "52px",
    paddingInline: "16px",
    borderBottom: "1px solid {colors.border}",
    color: "accent",
  }),
  paletteInput: css({
    flex: "1",
    minWidth: 0,
    height: "100%",
    border: 0,
    backgroundColor: "transparent",
    color: "fg",
    fontSize: { base: "lg", md: "md" },
    outline: "none",
    _placeholder: { color: "fgFaint" },
    _focusVisible: { outline: "none" },
  }),
  paletteList: css({ overflowY: "auto", paddingBottom: "6px" }),
  paletteItem: css({
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: "12px",
    height: "38px",
    paddingInline: "20px",
    color: "fg",
    fontSize: "sm",
    cursor: "pointer",
    "& svg": { color: "fgFaint" },
    _hover: { backgroundColor: "accentSubtle" },
    '&[aria-selected="true"]': {
      backgroundColor: "bgHover",
      color: "heading",
      "& svg": { color: "accent" },
      "&::before": {
        content: '""',
        position: "absolute",
        left: 0,
        top: "8px",
        bottom: "8px",
        width: "2px",
        backgroundColor: "accent",
      },
    },
  }),
  paletteHere: css({ textStyle: "caps", color: "accent" }),
  paletteEmpty: css({ textStyle: "caps", padding: "24px 20px", color: "fgFaint" }),
  column: css({ flex: "1", minWidth: 0, display: "flex", flexDirection: "column" }),
  header: css({
    flexShrink: 0,
    height: "56px",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    paddingInline: { base: "8px", md: "28px" },
    borderBottom: "1px solid {colors.border}",
  }),
  mobileNav: css({
    "@media (min-width: 900px)": { display: "none" },
    "& > nav": {
      display: "flex",
      position: "fixed",
      top: "56px",
      left: 0,
      bottom: 0,
      zIndex: 31,
      width: "min(320px, 88vw)",
      backgroundColor: "bg",
      animation: "slideIn 200ms {easings.out}",
    },
  }),
  mobileNavBackdrop: css({
    position: "fixed",
    inset: 0,
    top: "56px",
    zIndex: 30,
    backgroundColor: "rgb(67 20 7 / 0.18)",
    animation: "fadeIn 160ms {easings.out}",
  }),
  mobileNavButton: css({
    width: "40px",
    height: "40px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: "fgMuted",
    cursor: "pointer",
    _hover: { color: "accent" },
  }),
  crumb: css({ textStyle: "caps", color: "fgMuted" }),
  crumbSlash: css({ color: "borderStrong" }),
  crumbPage: css({ textStyle: "caps", color: "heading" }),
  brand: css({
    display: "flex",
    alignItems: "center",
    gap: "10px",
    color: "heading",
    fontSize: "md",
    fontWeight: "800",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  }),
  // The scroller spans the whole column so its scrollbar sits at the window edge;
  // the padding centres the content at 64rem.
  main: css({
    flex: "1",
    minWidth: 0,
    minHeight: "0",
    display: "flex",
    flexDirection: "column",
    gap: "20px",
    overflowX: "hidden",
    overflowY: "auto",
    paddingBlock: "28px",
    paddingInline: {
      base: "max(16px, calc((100% - 64rem) / 2 + 16px))",
      md: "max(28px, calc((100% - 64rem) / 2 + 28px))",
    },
  }),
  skeleton: css({
    backgroundColor: "bgHover",
    height: "16px",
    animation: "pulse 1.6s ease-in-out infinite",
  }),
  notice: css({
    border: "1px solid {colors.border}",
    backgroundColor: "bgSubtle",
    padding: "12px 16px",
    fontSize: "sm",
  }),
};

const channelsRead = channelsQuery.read;

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

const railView = (model: Model, h: H, swipe = false): Html =>
  h.nav(
    [
      h.Class(ui.rail),
      h.AriaLabel("Sections"),
      ...(swipe ? [h.Attribute("data-swipe-panel", ""), h.Attribute("data-open", "")] : []),
    ],
    [
      h.div(
        [h.Class(ui.railTop)],
        [
          h.a([h.Class(ui.brand), h.Href("/c")], [logo(h)]),
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

const pageName = (route: AppRoute): string =>
  AppRoute.match<string>(route, {
    Overview: () => "Overview",
    Log: () => "Log",
    Entry: () => "Log",
    Memory: () => "Memory",
    Usage: () => "Usage",
    Schedules: () => "Automations",
    Agent: () => "Skills",
    Agents: () => "Agents",
    Profile: () => "Profile",
    Runs: () => "Runs",
    Settings: () => "Settings",
    Audit: () => "Audit",
    Artifacts: () => "Artifacts",
    NotFound: () => "Not found",
  });

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
        Agents: () =>
          h.div(
            [h.Class(ui.page)],
            [
              titleView(
                "Agents",
                Option.isNone(model.agentForm)
                  ? [
                      h.button(
                        [
                          h.Type("button"),
                          h.Class(ui.buttonPrimary),
                          h.OnClick(Message.ClickedAgentManage({ slug: "" })),
                        ],
                        [icon(h, "plus", 14), "New agent"],
                      ),
                    ]
                  : [],
                h,
              ),
              agentsView(model, h),
            ],
          ),
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
  const page = pageName(model.route);
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
                h.div(
                  [h.Class(ui.mobileNav)],
                  [
                    h.button(
                      [
                        h.Type("button"),
                        h.Class(ui.mobileNavButton),
                        h.AriaLabel("Sections"),
                        h.AriaExpanded(NavState.guards.Open(model.nav)),
                        h.OnClick(Message.ToggledNav()),
                      ],
                      [icon(h, "menu", 20)],
                    ),
                    ...NavState.match(model.nav, {
                      Closed: () => [],
                      Open: () => [
                        h.div(
                          [
                            h.Class(ui.mobileNavBackdrop),
                            h.Attribute("data-swipe-backdrop", ""),
                            h.OnClick(Message.ClosedNav()),
                          ],
                          [],
                        ),
                        railView(model, h, true),
                      ],
                    }),
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
                h.a(
                  [
                    h.Class(ui.headerJump),
                    h.Href("/c"),
                    h.AriaLabel("Web chat"),
                    h.Title("Web chat"),
                  ],
                  [icon(h, "thread", 18)],
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
