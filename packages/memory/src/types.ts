type Utf8ByteCount = number;
type Iso8601Timestamp = string;

export type Kind = "user" | "agent" | "tool" | "echo" | "note";

export interface Message {
  i: number;
  kind: Kind;
  text: string;
  size: Utf8ByteCount;
  date: Iso8601Timestamp;
}

export interface SearchHit {
  readonly i: number;
  readonly kind: Kind;
  readonly date: string;
  readonly snippet: string;
}

export interface Node {
  l: number;
  i: number;
  text: string;
  size: Utf8ByteCount;
}

export interface Line {
  l: number;
  i: number;
}

export interface ViewBudget {
  hi: Utf8ByteCount;
  lo: Utf8ByteCount;
}

export interface ViewState {
  lines: Array<[l: number, i: number]>;
  pending: boolean;
}

export interface Snapshot {
  messages: Message[];
  nodes: Node[];
  views?: PersistedViews | undefined;
}

export interface PersistedViews {
  chat: ViewState;
  compaction: ViewState;
}
