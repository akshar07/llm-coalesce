# Step 1: A shared LLM stream hook for React

**Goal:** multiple React components can ask for the same streaming LLM
completion, at the same time or a moment apart, and the provider is called
exactly once. Every component reads the same live token stream.

This is deliberately the smallest version of the problem — one app, one
bundle, plain React. No micro-frontends, no cross-tab coordination, no
result caching after the fact. Those are real extensions (more on that at
the end), but they'd get in the way of seeing the core mechanism clearly,
so Step 1 leaves them out on purpose.

---

## 1. See the bug first

Here's the hook everyone writes first:

```tsx
function useNaiveStream(key: string, fetcher: () => AsyncIterable<string>) {
  const [text, setText] = useState("");

  useEffect(() => {
    (async () => {
      let acc = "";
      for await (const chunk of fetcher()) {
        acc += chunk;
        setText(acc);
      }
    })();
  }, [key]);

  return text;
}
```

Mount two components with this hook, same `key`, at the same time:

```tsx
<ClauseExplainer clauseId="7" />
<RiskPanel clauseId="7" />
```

If both call `useNaiveStream("clause-7", () => explainClause("7"))`, both
effects run in the same commit, both call `fetcher()` independently, and
the model gets asked to explain clause 7 twice — same prompt, same
document, two bills. That's the whole problem in five lines: nothing here
knows the other component exists.

The fix has two parts: something has to notice "someone's already asking
this," and something has to let more than one reader consume a stream that
naturally only wants to be read once.

## 2. A registry that notices — but streaming breaks it

The obvious first fix is a `Map` from key to whatever's in flight:

```ts
const inFlight = new Map<string, Promise<string>>();

function runOnce(key: string, fn: () => Promise<string>) {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
```

This works — genuinely, it's the whole fix — for a function that returns
one `Promise<string>`. It does *not* work for streaming, because a
`Promise` resolves once and any number of `.then()`s can read that one
resolved value, but an `AsyncIterable` is different: once something calls
`for await` on it, it's being *consumed*, not read. A second caller
`for await`-ing the same iterable races the first for chunks, or gets
nothing, depending on the source — there's no built-in "let two things
read this" for an async generator. You need to build that.

## 3. MulticastStream: let N readers consume one stream

The idea: wrap the source, keep every chunk it produces in a buffer, and
give each subscriber its own cursor into that buffer instead of having
them all fight over reading the source directly.

```ts
interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}
function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

export class MulticastStream<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private hasError = false;
  private error: unknown;
  private refCount = 0;
  private started = false;
  private sourceIterator: AsyncIterator<T> | null = null;
  private waiter: Deferred = createDeferred();

  constructor(
    private readonly source: AsyncIterable<T>,
    private readonly opts: { onAbort?: () => void; onSettle?: () => void } = {},
  ) {}

  private ensureStarted() {
    if (this.started) return;
    this.started = true;
    this.sourceIterator = this.source[Symbol.asyncIterator]();
    void this.pump();
  }

  private wake() {
    const prev = this.waiter;
    this.waiter = createDeferred();
    prev.resolve();
  }

  private async pump() {
    try {
      const it = this.sourceIterator!;
      while (true) {
        const { value, done } = await it.next();
        if (done) { this.done = true; this.wake(); this.opts.onSettle?.(); return; }
        this.buffer.push(value);
        this.wake();
      }
    } catch (err) {
      this.hasError = true; this.error = err; this.done = true;
      this.wake(); this.opts.onSettle?.();
    }
  }

  subscribe(): AsyncIterableIterator<T> {
    this.ensureStarted();
    let index = 0, active = true;
    this.refCount++;

    const cleanup = () => {
      if (!active) return;
      active = false;
      this.refCount--;
      if (this.refCount === 0 && !this.done) {
        this.opts.onAbort?.();
        void this.sourceIterator?.return?.();
      }
    };

    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() { return iterator; },
      next: async () => {
        while (true) {
          if (index < this.buffer.length) return { value: this.buffer[index++]!, done: false };
          if (this.done) {
            cleanup();
            if (this.hasError) throw this.error;
            return { value: undefined as unknown as T, done: true };
          }
          await this.waiter.promise;
        }
      },
      return: async (value?: unknown) => { cleanup(); return { value: value as T, done: true }; },
      throw: async (err?: unknown) => { cleanup(); throw err; },
    };
    return iterator;
  }
}
```

Three things worth noticing, because they're each answering a specific
bug you'd hit without them:

- **`ensureStarted()` only fires on the first `subscribe()`.** The source
  is consumed exactly once no matter how many subscribers attach later.
- **Every subscriber has its own `index`.** A slow reader and a fast
  reader both walk the same `buffer` independently — nobody skips a
  chunk because someone else already read past it.
- **`refCount` gates the abort.** If three components are reading and one
  unmounts early, `cleanup()` decrements the count but doesn't cancel
  anything — only the *last* one leaving before `done` cancels the
  underlying source. One component's unmount must not cut off the other
  two.

## 4. The ordering bug — and the fix that makes coalescing actually work

Now wire `MulticastStream` into a `subscribe(key, fetcher)` function. The
first, natural way to write it:

```ts
// DON'T — this still has the thundering-herd bug
async function subscribe(key: string, fetcher: () => Promise<AsyncIterable<string>>) {
  const existing = registry.get(key);
  if (existing) return existing.subscribe();

  const iterable = await fetcher();               // <-- the problem
  const mc = new MulticastStream(iterable, { onSettle: () => registry.delete(key) });
  registry.set(key, mc);
  return mc.subscribe();
}
```

Call this twice, back-to-back, with the same key — exactly what happens
when two components mount in the same render. Call 1 runs synchronously
up to `await fetcher()`, then *pauses* and hands control back. Call 2
starts before call 1 has registered anything, sees an empty registry, and
also calls `fetcher()`. Two calls to the model, from code that's
specifically supposed to prevent that.

The fix is to make the fetcher lazy — wrap it so it isn't actually invoked
until something *iterates* it, which only happens once `subscribe()` has
already registered the entry:

```ts
function lazySource(fetcher: () => Promise<AsyncIterable<string>> | AsyncIterable<string>): AsyncIterable<string> {
  let initPromise: Promise<AsyncIterator<string>> | null = null;
  const init = () => {
    if (!initPromise) {
      initPromise = Promise.resolve(fetcher()).then((it) => it[Symbol.asyncIterator]());
    }
    return initPromise;
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => (await init()).next(),
        return: async (v?: unknown) => {
          const it = await init();
          return it.return ? it.return(v) : { value: v as string, done: true };
        },
      };
    },
  };
}

function subscribe(key: string, fetcher: () => Promise<AsyncIterable<string>> | AsyncIterable<string>) {
  const existing = registry.get(key);
  if (existing) return existing.subscribe();

  const mc = new MulticastStream(lazySource(fetcher), {
    onAbort: () => registry.delete(key),
    onSettle: () => registry.delete(key),
  });
  registry.set(key, mc);
  return mc.subscribe();   // <-- no await above this line
}
```

`subscribe()` is now synchronous all the way through registration. Trace
call 2 again: it runs `registry.get(key)` and finds call 1's entry
*immediately*, because call 1 never awaited anything before calling
`registry.set(key, mc)`. `fetcher()` itself only actually runs once —
inside `mc.subscribe()`'s pump loop, the first time anything asks the lazy
source for its next chunk. This one reordering is the entire fix. (I hit
this exact bug building the fuller version of this library — it's an easy
one to write by accident, because `await fetcher()` before registering
*looks* more natural.)

## 5. The React hook

```tsx
export function useLlmStream(key: string, fetcher: Fetcher): UseLlmStreamResult {
  const [state, setState] = useState<UseLlmStreamResult>({ text: "", status: "loading", error: undefined });

  // Read the latest fetcher without making it an effect dependency (see below).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setState({ text: "", status: "loading", error: undefined });

    const sub = subscribe(key, () => fetcherRef.current());
    let text = "";

    (async () => {
      try {
        for await (const chunk of sub) {
          if (cancelled) break;
          text += chunk;
          setState({ text, status: "streaming", error: undefined });
        }
        if (!cancelled) setState((s) => ({ ...s, status: "done" }));
      } catch (err) {
        if (!cancelled) setState({ text, status: "error", error: err });
      }
    })();

    return () => {
      cancelled = true;
      void sub.return?.();   // last one out triggers the real abort; others no-op
    };
  }, [key]);

  return state;
}
```

**Why `fetcher` isn't a dependency of the effect.** This is the same bug
class as the naive `useEffect(() => fetchThing(), [someNewObjectEveryRender])`
mistake — if a parent re-renders and passes a fresh (but equivalent)
closure, putting it in the deps array re-fires the effect and re-triggers
the request, which is exactly the duplicate-call problem this hook exists
to prevent. Reading it through a `ref` means a re-render never re-triggers
the subscription; only a genuine `key` change does. The trade-off: your
`fetcher` should be idempotent for a given `key` — don't close over state
that changes what it fetches without also changing `key` to match.

## 6. Proving it: the test that matters

```tsx
it("two components mounted together trigger one fetcher call and see identical text", async () => {
  const source = new ControllableSource<string>();
  const fetcher = vi.fn(() => source);

  render(
    <>
      <Consumer testId="a" streamKey="doc-1" fetcher={fetcher} />
      <Consumer testId="b" streamKey="doc-1" fetcher={fetcher} />
    </>,
  );

  await act(async () => {
    source.push("The liability ");
    source.push("clause is uncapped.");
    source.finish();
    await flush();
  });

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("a").textContent).toBe("done:The liability clause is uncapped.");
  expect(screen.getByTestId("b").textContent).toBe("done:The liability clause is uncapped.");
});
```

This is the test that would have caught the ordering bug in §4 — with the
`await fetcher()` version, `fetcher` gets called twice here, immediately,
no timing tricks required. Two components rendered in the same `render()`
call have their effects run in the same commit, which is precisely the
"two components mount in the same render pass" scenario the whole hook is
built for.

The shipped package (in the zip) also covers: a late joiner mounting
mid-stream still gets the full text via replay, an error propagating to
every subscriber, and one consumer unmounting early *not* cutting off a
sibling that's still reading — 10 tests total, all passing.

## 7. Using it

> **Update (0.3.0):** `useLlmStream` moved to its own entry point,
> `use-llm-stream/react`, so that importing the package's root —
> `subscribe`, `createSSEStream`, `MulticastStream` — never requires
> React to be installed. The hook itself, shown below, is unchanged.

```
npm install use-llm-stream
```

```tsx
import { useLlmStream } from "use-llm-stream/react";
import { streamText } from "ai";

function ClauseExplainer({ documentId, clauseId }: { documentId: string; clauseId: string }) {
  const { text, status } = useLlmStream(
    `${documentId}:${clauseId}`,
    () => streamText({ model, prompt: explainClausePrompt(clauseId) }).then(r => r.textStream),
  );
  return <p>{status === "loading" ? "Thinking…" : text}</p>;
}
```

Mount `<ClauseExplainer>` from as many independent components as you like,
for the same `documentId`/`clauseId` — the model gets asked once.

## What Step 1 deliberately leaves out

- ~~**Cross-bundle / micro-frontend coordination.**~~ Done in Step 2 — see
  `TUTORIAL-microfrontends.md` and `TUTORIAL-unifying-the-registry.md` in
  `llm-coalesce-demo`, and the README's "Coordinating across independently
  bundled microfrontends" section. Short version: this registry was one
  `Map`, shared only because everything importing this module shared the
  same bundle; independently built microfrontends each got their own
  private copy and silently stopped coalescing with each other. The fix is
  a `globalThis`-backed, namespaced registry instead of a module-scoped one
  — same algorithm, different Map location — and it's just `subscribe()`'s
  default behavior now, not a separate entry point to opt into.
- **Resolved-value reuse over time.** If component A's stream finishes and
  component B asks the same question 30 seconds later, B gets nothing from
  this — the registry entry is released the moment the stream settles.
  That's intentional for Step 1 (pure in-flight coalescing, no caching),
  but it's a one-line-sounding change (delay the release instead of firing
  it immediately) that unlocks a genuinely different, also-useful case.
- **Cross-tab coordination.** Two tabs of the same app are two separate
  `window` objects — and two separate JS realms, so even `Symbol.for`'s
  global registry (which the microfrontend fix above relies on) doesn't
  reach across them. Would need `BroadcastChannel` or a `SharedWorker`, a
  genuinely different transport, not a bigger version of the same fix.

Good candidates for "Step 3," in other words — say which one and we'll
build it the same way: bug first, then the fix, then the test that would
have caught it.
