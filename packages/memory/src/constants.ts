import type { ViewBudget } from "./types.ts";

const MAX_NODE_UTF8_BYTES = 512;
const MAX_PARALLEL_COMPACTION_CALLS = 8;
const MAX_UNBUILT_LEAVES_BEFORE_NEXT_LEAF = 8;
const ATTEMPTS_TO_FIT_LINE_IN_NODE = 5;
const VIEW_LINES_PER_CACHE_BLOCK = 4;

export const NODE_MAX = MAX_NODE_UTF8_BYTES;
export const CHAT_BUDGET: ViewBudget = { hi: 128_000, lo: 64_000 };
export const COMPACTION_BUDGET: ViewBudget = { hi: 32_000, lo: 16_000 };
export const MAX_MESSAGE_BYTES = 30_000;
export const TOOL_OUTPUT_MAX_CHARS = 30_000;
export const CONCURRENCY = MAX_PARALLEL_COMPACTION_CALLS;
export const UNBUILT_WINDOW = MAX_UNBUILT_LEAVES_BEFORE_NEXT_LEAF;
export const MAX_TRIES = ATTEMPTS_TO_FIT_LINE_IN_NODE;
export const BLOCK_LINES = VIEW_LINES_PER_CACHE_BLOCK;
export const PLACEHOLDER = "(not summarized yet: zoom it)";
