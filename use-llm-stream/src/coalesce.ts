import { MulticastStream } from "./multicast.js";

export type Fetcher = () => AsyncIterable<string> | Promise<AsyncIterable<string>>;

/**
 * Wraps a fetcher so it isn't actually called until something iterates it
 * — and only ever called once, no matter how many times iteration is
 * attempted.
 *
 * This ordering is the crux of the whole thing. The `subscribe()` this
 * builds needs to check its registry and register a new entry
 * *synchronously*, before the fetcher's own async work has even started.
 * If it instead did `await fetcher()` before registering, every caller
 * mounting in the same tick would see an empty registry and all call the
 * fetcher — exactly the bug this module exists to prevent. Making the
 * fetcher lazy is what lets registration happen first and the actual
 * network/model call happen second.
 */
function lazySource(fetcher: Fetcher): AsyncIterable<string> {
  let initPromise: Promise<AsyncIterator<string>> | null = null;

  const init = (): Promise<AsyncIterator<string>> => {
    if (!initPromise) {
      initPromise = Promise.resolve(fetcher()).then((iterable) => iterable[Symbol.asyncIterator]());
    }
    return initPromise;
  };

  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next: async () => (await init()).next(),
        return: async (value?: unknown) => {
          const it = await init();
          return it.return ? it.return(value) : { value: value as string, done: true };
        },
      };
    },
  };
}

/**
 * Builds a `subscribe(key, fetcher)` function backed by whatever
 * `Map<string, MulticastStream<string>>` `getRegistry()` returns.
 *
 * The in-flight-coalescing logic itself never changes: a miss creates and
 * registers a stream, a hit attaches to the existing one, and either way
 * the entry is deleted once the stream settles or every subscriber
 * abandons it. The one thing this factory lets vary is *where the Map
 * lives* — `registry.ts` backs it with a plain module-scoped Map (one JS
 * module graph gives you one shared Map for free); `windowAdapter.ts`
 * backs it with a Map stored on `globalThis` (so multiple, independently
 * bundled copies of this package running on the same page can still find
 * and share the same Map). Everything else about coalescing is identical
 * either way — this is the one axis that's supposed to differ.
 */
export function createSubscribe(
  getRegistry: () => Map<string, MulticastStream<string>>,
): (key: string, fetcher: Fetcher) => AsyncIterableIterator<string> {
  return function subscribe(key: string, fetcher: Fetcher): AsyncIterableIterator<string> {
    const registry = getRegistry();
    const existing = registry.get(key);
    if (existing) {
      return existing.subscribe();
    }

    const stream = new MulticastStream<string>(lazySource(fetcher), {
      onAbort: () => registry.delete(key),
      onSettle: () => registry.delete(key),
    });
    registry.set(key, stream);
    return stream.subscribe();
  };
}
