import type { GlyphName } from "@mizook/design/icons";
import { Option } from "effect";
import { AsyncData } from "foldkit";

import { channelsQuery } from "./api.ts";
import type { Model } from "./model.ts";
import {
  agentRouter,
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
  settings: "s",
  artifacts: "f",
  audit: "t",
  profile: "p",
};

/** The sections, in rail order. The rail and the jump menu both read this list. */
export const sections = (model: Model): ReadonlyArray<Destination> => {
  const channel = routeChannel(model.route);
  const tag = model.route._tag;
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
    section("Watch", "grid", "Overview", overviewRouter({ channel }), tag === "Overview"),
    section(
      "Watch",
      "log",
      "Log",
      logRouter({ channel, kind: none, q: none, before: none }),
      tag === "Log" || tag === "Entry",
    ),
    section("Watch", "tree", "Memory", memoryRouter({ channel }), tag === "Memory"),
    section("Watch", "bars", "Usage", usageRouter({ channel, days: none }), tag === "Usage"),
    section("Automate", "clock", "Automations", schedulesRouter({ channel }), tag === "Schedules"),
    section("Automate", "pulse", "Runs", runsRouter({ channel }), tag === "Runs"),
    section("Configure", "book", "Skills", agentRouter({ channel }), tag === "Agent"),
    section("Configure", "sliders", "Settings", settingsRouter({ channel }), tag === "Settings"),
    section(
      "Configure",
      "file",
      "Artifacts",
      artifactsRouter({ channel, name: none }),
      tag === "Artifacts",
    ),
    section("Configure", "audit", "Audit", auditRouter({ channel }), tag === "Audit"),
    section("Shared", "user", "Profile", profileRouter({ channel }), tag === "Profile"),
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
  const query = model.palette.query.trim().toLowerCase();
  const all = destinations(model, current);
  if (query === "") return all;
  return all
    .map((destination) => ({ destination, score: score(destination.label, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .map((entry) => entry.destination);
};
