import {
  memoryAdapter,
  memoryRunAdapter,
  type RunAdapter,
  type StreamAdapter,
  type StreamRegistryEntry,
} from "./adapters.js";
import { stableHash } from "./key.js";
import { MulticastStream } from "./multicast.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { toAsyncIterable } from "./stream-utils.js";

export type Request = string | Record<string, unknown>;

export interface CoalescerOptions {
  /** Registry for `run()` (non-streaming) calls. Defaults to an in-process Map. */
  runAdapter?: RunAdapter;
  /** Registry for `stream()` calls. Defaults to an in-process Map — pass
   * `windowAdapter()` to coordinate across independently bundled widgets
   * on the same page. */
  streamAdapter?: StreamAdapter;
  /**
   * Turns a non-string request into a cache key. Defaults to a canonical serialization
   * of the whole object (order-independent, so `{a,b}` and `{b,a}` collide
   * on purpose — but `{maxTokens:500}` and `{maxTokens:800}` do NOT, by
   * design; see src/key.ts).
   */
  keyFn?: (request: Record<string, unknown>) => string;
}

export interface Coalescer {
  /**
   * Coalesce a plain async call. Concurrent calls with the same key share
   * one invocation of `fn`; once it settles (success or failure), the next
   * call with that key invokes `fn` again — this is in-flight deduping,
   * not a result cache.
   */
  run<T>(request: Request, fn: () => Promise<T>): Promise<T>;

  /**
   * Coalesce a streaming call. `fn` is invoked only for the first caller
   * with a given key; every other concurrent (or slightly-later) caller
   * attaches to the same live stream instead — buffered chunks replay
   * first, then live chunks continue. `fn` never fires twice for one key
   * while a stream for it is in flight.
   */
  stream<T>(
    request: Request,
    fn: () => AsyncIterable<T> | ReadableStream<T> | Promise<AsyncIterable<T> | ReadableStream<T>>,
  ): Promise<AsyncIterableIterator<T>>;
}

function resolveKey(
  request: Request,
  keyFn: (request: Record<string, unknown>) => string,
): string {
  return typeof request === "string" ? `string:${request}` : `object:${keyFn(request)}`;
}

/**
 * Wraps a thunk in an AsyncIterable that only calls the thunk once its
 * `Symbol.asyncIterator` is actually invoked (by MulticastStream's first
 * `subscribe()`), and only ever calls it once no matter how many times
 * iteration is attempted.
 *
 * This is what makes the registration-before-fetch ordering below work:
 * `coalescer.stream()` can synchronously register a registry entry and
 * call `mc.subscribe()` *before* the provider thunk has actually run,
 * because the thunk doesn't run until that first subscribe reaches into
 * the pump loop. Without this, `await fn()` would have to happen before
 * registration, and N callers arriving in the same tick (the exact
 * scenario this library exists for) would all race past the empty
 * registry and all invoke the thunk — the thundering-herd bug this
 * package is supposed to prevent.
 */
function lazySource<T>(
  fn: () => AsyncIterable<T> | ReadableStream<T> | Promise<AsyncIterable<T> | ReadableStream<T>>,
): AsyncIterable<T> {
  let initPromise: Promise<AsyncIterator<T>> | null = null;

  const init = (): Promise<AsyncIterator<T>> => {
    if (!initPromise) {
      initPromise = Promise.resolve(fn()).then((raw) => {
        const iterable = toAsyncIterable(raw);
        return iterable[Symbol.asyncIterator]();
      });
    }
    return initPromise;
  };

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: async (): Promise<IteratorResult<T>> => {
          const it = await init();
          return it.next();
        },
        return: async (value?: unknown): Promise<IteratorResult<T>> => {
          const it = await init();
          return it.return ? it.return(value) : { value: value as T, done: true };
        },
      };
    },
  };
}

export function createCoalescer(options: CoalescerOptions = {}): Coalescer {
  const keyFn = options.keyFn ?? stableHash;
  const runAdapter = options.runAdapter ?? memoryRunAdapter();
  const streamAdapter = options.streamAdapter ?? memoryAdapter();

  return {
    run<T>(request: Request, fn: () => Promise<T>): Promise<T> {
      const key = resolveKey(request, keyFn);
      const existing = runAdapter.get(key) as Promise<T> | undefined;
      if (existing) return existing;

      const p = fn().finally(() => runAdapter.delete(key));
      runAdapter.set(key, p);
      return p;
    },

    // Deliberately NOT using `await` before the register-and-subscribe
    // step — see lazySource()'s doc comment for why that ordering matters.
    async stream<T>(
      request: Request,
      fn: () => AsyncIterable<T> | ReadableStream<T> | Promise<AsyncIterable<T> | ReadableStream<T>>,
    ): Promise<AsyncIterableIterator<T>> {
      const key = resolveKey(request, keyFn);

      const existing = streamAdapter.acquire(key) as StreamRegistryEntry | undefined;
      if (existing) {
        return existing.subscribe() as AsyncIterableIterator<T>;
      }

      const mc = new MulticastStream<T>(lazySource(fn), {
        onAbort: () => streamAdapter.release(key),
        onSettle: () => streamAdapter.release(key),
      });

      streamAdapter.register(key, {
        protocolVersion: PROTOCOL_VERSION,
        subscribe: () => mc.subscribe() as AsyncIterableIterator<unknown>,
      });

      return mc.subscribe();
    },
  };
}
