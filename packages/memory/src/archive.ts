import { Effect, Schema } from "effect";
import { ArchiveError } from "./errors.ts";
import { last } from "./tree.ts";
import type { Node, Snapshot } from "./types.ts";

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

export type Files = Readonly<Record<string, string>>;

const MESSAGES_DIR = "main/";
const NODES_DIR = "tree/";
const VIEWS_FILE = "view.json";
const ISO_DAY_LENGTH = "YYYY-MM-DD".length;

const isoDay = (isoTimestamp: string) => isoTimestamp.slice(0, ISO_DAY_LENGTH);

export const toFiles = (snapshot: Snapshot): Files => {
  const files: Record<string, string> = {};
  const appendJsonLine = (path: string, line: unknown) => {
    files[path] = `${files[path] ?? ""}${JSON.stringify(line)}\n`;
  };
  const dayOfLastLoggedMessageUnder = (node: Node) => {
    const lastLogged = Math.min(last(node.l, node.i), snapshot.messages.length - 1);
    const message = snapshot.messages[lastLogged];
    return message ? isoDay(message.date) : "unknown";
  };
  for (const m of snapshot.messages) appendJsonLine(`${MESSAGES_DIR}${isoDay(m.date)}.jsonl`, m);
  for (const n of snapshot.nodes) {
    appendJsonLine(`${NODES_DIR}${dayOfLastLoggedMessageUnder(n)}.jsonl`, n);
  }
  if (snapshot.views) files[VIEWS_FILE] = JSON.stringify(snapshot.views);
  return files;
};

const nonEmptyLines = (text: string) => text.split("\n").filter((line) => line !== "");

export const fromFiles = (files: Files) =>
  Effect.gen(function* () {
    const paths = Object.keys(files).sort();
    const linesUnder = (dir: string) =>
      paths.filter((p) => p.startsWith(dir)).flatMap((p) => nonEmptyLines(files[p]!));
    const messages = yield* Effect.forEach(linesUnder(MESSAGES_DIR), (line) => decodeMessage(line));
    const nodes = yield* Effect.forEach(linesUnder(NODES_DIR), (line) => decodeNode(line));
    messages.sort((a, b) => a.i - b.i);
    const firstMissingMessage = messages.findIndex((m, position) => m.i !== position);
    if (firstMissingMessage >= 0) {
      return yield* new ArchiveError({
        reason: `message ${firstMissingMessage} is missing from the log`,
      });
    }
    const view = files[VIEWS_FILE];
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
