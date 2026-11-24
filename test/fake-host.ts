import { Effect, Layer } from "effect";
import { Agents, EMPTY_PROFILE, ProfileStore, Self } from "../src/host.ts";

export const fakeSelf = Layer.succeed(Self, {
  id: "a1",
  slug: "mizook",
  name: "Mizook",
  role: "",
  persona: "",
  tools: undefined,
  doName: "agent:a1",
  isDefault: true,
  bound: [],
  created: 0,
  lastActive: 0,
});

export const fakeAgents = (overrides: Partial<Agents["Service"]> = {}) =>
  Agents.of({
    all: Effect.succeed([]),
    bind: () => Effect.undefined,
    placeLabel: (place) => Effect.succeed(place),
    namePlace: () => Effect.void,
    createAgent: () => Effect.succeed({ ok: false, error: "no hub" }),
    updateAgent: () => Effect.succeed({ ok: false, error: "no hub" }),
    deleteAgent: () => Effect.succeed({ ok: false, error: "no hub" }),
    setAgentSetting: () => Effect.void,
    reloadAgent: () => Effect.void,
    ask: () => Effect.succeed(""),
    spendAll: Effect.succeed([]),
    ...overrides,
  });

export const fakeProfileStore = (overrides: Partial<ProfileStore["Service"]> = {}) =>
  ProfileStore.of({
    profile: Effect.succeed(EMPTY_PROFILE),
    updateProfile: () => Effect.succeed(EMPTY_PROFILE),
    ...overrides,
  });
