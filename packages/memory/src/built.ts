export class BuiltIndex {
  private readonly nodeBytesByLevel: Array<Map<number, number>> = [];

  has(l: number, i: number): boolean {
    return this.nodeBytesByLevel[l]?.has(i) ?? false;
  }

  size(l: number, i: number): number | undefined {
    return this.nodeBytesByLevel[l]?.get(i);
  }

  set(l: number, i: number, size: number): void {
    (this.nodeBytesByLevel[l] ??= new Map()).set(i, size);
  }

  *entries(): Iterable<{ l: number; i: number; size: number }> {
    for (let l = 0; l < this.nodeBytesByLevel.length; l++) {
      for (const [i, size] of this.nodeBytesByLevel[l] ?? []) yield { l, i, size };
    }
  }
}
