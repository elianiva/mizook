import type { GlyphName } from "@mizook/design/icons";
import { Option, Predicate } from "effect";
import { AsyncData } from "foldkit";

import { channelsQuery } from "./api.ts";
import type { Model } from "./model.ts";
import type { AppRoute } from "./route.ts";
import { PaletteState } from "./palette-machine.ts";
import {
  agentRouter,
  agentsRouter,
  artifactsRouter,
  auditRouter,
  logRouter,
  memoryRouter,
  overviewRouter,
  profileRouter,
  routeChannel,
  routeHref,
  routeOnChannel,
  runsRouter,
  schedulesRouter,
  settingsRouter,
  usageRouter,
} from "./route.ts";

/** One place to go: a dashboard section, or another agent's same section. */
export type Destination = {
  readonly id: string;
  readonly group: string;
  readonly glyph: GlyphName;
  readonly label: string;
  readonly href: string;
  readonly active: boolean;
  /** The `g` sequence's second key, shown as a hint. */
  readonly key?: string;
};

/** `g` then this letter jumps to the section. The rail and the menu show it. */
export const GO_KEYS: Readonly<Record<string, string>> = {
  overview: "o",
  log: "l",
  memory: "m",
  usage: "u",
  automations: "a",
  runs: "r",
  skills: "k",
  agents: "e",
  settings: "s",
  artifacts: "f",
  audit: "t",
  profile: "p",
};

/** The sections, in rail order. The rail and the jump menu both read this list. */
export const sections = (model: Model): ReadonlyArray<Destination> => {
  const channel = routeChannel(model.route);
  const on = (...tags: ReadonlyArray<AppRoute["_tag"]>) =>
    tags.some((tag) => Predicate.isTagged(model.route, tag));
  const none = Option.none<string>();
  const section = (
    group: string,
    glyph: GlyphName,
    label: string,
    href: string,
    active: boolean,
  ): Destination => {
    const id = label.toLowerCase();
    const key = GO_KEYS[id];
    return { id, group, glyph, label, href, active, ...(key !== undefined && { key }) };
  };
  return [
    section("Watch", "grid", "Overview", overviewRouter({ channel }), on("Overview")),
    section(
      "Watch",
      "log",
      "Log",
      logRouter({ channel, kind: none, q: none, before: none }),
      on("Log", "Entry"),
    ),
    section("Watch", "tree", "Memory", memoryRouter({ channel }), on("Memory")),
    section("Watch", "bars", "Usage", usageRouter({ channel, days: none }), on("Usage")),
    section("Automate", "clock", "Automations", schedulesRouter({ channel }), on("Schedules")),
    section("Automate", "pulse", "Runs", runsRouter({ channel }), on("Runs")),
    section("Configure", "bot", "Agents", agentsRouter({ channel }), on("Agents")),
    section("Configure", "book", "Skills", agentRouter({ channel }), on("Agent")),
    section("Configure", "sliders", "Settings", settingsRouter({ channel }), on("Settings")),
    section(
      "Configure",
      "file",
      "Artifacts",
      artifactsRouter({ channel, name: none }),
      on("Artifacts"),
    ),
    section("Configure", "audit", "Audit", auditRouter({ channel }), on("Audit")),
    section("Shared", "user", "Profile", profileRouter({ channel }), on("Profile")),
  ];
};

/** Every section, then every agent, which keeps the page you are on. */
const destinations = (model: Model, current: Option.Option<string>): ReadonlyArray<Destination> => [
  ...sections(model),
  ...Option.match(AsyncData.getData(channelsQuery.read(model.channels)), {
    onNone: () => [],
    onSome: (channels) =>
      channels.map((agent): Destination => ({
        id: `agent:${agent.doName}`,
        group: "Agents",
        glyph: "bot",
        label: agent.name,
        href: routeHref(routeOnChannel(model.route, agent.doName)),
        active: Option.contains(current, agent.doName),
      })),
  }),
];

/** 3 for a prefix, 2 for a substring, 1 when the letters appear in order, 0 for no match. */
const score = (label: string, query: string): number => {
  const text = label.toLowerCase();
  if (text.includes(query)) return text.startsWith(query) ? 3 : 2;
  let at = 0;
  for (const letter of query) {
    at = text.indexOf(letter, at);
    if (at === -1) return 0;
    at += 1;
  }
  return 1;
};

/** What the jump menu lists for its query, best match first. */
export const matches = (
  model: Model,
  current: Option.Option<string>,
): ReadonlyArray<Destination> => {
  const query = PaletteState.match(model.palette, {
    Closed: () => "",
    Open: ({ query }) => query.trim().toLowerCase(),
  });
  const all = destinations(model, current);
  if (query === "") return all;
  return all
    .map((destination) => ({ destination, score: score(destination.label, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map((entry) => entry.destination);
};
