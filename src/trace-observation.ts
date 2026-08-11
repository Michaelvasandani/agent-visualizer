export type TerminalOutcome =
  | { readonly kind: "completed" | "cancelled" }
  | { readonly kind: "failed"; readonly error: unknown };

export interface TraceGap {
  readonly afterEventId: string | null;
  readonly historyBoundary:
    | "initial history"
    | "reconnect history"
    | "failed history recovery";
  readonly sources: readonly string[];
  readonly reason: string;
}
