import { Effect, Schema } from "effect";
import { ArchiveError } from "./errors.ts";
import { last } from "./tree.ts";
import type { Snapshot } from "./types.ts";

const MessageLine = Schema.Struct({
  i: Schema.Finite,
  kind: Schema.Literals(["user", "agent", "tool", "echo", "note"]),
  text: Schema.String,
  size: Schema.Finite,
  date: Schema.String,
});
const NodeLine = Schema.Struct({
  l: Schema.Finite,
  i: Schema.Finite,
  text: Schema.String,
  size: Schema.Finite,
});
const ViewState = Schema.Struct({
  lines: Schema.Array(Schema.Tuple([Schema.Finite, Schema.Finite])),
  pending: Schema.Boolean,
});
const Views = Schema.Struct({ chat: ViewState, compaction: ViewState });

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(MessageLine));
const decodeNode = Schema.decodeUnknownEffect(Schema.fromJsonString(NodeLine));
const decodeViews = Schema.decodeUnknownEffect(Schema.fromJsonString(Views));

/** Files by path, in the design's layout: `main/DAY.jsonl`, `tree/DAY.jsonl`, `view.json`. */
export type Files = Readonly<Record<string, string>>;

const day = (date: string) => date.slice(0, 10);

/** A snapshot as the design's files. A node goes in the file of the day of its last message. */
export const toFiles = (snapshot: Snapshot): Files => {
  const files: Record<string, string> = {};
  const add = (path: string, line: unknown) => {
    files[path] = `${files[path] ?? ""}${JSON.stringify(line)}\n`;
  };
  for (const m of snapshot.messages) add(`main/${day(m.date)}.jsonl`, m);
  for (const n of snapshot.nodes) {
    const end = snapshot.messages[Math.min(last(n.l, n.i), snapshot.messages.length - 1)];
    add(`tree/${end ? day(end.date) : "unknown"}.jsonl`, n);
  }
  if (snapshot.views) files["view.json"] = JSON.stringify(snapshot.views);
  return files;
};

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

/** The snapshot in a set of files. Messages must be numbered 0, 1, 2, … without a gap. */
export const fromFiles = (files: Files) =>
  Effect.gen(function* () {
    const paths = Object.keys(files).sort();
    const messages = yield* Effect.forEach(
      paths.filter((p) => p.startsWith("main/")).flatMap((p) => lines(files[p]!)),
      (line) => decodeMessage(line),
    );
    const nodes = yield* Effect.forEach(
      paths.filter((p) => p.startsWith("tree/")).flatMap((p) => lines(files[p]!)),
      (line) => decodeNode(line),
    );
    messages.sort((a, b) => a.i - b.i);
    const gap = messages.findIndex((m, k) => m.i !== k);
    if (gap >= 0) {
      return yield* new ArchiveError({ reason: `message ${gap} is missing from the log` });
    }
    const view = files["view.json"];
    const views = view === undefined ? undefined : yield* decodeViews(view);
    return {
      messages,
      nodes,
      views: views && {
        chat: {
          ...views.chat,
          lines: views.chat.lines.map(([l, i]) => [l, i] as [number, number]),
        },
        compaction: {
          ...views.compaction,
          lines: views.compaction.lines.map(([l, i]) => [l, i] as [number, number]),
        },
      },
    } satisfies Snapshot;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ArchiveError ? cause : new ArchiveError({ reason: String(cause) }),
    ),
  );
