import type { BuiltIndex } from "./built.ts";
import { CONCURRENCY, UNBUILT_WINDOW } from "./constants.ts";
import { parent } from "./tree.ts";

export type Task = { kind: "leaf"; i: number } | { kind: "merge"; l: number; i: number };

const siblingIndex = (i: number) => i ^ 1;

export class Scheduler {
  running = 0;
  private nextUnstartedLeaf = 0;
  private readonly startedUnbuiltLeaves = new Set<number>();
  private readonly leavesToRetry: number[] = [];
  private readonly readyMerges: Array<{ l: number; i: number }> = [];
  private readonly queuedMergeKeys = new Set<string>();
  private readonly failed: Task[] = [];

  constructor(
    private readonly built: BuiltIndex,
    private readonly messageCount: () => number,
    private readonly maxRunning = CONCURRENCY,
    private readonly maxStartedUnbuiltLeaves = UNBUILT_WINDOW,
  ) {}

  init(): void {
    this.recoverReadyMergesFromBuiltNodes();
  }

  next(): Task | undefined {
    if (this.running >= this.maxRunning) return undefined;
    const task = this.peek();
    if (!task) return undefined;
    if (task.kind === "merge") this.readyMerges.shift();
    else if (this.leavesToRetry[0] === task.i) this.leavesToRetry.shift();
    else {
      this.nextUnstartedLeaf++;
      this.startedUnbuiltLeaves.add(task.i);
    }
    this.running++;
    return task;
  }

  done(task: Task, node: { l: number; i: number }): void {
    this.running--;
    if (task.kind === "leaf") this.startedUnbuiltLeaves.delete(task.i);
    this.enqueueParentIfSiblingBuilt(node.l, node.i);
  }

  fail(task: Task): void {
    this.running--;
    this.failed.push(task);
  }

  retryFailed(): void {
    for (const task of this.failed.splice(0)) {
      if (task.kind === "leaf") this.leavesToRetry.push(task.i);
      else this.readyMerges.unshift({ l: task.l, i: task.i });
    }
  }

  get failures(): number {
    return this.failed.length;
  }

  summarized(count: number): boolean {
    this.skipBuiltLeaves();
    if (this.leavesToRetry.length > 0) return false;
    return (
      this.nextUnstartedLeaf >= count && [...this.startedUnbuiltLeaves].every((i) => i >= count)
    );
  }

  idle(): boolean {
    return this.running === 0 && this.peek() === undefined;
  }

  private recoverReadyMergesFromBuiltNodes(): void {
    for (const { l, i } of this.built.entries()) this.enqueueParentIfSiblingBuilt(l, i);
  }

  private skipBuiltLeaves(): void {
    while (this.built.has(0, this.nextUnstartedLeaf)) this.nextUnstartedLeaf++;
  }

  private peek(): Task | undefined {
    if (this.leavesToRetry.length > 0) return { kind: "leaf", i: this.leavesToRetry[0]! };
    this.skipBuiltLeaves();
    const leafIsLogged = this.nextUnstartedLeaf < this.messageCount();
    const fewEnoughLeavesUnbuilt = this.startedUnbuiltLeaves.size < this.maxStartedUnbuiltLeaves;
    if (leafIsLogged && fewEnoughLeavesUnbuilt) {
      return { kind: "leaf", i: this.nextUnstartedLeaf };
    }
    const merge = this.readyMerges[0];
    return merge && { kind: "merge", ...merge };
  }

  private enqueueParentIfSiblingBuilt(l: number, i: number): void {
    if (!this.built.has(l, siblingIndex(i))) return;
    const p = parent(l, i);
    const key = `${p.l}:${p.i}`;
    if (this.built.has(p.l, p.i) || this.queuedMergeKeys.has(key)) return;
    this.queuedMergeKeys.add(key);
    this.readyMerges.push(p);
  }
}
