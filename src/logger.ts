import { initWorkersLogger, createWorkersLogger } from "evlog/workers";
import { createLogger, log as globalLog } from "evlog";

initWorkersLogger({ env: { service: "mizook" } });

export { globalLog as log };

export function createRequestLogger(request: Request, ctx: ExecutionContext) {
  return createWorkersLogger(request, { executionCtx: ctx });
}

export function createScopedLogger(opts?: Record<string, unknown>) {
  return createLogger(opts);
}