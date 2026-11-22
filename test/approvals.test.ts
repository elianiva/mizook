import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { Approvals } from "../src/approvals.ts";

const go = <A, E>(f: Effect.Effect<A, E, Approvals>) => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    all: <T>(query: string, ...params: unknown[]) =>
      db.prepare(query).all(...(params as never[])) as T[],
  };
  return Effect.runPromise(Effect.provide(f, Approvals.layer(sql)));
};

const topic = "telegram:-1001:5";
const dm = "telegram:42";

test("an approval is shown once, in the place that asked, and answered once", async () => {
  await go(
    Effect.gen(function* () {
      const approvals = yield* Approvals;
      const a = yield* approvals.add("exec_1", "Send mail?", "gmail.send", topic);
      const b = yield* approvals.add("exec_2", "Delete?", "", topic);
      const c = yield* approvals.add("exec_3", "Pay?", "", dm);
      expect(a.match).toBe("gmail.send");
      expect(c.place).toBe(dm);
      expect((yield* approvals.unposted(topic)).map((x) => x.id)).toEqual([a.id, b.id]);
      expect((yield* approvals.unposted(dm)).map((x) => x.id)).toEqual([c.id]);
      yield* approvals.markPosted(a.id);
      expect((yield* approvals.unposted(topic)).map((x) => x.id)).toEqual([b.id]);
      const taken = yield* approvals.take(a.id);
      expect(taken?.executionId).toBe("exec_1");
      expect(taken?.place).toBe(topic);
      // A second press of the same button finds nothing.
      expect(yield* approvals.take(a.id)).toBeUndefined();
      // The button names the agent too, inside the Chat SDK's wrapper, under Telegram's 64 bytes.
      const data = `chat:${JSON.stringify({ a: `always:abcdefghijklmnop:${c.id}99999` })}`;
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    }),
  );
});
