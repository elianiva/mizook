import { Data, Effect, Option } from "effect";

export class AppRootMissing extends Data.TaggedError("AppRootMissing") {
  override get message(): string {
    return "The app root is missing.";
  }
}

/** The `#root` element an app mounts into, looked up when the Effect runs. */
export const appRoot: Effect.Effect<HTMLElement, AppRootMissing> = Effect.suspend(() =>
  Option.fromNullishOr(document.getElementById("root")).pipe(
    Effect.fromOption,
    Effect.mapError(() => new AppRootMissing()),
  ),
);
