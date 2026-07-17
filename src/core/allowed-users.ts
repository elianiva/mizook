import { Schema } from "effect";

export function parseAllowedIds(raw: string): Set<number> {
  try {
    return new Set(
      Schema.decodeSync(Schema.Array(Schema.NumberFromString))(
        raw.split(/[\s,]+/).filter(Boolean),
      ).filter(Number.isSafeInteger),
    );
  } catch {
    return new Set<number>();
  }
}
