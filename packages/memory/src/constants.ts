import type { ViewBudget } from "./types.ts";

/** Maximum size of a node, in UTF-8 bytes. 128 was too small for useful lines. */
export const NODE_MAX = 512;
/** What the turns see. */
export const CHAT_BUDGET: ViewBudget = { hi: 128_000, lo: 64_000 };
/** What compactions see: small enough to share one cache entry, big enough to resolve references. */
export const COMPACTION_BUDGET: ViewBudget = { hi: 32_000, lo: 16_000 };
/** A longer text is logged as several messages in a row. */
export const MAX_MESSAGE_BYTES = 30_000;
/** A tool's output is clipped to its head and tail, this many characters in all. */
export const TOOL_OUTPUT_MAX_CHARS = 30_000;
/** Compaction calls running at once. */
export const CONCURRENCY = 8;
/** A message's node starts once fewer than this many lines before it are unbuilt. */
export const UNBUILT_WINDOW = 8;
/** Attempts to get a line under `NODE_MAX`. */
export const MAX_TRIES = 5;
/** View lines are grouped into blocks of this many lines, for prompt cache marks. */
export const BLOCK_LINES = 4;
export const PLACEHOLDER = "(not summarized yet: zoom it)";
