import { Schema } from "effect";

export function parseAllowedIds(raw: string): Set<number> {
  try {
    return new Set(
      Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
        raw.split(/[\s,]+/).filter(Boolean),
      ).filter(Number.isSafeInteger),
    );
  } catch (cause) {
    console.error("parseAllowedIds_failed", cause);
    return new Set<number>();
  }
}
