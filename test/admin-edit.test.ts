import { Effect, Layer } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { edit, type EditOutcome } from "../src/admin/edit.ts";
import type { StateError } from "../src/errors.ts";
import { Host, type Profile } from "../src/host.ts";
import { Intents } from "../src/intents.ts";
import { fakeHost } from "./fake-host.ts";
import { Policies } from "../src/policies.ts";
import { Skills } from "../src/skills.ts";

const ok = (outcome: EditOutcome) => {
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
};

const go = async <A>(
  profile: { current: Profile },
  effect: Effect.Effect<A, StateError, Host | Skills | Intents | Policies>,
) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  const host = fakeHost({
    profile: Effect.sync(() => profile.current),
    updateProfile: (about, rules) =>
      Effect.sync(() => {
        profile.current = {
          about: about ?? profile.current.about,
          rules: rules ?? profile.current.rules,
        };
        return profile.current;
      }),
  });
  return Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(
        Skills.layer(sql),
        Intents.layer(sql),
        Policies.layer(sql),
        Layer.succeed(Host, host),
      ),
    ),
  );
};

test("a dashboard skill edit saves, pins, and refuses to delete while pinned", async () => {
  const profile = { current: { about: "", rules: [] } };
  await go(
    profile,
    Effect.gen(function* () {
      expect((yield* edit("skills", "not an object")).ok).toBe(false);
      ok(
        yield* edit("skills", {
          action: "save",
          name: "weekly-review",
          description: "Review the week.",
          body: "1. Read the last seven days.",
          pinned: true,
        }),
      );
      expect((yield* (yield* Skills).get("weekly-review"))?.pinned).toBe(true);
      expect((yield* edit("skills", { action: "delete", name: "weekly-review" })).ok).toBe(false);
      expect(
        (yield* edit("skills", {
          action: "save",
          name: "weekly-review",
          description: "Review the week.",
          body: "1. Read the last seven days.",
          pinned: false,
        })).ok,
      ).toBe(false);

      yield* (yield* Skills).setPinned("weekly-review", false);
      expect((yield* edit("skills", { action: "delete", name: "weekly-review" })).ok).toBe(true);
      expect(yield* (yield* Skills).get("weekly-review")).toBeUndefined();
    }),
  );
});

test("a dashboard intent edit creates, changes and cancels one", async () => {
  const profile = { current: { about: "", rules: [] } };
  const now = Date.now();
  await go(
    profile,
    Effect.gen(function* () {
      ok(
        yield* edit("intents", {
          action: "save",
          description: "Check the rollback owner.",
          triggers: ["launch", "rollback"],
          expires: now + 86_400_000,
          maxFires: 2,
          cooldownHours: 1,
        }),
      );
      const [made] = yield* (yield* Intents).list;
      expect(made?.description).toBe("Check the rollback owner.");

      ok(
        yield* edit("intents", {
          action: "save",
          id: made!.id,
          description: "Check the rollback owner and the time.",
          triggers: ["launch"],
          expires: now + 172_800_000,
          maxFires: 4,
          cooldownHours: 0,
        }),
      );
      const [changed] = yield* (yield* Intents).list;
      expect(changed).toMatchObject({
        description: "Check the rollback owner and the time.",
        triggers: ["launch"],
        maxFires: 4,
        cooldown: 0,
      });

      ok(yield* edit("intents", { action: "cancel", id: made!.id }));
      expect((yield* (yield* Intents).list)[0]?.state).toBe("cancelled");
      expect((yield* edit("intents", { action: "cancel", id: made!.id })).ok).toBe(false);
    }),
  );
});

test("a dashboard policy edit adds, changes and removes a rule", async () => {
  const profile = { current: { about: "", rules: [] } };
  await go(
    profile,
    Effect.gen(function* () {
      ok(yield* edit("policies", { action: "save", match: "Gmail.Send", decision: "ask" }));
      const [made] = yield* (yield* Policies).list;
      expect(made).toMatchObject({ match: "gmail.send", decision: "ask" });

      ok(
        yield* edit("policies", {
          action: "save",
          id: made!.id,
          match: "gmail.send",
          decision: "deny",
        }),
      );
      expect((yield* (yield* Policies).decide("call gmail.send email")) ?? "").toBe("deny");
      expect(
        (yield* edit("policies", { action: "save", match: "gmail.send", decision: "deny" })).ok,
      ).toBe(true);
      expect((yield* edit("policies", { action: "remove", id: made!.id })).ok).toBe(true);
      expect(yield* (yield* Policies).list).toEqual([]);
    }),
  );
});

test("a dashboard profile edit trims rules and keeps the shared profile", async () => {
  const profile = { current: { about: "", rules: [] } };
  await go(
    profile,
    Effect.gen(function* () {
      const saved = yield* edit("profile", {
        about: "  Elian builds Mizook.  ",
        rules: [" Use metric units. ", "", "Ask before sending email. "],
      });
      expect(saved).toEqual({ ok: true, said: "Profile saved with 2 rules." });
      expect(profile.current).toEqual({
        about: "Elian builds Mizook.",
        rules: ["Use metric units.", "Ask before sending email."],
      });
      expect((yield* edit("profile", { about: "x".repeat(4_001) })).ok).toBe(false);
    }),
  );
});
