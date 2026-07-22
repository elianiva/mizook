import { Clock, Effect } from "effect";

export interface ToolTiming {
  readonly startTimeMs: number;
  readonly durationMs?: number;
}

/** Begin measuring tool execution time. */
export const startToolTiming: Effect.Effect<ToolTiming> = Clock.currentTimeMillis.pipe(
  Effect.map((t) => ({ startTimeMs: t })),
);

/** Complete timing measurement and attach duration. */
export const finishToolTiming = (timing: ToolTiming): Effect.Effect<ToolTiming> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => ({ ...timing, durationMs: now - timing.startTimeMs })),
  );
