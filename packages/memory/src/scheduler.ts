import type { BuiltIndex } from "./built.ts";
import { CONCURRENCY, UNBUILT_WINDOW } from "./constants.ts";
import { parent } from "./tree.ts";

export type Task = { kind: "leaf"; i: number } | { kind: "merge"; l: number; i: number };

/**
 * Which node to build next. Pure and synchronous: the compactor runs the tasks.
 *
 * Ready nodes wait in queues, and the tree is never scanned for work (that is O(N^2) over a long
 * chat). Up to 8 calls run at once.
 *
 * - A message's node starts once fewer than 8 lines before it are still unbuilt.
 * - A merge starts once both its halves are built.
 */
export class Scheduler {
  running = 0;
  /** The next message whose node has not been started. */
  private leafNext = 0;
  /** Messages started and not built yet, including failed ones. */
  private readonly unbuilt = new Set<number>();
  private readonly retryLeaves: number[] = [];
  private readonly merges: Array<{ l: number; i: number }> = [];
  private readonly queued = new Set<string>();
  private readonly failed: Task[] = [];

  constructor(
    private readonly built: BuiltIndex,
    private readonly total: () => number,
    private readonly concurrency = CONCURRENCY,
    private readonly window = UNBUILT_WINDOW,
  ) {}

  /** Recover the queues from what is built: after a restart. */
  init(): void {
    for (const { l, i } of this.built.entries()) this.enqueueParent(l, i);
  }

  /** The next task to start, or nothing if the limit is reached or no node is ready. Counts it as running. */
  next(): Task | undefined {
    if (this.running >= this.concurrency) return undefined;
    const task = this.peek();
    if (!task) return undefined;
    if (task.kind === "merge") this.merges.shift();
    else if (this.retryLeaves[0] === task.i) this.retryLeaves.shift();
    else {
      this.leafNext++;
      this.unbuilt.add(task.i);
    }
    this.running++;
    return task;
  }

  /** The node of `task` is built and committed. */
  done(task: Task, node: { l: number; i: number }): void {
    this.running--;
    if (task.kind === "leaf") this.unbuilt.delete(task.i);
    this.enqueueParent(node.l, node.i);
  }

  fail(task: Task): void {
    this.running--;
    this.failed.push(task);
  }

  /** A failed call is tried again at the next message. */
  retryFailed(): void {
    for (const task of this.failed.splice(0)) {
      if (task.kind === "leaf") this.retryLeaves.push(task.i);
      else this.merges.unshift({ l: task.l, i: task.i });
    }
  }

  get failures(): number {
    return this.failed.length;
  }

  /** Every message before `count` has its node. */
  summarized(count: number): boolean {
    this.skipBuilt();
    if (this.retryLeaves.length > 0) return false;
    return this.leafNext >= count && [...this.unbuilt].every((i) => i >= count);
  }

  /** Nothing is running or ready to run. Failed tasks wait for `retryFailed`. */
  idle(): boolean {
    return this.running === 0 && this.peek() === undefined;
  }

  private skipBuilt(): void {
    while (this.built.has(0, this.leafNext)) this.leafNext++;
  }

  private peek(): Task | undefined {
    if (this.retryLeaves.length > 0) return { kind: "leaf", i: this.retryLeaves[0]! };
    this.skipBuilt();
    if (this.leafNext < this.total() && this.unbuilt.size < this.window) {
      return { kind: "leaf", i: this.leafNext };
    }
    const merge = this.merges[0];
    return merge && { kind: "merge", ...merge };
  }

  private enqueueParent(l: number, i: number): void {
    if (!this.built.has(l, i ^ 1)) return;
    const p = parent(l, i);
    const key = `${p.l}:${p.i}`;
    if (this.built.has(p.l, p.i) || this.queued.has(key)) return;
    this.queued.add(key);
    this.merges.push(p);
  }
}
