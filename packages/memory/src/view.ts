import type { BuiltIndex } from "./built.ts";
import { BLOCK_LINES, PLACEHOLDER } from "./constants.ts";
import { first, label, last, parent } from "./tree.ts";
import type { Line, ViewBudget, ViewState } from "./types.ts";

const LABEL_TEXT_SEPARATOR_BYTES = "|".length;
const LINE_BREAK_BYTES = "\n".length;
const PLACEHOLDER_BYTES = new TextEncoder().encode(PLACEHOLDER).length;

export class View {
  lines: Line[];
  pending: boolean;

  constructor(
    private readonly built: BuiltIndex,
    readonly budget: ViewBudget,
    state?: ViewState,
  ) {
    this.lines = state ? state.lines.map(([l, i]) => ({ l, i })) : [];
    this.pending = state?.pending ?? false;
  }

  get end(): number {
    const tail = this.lines.at(-1);
    return tail ? last(tail.l, tail.i) + 1 : 0;
  }

  state(): ViewState {
    return { lines: this.lines.map(({ l, i }) => [l, i]), pending: this.pending };
  }

  lineBytes({ l, i }: Line): number {
    const textBytes = this.built.size(l, i) ?? PLACEHOLDER_BYTES;
    return label(l, i).length + LABEL_TEXT_SEPARATOR_BYTES + textBytes + LINE_BREAK_BYTES;
  }

  bytes(): number {
    let total = 0;
    for (const line of this.lines) total += this.lineBytes(line);
    return total;
  }

  append(l: number, i: number): void {
    this.lines.push({ l, i });
  }

  mergeOne(total: number): Line | undefined {
    let mostDuePair = -1;
    let highestDue = -Infinity;
    for (let k = 0; k + 1 < this.lines.length; k++) {
      const a = this.lines[k]!;
      const b = this.lines[k + 1]!;
      if (!areSiblings(a, b)) continue;
      const p = parent(a.l, a.i);
      if (!this.built.has(p.l, p.i)) continue;
      const due = messagesSincePairEnded(total, b);
      const moreDueThanEveryOlderPair = due > highestDue;
      if (moreDueThanEveryOlderPair) {
        highestDue = due;
        mostDuePair = k;
      }
    }
    if (mostDuePair < 0) return undefined;
    const a = this.lines[mostDuePair]!;
    const p = parent(a.l, a.i);
    this.lines.splice(mostDuePair, 2, p);
    return p;
  }

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

  coarsenTo(finerOrEqualLines: readonly Line[]): void {
    const out: Line[] = [];
    for (const line of this.lines) {
      const container = findLineCovering(finerOrEqualLines, first(line.l, line.i));
      const merged =
        container && container.l > line.l && last(container.l, container.i) >= last(line.l, line.i);
      const next = merged ? container : line;
      const tail = out.at(-1);
      if (!tail || tail.l !== next.l || tail.i !== next.i) out.push(next);
    }
    this.lines = out;
  }

  builtPrefix(boundary: number): Line[] {
    const prefix: Line[] = [];
    for (const line of this.lines) {
      const endsBeforeBoundary = last(line.l, line.i) < boundary;
      if (!endsBeforeBoundary) break;
      if (!this.built.has(line.l, line.i)) break;
      prefix.push(line);
    }
    return prefix;
  }
}

const areSiblings = (a: Line, b: Line) => a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1;

const messagesSincePairEnded = (total: number, secondOfPair: Line) =>
  (total - last(secondOfPair.l, secondOfPair.i)) / 2 ** secondOfPair.l;

function findLineCovering(sortedDisjointLines: readonly Line[], message: number): Line | undefined {
  let lo = 0;
  let hi = sortedDisjointLines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = sortedDisjointLines[mid]!;
    if (last(line.l, line.i) < message) lo = mid + 1;
    else if (first(line.l, line.i) > message) hi = mid - 1;
    else return line;
  }
  return undefined;
}

export interface Rendered {
  blocks: string[];
  markIndex: number;
  closing: string;
  text: string;
}

const NO_WHOLE_BLOCK = -1;

export function render(
  lines: ReadonlyArray<{ l: number; i: number; text: string | undefined }>,
): Rendered {
  const blocks: string[] = [];
  let block = "<chat>\n";
  let count = 0;
  let markIndex = NO_WHOLE_BLOCK;
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
