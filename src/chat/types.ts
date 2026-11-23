export type WebMessageRole = "user" | "agent";

export interface WebMessage {
  readonly id: number;
  readonly role: WebMessageRole;
  readonly text: string;
  readonly at: number;
}

export type WebTurnResult =
  | { readonly ok: true; readonly folded: boolean }
  | { readonly ok: false; readonly reason: string };

export interface WebApproval {
  readonly id: number;
  readonly summary: string;
  readonly match: string;
  readonly created: number;
}

export interface WebStatus {
  readonly running: boolean;
  readonly approvals: ReadonlyArray<WebApproval>;
}

export interface WebState extends WebStatus {
  readonly messages: ReadonlyArray<WebMessage>;
}
