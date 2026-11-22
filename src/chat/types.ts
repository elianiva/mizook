export type WebMessageRole = "user" | "agent";

export interface WebMessage {
  readonly id: number;
  readonly role: WebMessageRole;
  readonly text: string;
  readonly at: number;
}

export type WebTurnResult =
  | {
      readonly ok: true;
      readonly folded: boolean;
      readonly messageId: number;
      readonly at: number;
    }
  | { readonly ok: false; readonly reason: string };

export interface WebApproval {
  readonly id: number;
  readonly summary: string;
  readonly match: string;
  readonly created: number;
}

export interface WebState {
  readonly messages: ReadonlyArray<WebMessage>;
  readonly running: boolean;
  readonly approvals: ReadonlyArray<WebApproval>;
}
