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
  /**
   * Called exactly once, when the last active subscriber unsubscribes
   * *before* the source has finished — e.g. every widget reading a stream
   * unmounted early. Use it to abort the underlying request. Not called if
   * the source already completed naturally (see `onSettle`).
   */
  onAbort?: () => void;
  /**
   * Called exactly once, when the source finishes — successfully or with
   * an error — regardless of how many subscribers are still attached.
   * llm-coalesce does not cache resolved streams by default: this is
   * normally used to free the registry entry so the *next* call with the
   * same key starts a fresh request instead of replaying a finished one.
   */
  onSettle?: () => void;
}

/**
 * Wraps a single AsyncIterable in a hot, replay-buffered broadcaster.
 *
 * The source is consumed at most once, lazily, on the first `subscribe()`.
 * A subscriber that joins after the stream started receives every buffered
 * chunk first, in order, then switches to live chunks as they arrive — the
 * upstream call never fires twice no matter how many subscribers attach.
 *
 * Each subscriber tracks its own read cursor into the buffer, so a slow
 * reader never blocks a fast one (no shared read pointer).
 *
 * v0.1 buffers the full stream in memory with no eviction — correct for
 * request/response-shaped completions, but not yet bounded for very
 * long-lived streams (e.g. a runaway agent loop). Buffer bounding is a
 * planned v0.2 addition; see the roadmap in README.md.
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

  /** Number of chunks currently buffered. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /** Number of subscribers currently attached. */
  get subscriberCount(): number {
    return this.refCount;
  }

  /** Whether the underlying source has finished (successfully or not). */
  get isDone(): boolean {
    return this.done;
  }

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
      // sourceIterator is always set before pump() is invoked (ensureStarted)
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

  /**
   * Attach a new subscriber. Starts the underlying source on first call.
   * The returned iterator replays any already-buffered chunks before
   * switching to live delivery.
   */
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
      [Symbol.asyncIterator](): AsyncIterableIterator<T> {
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
