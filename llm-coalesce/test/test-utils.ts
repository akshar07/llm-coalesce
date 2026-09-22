/** A deferred-controllable async source for tests: push chunks, fail, or
 * finish on demand, and count how many times the source itself is iterated
 * (i.e. how many times Symbol.asyncIterator was invoked). */
export class ControllableSource<T> implements AsyncIterable<T> {
  iterationCount = 0;
  private queue: Array<{ value: T } | { error: unknown } | "done"> = [];
  private waiter: (() => void) | null = null;
  private cancelled = false;

  push(value: T): void {
    this.queue.push({ value });
    this.waiter?.();
  }

  fail(error: unknown): void {
    this.queue.push({ error });
    this.waiter?.();
  }

  finish(): void {
    this.queue.push("done");
    this.waiter?.();
  }

  wasCancelled(): boolean {
    return this.cancelled;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    this.iterationCount++;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (this.queue.length === 0) {
          await new Promise<void>((resolve) => {
            this.waiter = resolve;
          });
          this.waiter = null;
        }
        const item = this.queue.shift()!;
        if (item === "done") return { value: undefined, done: true };
        if ("error" in item) throw item.error;
        return { value: item.value, done: false };
      },
      return: async (value?: unknown): Promise<IteratorResult<T>> => {
        this.cancelled = true;
        return { value: value as T, done: true };
      },
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drains an async iterable into an array, useful for asserting full replay. */
export async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}
