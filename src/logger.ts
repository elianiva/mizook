import { initLogger } from "evlog";
import { createWorkersLogger } from "evlog/workers";
import { createLogger } from "evlog";

initLogger({ env: { service: "mizook" }, pretty: false });

export function createRequestLogger(request: Request, ctx: ExecutionContext) {
  return createWorkersLogger(request, { executionCtx: ctx });
}

export function createScopedLogger(opts?: Record<string, unknown>) {
  return createLogger({ detail: opts });
}


