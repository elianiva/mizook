/** Kinds of messages in the log. */
export type Kind = "user" | "agent" | "tool" | "echo" | "note";

export interface Message {
  /** Permanent id: the position in the log. */
  i: number;
  kind: Kind;
  text: string;
  /** UTF-8 bytes of `text`. */
  size: number;
  /** ISO 8601 timestamp. */
  date: string;
}

/** `node(l, i)` covers the 2^l messages from `i * 2^l` on. */
export interface Node {
  l: number;
  i: number;
  text: string;
  /** UTF-8 bytes of `text`. */
  size: number;
}

/** A line of a view: the node `(l, i)`. */
export interface Line {
  l: number;
  i: number;
}

/** The two budgets of a view: it grows past `hi` bytes, then one batch merges it down to `lo`. */
export interface ViewBudget {
  hi: number;
  lo: number;
}

export interface ViewState {
  lines: Array<[l: number, i: number]>;
  /** A batch was triggered and has not reached `lo` yet. */
  pending: boolean;
}

/** All of a chat: what an export holds and an import restores. */
export interface Snapshot {
  messages: Message[];
  nodes: Node[];
  views?: PersistedViews | undefined;
}

export interface PersistedViews {
  chat: ViewState;
  compaction: ViewState;
}
