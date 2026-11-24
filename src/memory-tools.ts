import { Memory } from "@mizook/memory";
import { Effect, Schema } from "effect";
import { ToolError } from "./errors.ts";
import { defineTool, described } from "./tool.ts";

export const ZoomArgs = Schema.Struct({
  id: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    "First message of the line, as in id+n.",
  ),
  n: described(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    "Messages the line covers: a power of 2, and id a multiple of it.",
  ),
});

export const DateArgs = Schema.Struct({
  id: described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "The message id."),
});

export const SearchArgs = Schema.Struct({
  query: described(Schema.String, "Words to find in the log, exact enough to be useful."),
  limit: Schema.optionalKey(
    described(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      "How many matches, up to 50. Default 20.",
    ),
  ),
});

export const ZOOM_DESCRIPTION =
  "Open line id+n of the view into the two lines it was made from. n = 1 gives message id whole.";
export const DATE_DESCRIPTION = "The date and time of message id.";

export const memoryTools = [
  defineTool({
    name: "zoom",
    path: "memory.zoom",
    description: ZOOM_DESCRIPTION,
    args: ZoomArgs,
    run: (a) => Memory.use((memory) => memory.zoom(a.id, a.n)),
  }),
  defineTool({
    name: "date",
    path: "memory.date",
    description: DATE_DESCRIPTION,
    args: DateArgs,
    run: (a) => Memory.use((memory) => memory.date(a.id)),
  }),
  defineTool({
    name: "search",
    path: "memory.search",
    description:
      "Find messages in the log by text. Returns message ids, kinds, dates and short excerpts; open one with memory.zoom({id, n: 1}). Use it when the user asks when something was said or you need an exact name or number.",
    args: SearchArgs,
    run: (a) =>
      Effect.gen(function* () {
        const memory = yield* Memory;
        const query = a.query.trim();
        if (query === "") return yield* new ToolError({ reason: "search needs a query" });
        const hits = yield* memory.search(query, a.limit ?? 20);
        return hits.length === 0
          ? "No messages match."
          : hits
              .map(
                (hit) =>
                  `${hit.i} ${hit.kind} ${hit.date.slice(0, 10)}: ${hit.snippet.replace(/\s+/g, " ")}`,
              )
              .join("\n");
      }),
  }),
];
