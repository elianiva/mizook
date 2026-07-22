# Plan: Borrow Kody Patterns (Effect-TS Idiomatic)

## Scope

Implement 7 features from Kody into Mizook, all using idiomatic Effect-TS patterns.
Excludes: MCP-related stuff and memory (Think already handles that).

---

## 1. Budget-Aware Promise Wrapper

**What:** Wrap promises with timeout budgets, return structured results instead of throwing.

**Kody approach:** `settleWithBudget()` returns `{ ok, value, timedOut, failed }`.

**Effect-TS plan:**

```
src/core/budget.ts
```

**Implementation:**

```ts
import { Effect, Duration } from "effect"

type BudgetResult<A> =
  | { ok: true; value: A; durationMs: number }
  | { ok: false; value: null; durationMs: number; timedOut: true }
  | { ok: false; value: null; durationMs: number; failed: true; error: unknown }

const settleWithBudget = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  budgetMs: number
): Effect.Effect<BudgetResult<A>, never, R> =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis
    const result = yield* Effect.either(
      Effect.timeout(effect, Duration.millis(budgetMs))
    )
    const durationMs = yield* Clock.currentTimeMillis pipe Effect.map(now => now - start)

    if (result._tag === "Left") {
      const error = result.left
      if (error._tag === "TimeoutError") {
        return { ok: false as const, value: null, durationMs, timedOut: true as const }
      }
      return { ok: false as const, value: null, durationMs, failed: true as const, error }
    }

    return { ok: true as const, value: result.right, durationMs }
  })
```

**Usage in agent:** Wrap memory enrichment, context compaction, MCP calls with budgets.

---

## 2. Structured Tool Telemetry

**What:** Log every tool call with duration, outcome, error details.

**Kody approach:** `logMcpEvent()` with structured JSON logging.

**Effect-TS plan:**

```
src/core/telemetry.ts
```

**Implementation:**

```ts
import { Effect, Logger } from "effect";

interface ToolEvent {
  tool: string;
  outcome: "success" | "failure";
  durationMs: number;
  errorName?: string;
  errorMessage?: string;
  context?: Record<string, unknown>;
}

class TelemetryService extends Context.Service<
  TelemetryService,
  {
    readonly logToolEvent: (event: ToolEvent) => Effect.Effect<void>;
  }
>()("mizook/TelemetryService") {
  static readonly live = Layer.succeed(TelemetryService)({
    logToolEvent: (event) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("tool_event", event);
      }),
  });
}
```

**Usage:** Wrap each tool execution with timing + outcome logging via `Effect.tap` / `Effect.catch`.

---

## 3. Dynamic System Prompt Composition

**What:** Build system prompt at runtime from available tools, connected services, user preferences.

**Kody approach:** Assemble prompt from base + domains + connectors + packages + overlay.

**Effect-TS plan:**

```
src/core/prompts/composer.ts
```

**Implementation:**

```ts
class PromptComposer extends Context.Service<
  PromptComposer,
  {
    readonly compose: () => Effect.Effect<string, never, PromptContext>;
  }
>()("mizook/PromptComposer") {}
```

**PromptContext** (requirements):

- `basePrompt` — static base
- `connectedMCPServers` — list of connected MCP server names
- `availableTools` — list of tool names + descriptions
- `userPreferences` — optional user overlay

**Composition:**

```ts
const compose = Effect.fn("PromptComposer.compose")(function* () {
  const base = yield* PromptContext.base;
  const mcpServers = yield* PromptContext.mcpServers;
  const tools = yield* PromptContext.tools;
  const prefs = yield* PromptContext.preferences;

  let prompt = base;
  if (mcpServers.length > 0) {
    prompt += `\n\nConnected services: ${mcpServers.join(", ")}`;
  }
  if (tools.length > 0) {
    prompt += `\n\nAvailable tools: ${tools.map((t) => t.name).join(", ")}`;
  }
  if (prefs) {
    prompt += `\n\n---\nUser preferences:\n${prefs}`;
  }
  return prompt;
});
```

---

## 4. Capability/Tool Registry

**What:** Tools defined with metadata (description, schema, domain tags) and auto-discovered.

**Kody approach:** `define-capability.ts` with Zod schemas, auto-converted to JSON Schema.

**Effect-TS plan:**

```
src/core/registry/
├── types.ts          # ToolDefinition (Schema.Class)
├── registry.ts       # ToolRegistryService (Context.Service)
└── builtin/          # Auto-discovered tool definitions
    ├── reminders.ts
    └── browser.ts
```

**ToolDefinition:**

```ts
class ToolDefinition extends Schema.Class<ToolDefinition>("ToolDefinition")({
  name: Schema.String,
  description: Schema.String,
  domain: Schema.String,
  inputSchema: Schema.Unknown, // Zod schema passed through
}) {}
```

**ToolRegistryService:**

```ts
class ToolRegistryService extends Context.Service<
  ToolRegistryService,
  {
    readonly register: (def: ToolDefinition) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<ToolDefinition>>;
    readonly get: (name: string) => Effect.Effect<ToolDefinition, ToolNotFoundError>;
  }
>()("mizook/ToolRegistryService") {}
```

**Usage:** Tools self-register via `Layer.effectDiscard` during startup. Agent reads registry to compose prompts and validate tool calls.

---

## 5. Structured Error Types with Next Steps

**What:** Errors include `kind`, `nextStep`, `suggestedAction` for LLM self-healing.

**Kody approach:** `getExecutionErrorDetails()` parses errors into structured types.

**Effect-TS plan:**

```
src/core/errors.ts (extend existing)
```

**Add error types (use `Data.TaggedError`, not `Schema.TaggedErrorClass`):**

```ts
import { Data } from "effect";

export class ToolExecutionError extends Data.TaggedError("ToolExecutionError")<{
  readonly tool: string;
  readonly kind: string; // "rate_limit", "auth_required", "timeout", "unknown"
  readonly message: string;
  readonly nextStep: string;
  readonly suggestedAction?: {
    readonly type: string;
    readonly params?: Record<string, string>;
  };
}> {}

export class MemoryError extends Data.TaggedError("MemoryError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}

export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly budgetMs: number;
  readonly operation: string;
}> {}
```

**Error classifier:**

```ts
const classifyToolError = (tool: string, error: unknown): ToolExecutionError => {
  // Parse error message and return structured error with nextStep
};
```

---

## 6. Tool Timing Utilities

**What:** Consistent duration measurement across all tools.

**Kody approach:** `startToolTiming()` / `finishToolTiming()`.

**Effect-TS plan:**

```
src/core/timing.ts
```

**Implementation:**

```ts
import { Effect, Clock } from "effect";

interface ToolTiming {
  startTimeMs: number;
  durationMs?: number;
}

const startToolTiming: Effect.Effect<ToolTiming, never, never> = Clock.currentTimeMillis.pipe(
  Effect.map((t) => ({ startTimeMs: t })),
);

const finishToolTiming = (timing: ToolTiming): Effect.Effect<ToolTiming, never, never> =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => ({
      ...timing,
      durationMs: now - timing.startTimeMs,
    })),
  );
```

**Usage:**

```ts
const timing = yield* startToolTiming
const result = yield* doToolWork
const finalTiming = yield* finishToolTiming(timing)
yield* telemetry.logToolEvent({ tool: "my_tool", durationMs: finalTiming.durationMs, ... })
```

---

## 7. Markdown Safety

**What:** Safe markdown construction for Telegram messages.

**Kody approach:** `escapeMarkdownText()`, `formatMarkdownInlineCode()`.

**Effect-TS plan:**

```
src/core/markdown.ts
```

**Implementation:**

````ts
// Telegram uses a limited subset of Markdown (MarkdownV2)
// Characters that need escaping in MarkdownV2:
// _ * [ ] ( ) ~ ` > # + - = | { } . !

export const escapeMarkdownV2 = (text: string): string =>
  text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");

export const formatInlineCode = (code: string): string => `\`${code.replace(/`/g, "\\`")}\``;

export const formatBold = (text: string): string => `*${escapeMarkdownV2(text)}*`;

export const formatCodeBlock = (code: string, lang?: string): string =>
  lang
    ? `\`\`\`${lang}\n${code.replace(/```/g, "\\`\\`\\`")}\n\`\`\``
    : `\`\`\`\n${code.replace(/```/g, "\\`\\`\\`")}\n\`\`\``;
````

---

## File Structure After Implementation

```
src/
├── core/
│   ├── agent.ts           (modified: use PromptComposer, TelemetryService)
│   ├── env.ts             (unchanged)
│   ├── errors.ts          (extended: ToolExecutionError, BudgetExceededError)
│   ├── model.ts           (unchanged)
│   ├── runtime.ts         (modified: add new layers)
│   ├── workers-env.ts     (unchanged)
│   ├── budget.ts          (NEW: settleWithBudget)
│   ├── telemetry.ts       (NEW: TelemetryService)
│   ├── timing.ts          (NEW: startToolTiming, finishToolTiming)
│   ├── markdown.ts        (NEW: escapeMarkdownV2, formatInlineCode, etc.)
│   ├── prompts/
│   │   ├── base.ts        (unchanged)
│   │   └── composer.ts    (NEW: PromptComposer)
│   └── registry/
│       ├── types.ts       (NEW: ToolDefinition)
│       ├── registry.ts    (NEW: ToolRegistryService)
│       └── builtin/       (NEW: tool definitions)
│           ├── reminders.ts
│           └── browser.ts
├── features/
│   ├── browser/           (unchanged)
│   └── reminders/         (unchanged)
└── index.ts               (unchanged)
```

---

## Implementation Order

1. **Error types** (extend `errors.ts`) — foundation for everything
2. **Timing utilities** (`timing.ts`) — trivial, needed by telemetry
3. **Markdown safety** (`markdown.ts`) — standalone, no dependencies
4. **Budget wrapper** (`budget.ts`) — standalone, uses Clock
5. **Telemetry service** (`telemetry.ts`) — uses timing
6. **Tool registry** (`registry/`) — uses error types
7. **Prompt composer** (`prompts/composer.ts`) — uses registry
8. **Wire into agent** — integrate all new services

---

## Verification

- `vp check` passes (lint + format + type-check)
- No new runtime dependencies needed (all Effect built-ins)
- Each feature is independently testable
- Existing tools (reminders, browser) continue working unchanged
