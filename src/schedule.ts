import { Cron } from "croner";

/** When something should wake the chat. */
export type Spec =
  | { readonly kind: "once"; readonly at: string }
  | { readonly kind: "cron"; readonly expr: string; readonly timezone: string }
  | { readonly kind: "watch"; readonly url: string; readonly everyMinutes: number };

/** The shortest gap between two polls of a watch. */
export const MIN_WATCH_MINUTES = 5;

/**
 * The first time after `after` that `spec` fires, or `undefined` when it never fires again (a
 * `once` in the past). A cron missed during downtime fires once when the chat wakes: the caller
 * asks for the next time after *now*, not after the missed one.
 */
export const nextFire = (spec: Spec, after: Date): Date | undefined => {
  switch (spec.kind) {
    case "once": {
      const at = new Date(spec.at);
      return at.getTime() > after.getTime() ? at : undefined;
    }
    case "cron":
      return new Cron(spec.expr, { timezone: spec.timezone }).nextRun(after) ?? undefined;
    case "watch":
      return new Date(after.getTime() + spec.everyMinutes * 60_000);
  }
};

/** Why a spec cannot be used, or `undefined` when it is fine. */
export const invalid = (spec: Spec, now: Date): string | undefined => {
  try {
    switch (spec.kind) {
      case "once": {
        if (Number.isNaN(new Date(spec.at).getTime())) return `"${spec.at}" is not a date`;
        if (new Date(spec.at).getTime() <= now.getTime()) return `${spec.at} is in the past`;
        return undefined;
      }
      case "cron":
        return nextFire(spec, now) ? undefined : `"${spec.expr}" never fires`;
      case "watch": {
        if (!/^https?:\/\//.test(spec.url)) return "a watch needs an http(s) url";
        if (spec.everyMinutes < MIN_WATCH_MINUTES) {
          return `a watch polls at most every ${MIN_WATCH_MINUTES} minutes`;
        }
        return undefined;
      }
    }
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};
