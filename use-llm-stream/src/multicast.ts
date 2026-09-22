interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export interface MulticastOptions {
  /** Called once, when the last subscriber unsubscribes before the source
   * has finished. Use it to cancel the underlying request. */
  onAbort?: () => void;
  /** Called once, when the source finishes — successfully or with an
   * error — regardless of how many subscribers are still attached. */
  onSettle?: () => void;
}

/**
 * Wraps a single AsyncIterable so it can be read by more than one
 * subscriber. The source is consumed at most once, lazily, starting on the
 * first `subscribe()`. A subscriber that joins after the stream started
 * gets every already-emitted chunk first (in order), then switches to
 * live chunks — the underlying source never fires twice no matter how
 * many subscribers attach. Each subscriber tracks its own read position,
 * so a slow reader never blocks or skips chunks for a fast one.
 */
export class MulticastStream<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private hasError = false;
  private error: unknown = undefined;
  private refCount = 0;
  private started = false;
  private sourceIterator: AsyncIterator<T> | null = null;
  private waiter: Deferred = createDeferred();

  constructor(
    private readonly source: AsyncIterable<T>,
    private readonly opts: MulticastOptions = {},
  ) {}

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.sourceIterator = this.source[Symbol.asyncIterator]();
    void this.pump();
  }

  private wake(): void {
    const previous = this.waiter;
    this.waiter = createDeferred();
    previous.resolve();
  }

  private async pump(): Promise<void> {
    try {
      const iterator = this.sourceIterator!;
      while (true) {
        const result = await iterator.next();
        if (result.done) {
          this.done = true;
          this.wake();
          this.opts.onSettle?.();
          return;
        }
        this.buffer.push(result.value);
        this.wake();
      }
    } catch (err) {
      this.hasError = true;
      this.error = err;
      this.done = true;
      this.wake();
      this.opts.onSettle?.();
    }
  }

  /** Attach a new subscriber. Starts the source on the first call. */
  subscribe(): AsyncIterableIterator<T> {
    this.ensureStarted();

    let index = 0;
    let active = true;
    this.refCount++;

    const cleanup = (): void => {
      if (!active) return;
      active = false;
      this.refCount--;
      if (this.refCount === 0 && !this.done) {
        this.opts.onAbort?.();
        void this.sourceIterator?.return?.();
      }
    };

    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: async (): Promise<IteratorResult<T>> => {
        while (true) {
          if (index < this.buffer.length) {
            const value = this.buffer[index] as T;
            index++;
            return { value, done: false };
          }
          if (this.done) {
            cleanup();
            if (this.hasError) throw this.error;
            return { value: undefined as unknown as T, done: true };
          }
          await this.waiter.promise;
        }
      },
      return: async (value?: unknown): Promise<IteratorResult<T>> => {
        cleanup();
        return { value: value as T, done: true };
      },
      throw: async (err?: unknown): Promise<IteratorResult<T>> => {
        cleanup();
        throw err;
      },
    };

    return iterator;
  }
}
