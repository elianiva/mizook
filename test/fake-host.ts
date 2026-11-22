import { Effect } from "effect";
import { EMPTY_PROFILE, Host } from "../src/host.ts";

/** A Host for tests: one default agent with no peers. Override what a test needs. */
export const fakeHost = (overrides: Partial<typeof Host.Service> = {}) =>
  Host.of({
    self: {
      id: "a1",
      slug: "mizook",
      name: "Mizook",
      doName: "agent:a1",
      isDefault: true,
      bound: [],
      created: 0,
      lastActive: 0,
    },
    hookUrl: Effect.succeed(""),
    reload: Effect.void,
    agents: Effect.succeed([]),
    bind: () => Effect.undefined,
    placeLabel: (place) => Effect.succeed(place),
    namePlace: () => Effect.void,
    ask: () => Effect.succeed(""),
    profile: Effect.succeed(EMPTY_PROFILE),
    updateProfile: () => Effect.succeed(EMPTY_PROFILE),
    testSchedule: () => Effect.succeed(false),
    spendAll: Effect.succeed([]),
    exportNow: Effect.succeed(""),
    ...overrides,
  });
