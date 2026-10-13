import type { BuiltIndex } from "./built.ts";
import { BLOCK_LINES, PLACEHOLDER } from "./constants.ts";
import { first, label, last, parent } from "./tree.ts";
import type { Line, ViewBudget, ViewState } from "./types.ts";

/**
 * A list of nodes that covers the whole chat, oldest first.
 *
 * Each message appends its line and nothing else changes. Once the view passes `hi` bytes, one
 * batch merges the most due pairs until it is at most `lo` bytes. So the view is a sawtooth, and
 * between batches it only grows at its end: that is what keeps the prompt cache warm.
 */
export class View {
  lines: Line[];
  /** A batch was triggered and has not reached `lo` yet: merge what can be merged at each step. */
  pending: boolean;

  constructor(
    private readonly built: BuiltIndex,
    readonly budget: ViewBudget,
    state?: ViewState,
  ) {
    this.lines = state ? state.lines.map(([l, i]) => ({ l, i })) : [];
    this.pending = state?.pending ?? false;
  }

  /** One past the last message covered. */
  get end(): number {
    const tail = this.lines.at(-1);
    return tail ? last(tail.l, tail.i) + 1 : 0;
  }

  state(): ViewState {
    return { lines: this.lines.map(({ l, i }) => [l, i]), pending: this.pending };
  }

  /** Bytes of a line as rendered: `id+n|text` and a line break. */
  lineBytes({ l, i }: Line): number {
    const text = this.built.size(l, i) ?? new TextEncoder().encode(PLACEHOLDER).length;
    return label(l, i).length + 1 + text + 1;
  }

  bytes(): number {
    let total = 0;
    for (const line of this.lines) total += this.lineBytes(line);
    return total;
  }

  append(l: number, i: number): void {
    this.lines.push({ l, i });
  }

  /**
   * Merge the most due pair whose parent is built. For sibling lines `(l, i)` and `(l, i + 1)`,
   * with `total` messages in the chat:
   *
   *     due = (total - last) / 2^l      last: the pair's last message
   *
   * That is how long ago the pair ended, in its own line size. Of equal pairs the oldest goes
   * first. Measuring from the pair's first message instead makes old lines churn. This order is
   * exactly the merge order of Taelin's rollback `push`.
   */
  mergeOne(total: number): Line | undefined {
    let best = -1;
    let bestDue = -Infinity;
    for (let k = 0; k + 1 < this.lines.length; k++) {
      const a = this.lines[k]!;
      const b = this.lines[k + 1]!;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      const p = parent(a.l, a.i);
      if (!this.built.has(p.l, p.i)) continue;
      const due = (total - last(b.l, b.i)) / 2 ** a.l;
      if (due > bestDue) {
        bestDue = due;
        best = k;
      }
    }
    if (best < 0) return undefined;
    const a = this.lines[best]!;
    const p = parent(a.l, a.i);
    this.lines.splice(best, 2, p);
    return p;
  }

  /** Run a batch if one is due or under way. Returns the lines it created. */
  shrink(total: number): Line[] {
    const merged: Line[] = [];
    if (!this.pending && this.bytes() > this.budget.hi) this.pending = true;
    if (!this.pending) return merged;
    let bytes = this.bytes();
    while (bytes > this.budget.lo) {
      const line = this.mergeOne(total);
      if (!line) break;
      merged.push(line);
      bytes = this.bytes();
    }
    if (bytes <= this.budget.lo) this.pending = false;
    return merged;
  }

  /**
   * Merge this view's lines up to the lines of a finer-or-equal `other` view that are coarser here.
   * Used to keep the compaction view at least as merged as the chat view.
   */
  coarsenTo(other: readonly Line[]): void {
    const out: Line[] = [];
    for (const line of this.lines) {
      const container = find(other, first(line.l, line.i));
      const merged =
        container && container.l > line.l && last(container.l, container.i) >= last(line.l, line.i);
      const next = merged ? container : line;
      const tail = out.at(-1);
      if (!tail || tail.l !== next.l || tail.i !== next.i) out.push(next);
    }
    this.lines = out;
  }

  /** The lines before message `boundary`, up to the first one not built. */
  builtPrefix(boundary: number): Line[] {
    const prefix: Line[] = [];
    for (const line of this.lines) {
      if (last(line.l, line.i) >= boundary) break;
      if (!this.built.has(line.l, line.i)) break;
      prefix.push(line);
    }
    return prefix;
  }
}

/** The line of sorted, non-overlapping `lines` that starts at or before `at`, and covers it. */
function find(lines: readonly Line[], at: number): Line | undefined {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid]!;
    if (last(line.l, line.i) < at) lo = mid + 1;
    else if (first(line.l, line.i) > at) hi = mid - 1;
    else return line;
  }
  return undefined;
}

export interface Rendered {
  /** `<chat>` and the lines, in blocks of `BLOCK_LINES` lines. */
  blocks: string[];
  /** Index of the last whole block, where a cache mark goes; -1 if none. */
  markIndex: number;
  closing: string;
  text: string;
}

/** Render lines (with their texts) as the `<chat>` section of a prompt. */
export function render(
  lines: ReadonlyArray<{ l: number; i: number; text: string | undefined }>,
): Rendered {
  const blocks: string[] = [];
  let block = "<chat>\n";
  let count = 0;
  let markIndex = -1;
  for (const line of lines) {
    const text = (line.text ?? PLACEHOLDER).replace(/\n/g, " ");
    block += `${label(line.l, line.i)}|${text}\n`;
    if (++count % BLOCK_LINES === 0) {
      blocks.push(block);
      markIndex = blocks.length - 1;
      block = "";
    }
  }
  if (block !== "") blocks.push(block);
  const closing = "</chat>";
  return { blocks, markIndex, closing, text: blocks.join("") + closing };
}
