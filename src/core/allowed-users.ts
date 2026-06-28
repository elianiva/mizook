import { Context, Effect, Layer, Schema } from "effect";
import { WorkersEnv } from "./workers-env";

// Access allowlist parsed once from env at layer build, stable for the
// runtime's lifetime (a cold start picks up new values, which is fine for an
// allowlist).
const parseAllowedIds = (raw: string): Set<number> => {
  try {
    return new Set(
      Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
        raw.split(/[\s,]+/).filter(Boolean),
      ).filter(Number.isSafeInteger),
    );
  } catch {
    return new Set<number>();
  }
};

export class AllowedUsers extends Context.Service<
  AllowedUsers,
  {
    readonly has: (uid: number) => boolean;
    readonly values: ReadonlySet<number>;
  }
>()("mizook/AllowedUsers") {
  static readonly layer = Layer.effect(AllowedUsers)(
    Effect.gen(function* () {
      const { env } = yield* WorkersEnv;
      const ids = parseAllowedIds(env.TELEGRAM_ALLOWED_USER_IDS);
      return AllowedUsers.of({
        has: (uid) => ids.has(uid),
        values: ids,
      });
    }),
  );
}
