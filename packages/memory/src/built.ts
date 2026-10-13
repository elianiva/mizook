/** Which nodes are built, and how big they are. Sizes only: the texts live in the store. */
export class BuiltIndex {
  private readonly levels: Array<Map<number, number>> = [];

  has(l: number, i: number): boolean {
    return this.levels[l]?.has(i) ?? false;
  }

  size(l: number, i: number): number | undefined {
    return this.levels[l]?.get(i);
  }

  set(l: number, i: number, size: number): void {
    (this.levels[l] ??= new Map()).set(i, size);
  }

  *entries(): Iterable<{ l: number; i: number; size: number }> {
    for (let l = 0; l < this.levels.length; l++) {
      for (const [i, size] of this.levels[l] ?? []) yield { l, i, size };
    }
  }
}
