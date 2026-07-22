import { Context, Effect, Layer } from "effect";

export interface ToolEvent {
  readonly tool: string;
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly context?: Record<string, unknown>;
}

export class TelemetryService extends Context.Service<
  TelemetryService,
  {
    readonly logToolEvent: (event: ToolEvent) => Effect.Effect<void>;
  }
>()("mizook/TelemetryService") {
  static readonly live = Layer.succeed(TelemetryService)({
    logToolEvent: (event) =>
      Effect.logInfo(
        `[tool=${event.tool}] outcome=${event.outcome} durationMs=${event.durationMs}`,
      ).pipe(Effect.annotateLogs("tool_event", event)),
  });
}
