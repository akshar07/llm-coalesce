# Tutorial: a provider-agnostic core, and the package that already had one

Every tutorial up to this point improved `use-llm-stream` from the inside:
better scoping, then a window adapter, then unifying that adapter into the
default path. This one is different in kind. The review comment that
started it wasn't about a bug or an edge case — it was about what the
package should be responsible for at all:

> don't make `createSSEStream` part of your core library. This is the
> biggest change I'd recommend. Your package should ideally be:
>
> ```js
> import { createCoalescer } from "llm-coalesce";
> ```
>
> and the caller supplies any async stream:
>
> ```js
> const coalescer = createCoalescer();
> const stream = coalescer.stream("summarize-cart", () => myLLMStream());
> ```
>
> Then `myLLMStream()` could come from: Vercel AI SDK, OpenAI, Anthropic,
> raw `fetch`, SSE, your own backend. That keeps `llm-coalesce`
> provider-agnostic. `createSSEStream()` could be a separate
> helper/example, not a core dependency.

## 1. Why this is a real design flaw, not a style preference

`use-llm-stream`'s root export bundled two genuinely separate concerns
into one package: the coalescing algorithm (`MulticastStream`, the
registry, the lazy-fetch ordering), and one specific opinion about how
bytes become tokens (Server-Sent Events, parsed by hand, with this
project's own `done`/`error`/`meta` event names). Nothing about
coalescing *needs* SSE. The algorithm only needs an `AsyncIterable` — it
doesn't care whether the tokens inside it came from an `EventSource`, a
`ReadableStream` returned by the Vercel AI SDK, an async generator
wrapping the OpenAI or Anthropic Node SDKs, or a raw WebSocket. Shipping
`createSSEStream` as a core export quietly told every consumer "this
library assumes you're talking SSE," which is false — it's this *demo's*
assumption, not the algorithm's.

The cost of that false assumption compounds over time in a specific way:
every future consumer who *isn't* using SSE either carries a dependency
they don't need, or forks the transport logic out — at which point the
package has stopped being provider-agnostic in practice, whatever its
docs claim. Fixing this isn't cosmetic; it's the difference between a
library that works with "any LLM client" and one that works with "any LLM
client, as long as it happens to speak SSE the way we guessed."

## 2. A discovery, not just a rewrite

Implementing this fix meant restructuring `use-llm-stream`'s root export:
move `createSSEStream` out, expose something like `createCoalescer()`
returning `{ run, stream }`, and make `stream()` take a plain thunk. While
doing that groundwork — renaming a working directory to make room for the
new shape — an existing, independently-built package surfaced in this
same workspace: `llm-coalesce`, at `v0.1.0`, already solving exactly this
problem, and solving several adjacent ones `use-llm-stream` had not yet
addressed at all:

```ts
// llm-coalesce/src/index.ts
export { memoryAdapter, memoryRunAdapter, windowAdapter } from "./adapters.js";
export type { RunAdapter, StreamAdapter, StreamRegistryEntry } from "./adapters.js";
export { createCoalescer } from "./coalescer.js";
export type { Coalescer, CoalescerOptions, Request } from "./coalescer.js";
export { stableHash, stableStringify } from "./key.js";
export { MulticastStream } from "./multicast.js";
export type { MulticastOptions } from "./multicast.js";
export { PROTOCOL_VERSION } from "./protocol.js";
export { toAsyncIterable } from "./stream-utils.js";
```

No `createSSEStream` anywhere in it. Its own README opens with almost the
exact shape from the review comment:

```ts
const coalescer = createCoalescer();
const stream = await coalescer.stream("summarize-cart", () => myLLMStream());
```

Rather than build a second, less mature version of the same idea, the
honest move was to stop, verify what already existed, and ask before
picking a direction — this is a decision with real cost either way (two
parallel implementations of the same portfolio concept is worse than
either implementation alone), and it's exactly the kind of fork a
reviewer, not an author working alone, should weigh in on.

## 3. What made `llm-coalesce` the better foundation, concretely

Before recommending anything, its claims were checked against its own
test suite, not just its README:

```
$ cd llm-coalesce && npm install && npm run typecheck && npm test
...
 ✓ test/multicast.test.ts (10 tests)
 ✓ test/coalescer.stream.test.ts (4 tests)
 ✓ test/adapters.window.test.ts (4 tests)
 ✓ test/coalescer.run.test.ts (5 tests)
 ✓ test/integration.test.ts (2 tests)
 ✓ test/multicast.property.test.ts (1 test)
 ✓ test/key.test.ts (5 tests)
 Test Files  7 passed (7)
      Tests  31 passed (31)
```

Beyond the provider-agnostic core the review asked for, three design
choices made `llm-coalesce` a stronger base than a from-scratch rewrite
of `use-llm-stream` would have been:

**Adapters instead of a hardcoded registry shape.** `use-llm-stream` had
exactly two registry strategies wired directly into `registry.ts`: module
scope, or `globalThis`. `llm-coalesce` factors this into a `RunAdapter` /
`StreamAdapter` interface (`get`/`set`/`delete` and
`acquire`/`register`/`release`), with `memoryAdapter()` and
`windowAdapter()` as two implementations of it. Anyone needing a third —
`BroadcastChannel` for cross-tab, Redis for cross-process — implements the
same four-method interface without touching the coalescing algorithm at
all.

**Requests, not just string keys.** `use-llm-stream`'s `subscribe(key,
fetcher)` only ever took a string. `llm-coalesce`'s `Request = string |
Record<string, unknown>` lets a caller pass the actual parameters of a
call — `coalescer.stream({ prompt, maxTokens }, fn)` — and get a
deterministic key via `stableHash`, a sorted-key JSON serialization so
`{a, b}` and `{b, a}` collide on purpose while `{maxTokens: 500}` and
`{maxTokens: 800}` do **not** (ADR 0002, "exact-key coalescing by
default"). That's a real feature this project's own hand-picked demo key
(`"clause-7"`, a bare string) never needed to prove, but any real
consumer with more than one parameter would.

**Protocol-versioned, duck-typed cross-bundle entries.** `use-llm-stream`
put live `MulticastStream` instances directly into the `globalThis` map.
`llm-coalesce` stores plain objects — `{ protocolVersion, subscribe }` —
and checks `protocolVersion` on every `acquire()` (ADR 0001). Two
independently bundled copies of a class are never `instanceof`-compatible
across a bundle boundary even with identical source, so storing class
instances directly was already a latent fragility in the older design; a
duck-typed, versioned shape survives that boundary safely, and a mismatch
just means "fail open, coalesce less" rather than a crash.

## 4. The decision

Given a working, better-designed package already solving the same
problem, the options were: keep evolving `use-llm-stream` toward parity
(duplicating work already done, worse), maintain both in parallel
(confusing, no clear "real" package for this portfolio), or adopt
`llm-coalesce` as the project going forward and treat `use-llm-stream` as
a superseded, historical step — its own tutorials still valid records of
the problems they solved, just no longer the live implementation. That
last option was chosen. `use-llm-stream`'s source tree is left on disk
untouched, not deleted — the mechanism it documents (module scope
breaking across bundles, the `globalThis`/`Symbol.for` fix, unifying two
entry points into one) is real and worth keeping as a record, even though
`llm-coalesce` is what this demo depends on now.

## 5. What actually had to change in this demo

**The call site becomes async.** `use-llm-stream`'s `subscribe()` returned
an iterator synchronously. `llm-coalesce`'s `coalescer.stream()` returns
`Promise<AsyncIterableIterator<T>>`, because the package can no longer
assume its thunk returns a plain synchronous value — it might return an
`AsyncIterable`, a `ReadableStream`, or a `Promise` of either. That
`await` does **not** weaken the coalescing guarantee, because
registration still happens synchronously *inside* `stream()`, before the
thunk is ever invoked:

```ts
// llm-coalesce/src/coalescer.ts — no `await` before register-and-subscribe
async stream<T>(request, fn) {
  const key = resolveKey(request, keyFn);
  const existing = streamAdapter.acquire(key);
  if (existing) return existing.subscribe();

  const mc = new MulticastStream(lazySource(fn), {
    onAbort: () => streamAdapter.release(key),
    onSettle: () => streamAdapter.release(key),
  });
  streamAdapter.register(key, { protocolVersion: PROTOCOL_VERSION, subscribe: () => mc.subscribe() });
  return mc.subscribe();
}
```

`stream()` is declared `async` but contains no internal `await` at all —
calling it runs synchronously through registration, and only wraps the
*return value* in a resolved promise. Two callers whose code happens to
run in the same synchronous tick (the exact "N widgets mount at once"
scenario this whole project exists to fix) still race through
registration in program order, not event-loop order: the first one to
call `coalescer.stream()` registers before yielding control back, so a
second caller — even one queued in a separate `setTimeout(fn, 0)` — finds
the existing entry rather than a race.

```js
// public/app.js — before
const iterator = subscribe(KEY, () => createSSEStream(url));

// public/app.js — after
const iterator = await coalescer.stream(KEY, () => createSSEStream(url));
```

**SSE parsing moves into this demo, verbatim.** `public/sse.js` is a
straight port of the old `createSSEStream` — same frame-reassembly logic,
same `done`/`error`/`meta` event names, same refcounted-cancel behavior —
now living as a file this *demo* owns, imported by relative path
(`./sse.js`), not resolved through the package's import map:

```js
// public/app.js
import { createCoalescer } from "llm-coalesce";
import { createSSEStream } from "./sse.js"; // this demo's own file — not exported by llm-coalesce
```

It's written to run unmodified in both the browser (`public/app.js`) and
Node 18+ (`test/integration.test.js`), since both only need `fetch`,
`ReadableStream`, and `TextDecoder` — no environment-specific branching
needed.

**The import map and static route swap package names.**

```html
<!-- public/index.html -->
<script type="importmap">
{ "imports": { "llm-coalesce": "/vendor/llm-coalesce/index.js" } }
</script>
```

```js
// src/server.js
app.use("/vendor/llm-coalesce", express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")));
```

`sse.js` needs no entry in either place — it's already a plain file under
`public/`, served the same way `styles.css` is.

**The dependency itself.** `npm pack` inside `llm-coalesce` produces
`llm-coalesce-0.1.0.tgz`, replacing `use-llm-stream-0.5.0.tgz` in
`vendor-packages/`, and `package.json` points at it the same way as
before — a real npm dependency on a real tarball, not a sibling checkout:

```json
"dependencies": {
  "llm-coalesce": "file:./vendor-packages/llm-coalesce-0.1.0.tgz"
}
```

## 6. Verifying the switch, the same way every prior change was verified

**Both packages' own test suites, run fresh.**

```
$ cd llm-coalesce && npm test
 Test Files  7 passed (7)
      Tests  31 passed (31)

$ cd llm-coalesce-demo && npm test
ok 1 - naive: N independent createSSEStream() calls each hit the server
ok 2 - coalesced: N coalescer.stream()+createSSEStream() calls hit the server exactly once
ok 3 - a widget arriving after the stream settles gets a fresh call, on purpose
# pass 3
# fail 0
```

**A real, headless-Chromium run of the actual page**, not just the
integration tests — clicking "Run demo" with 3 widgets and reading the
server's own stat counters back out of the DOM:

```
stats: {"naiveCalls":"3","coalescedCalls":"1","naiveTokens":"72","coalescedTokens":"24"}
coalesced texts identical: true
page (JS) errors: []
PASS
```

**The late-widget scenario, also in a real browser** — stagger on, 2
widgets, wait for both sides to settle, then mount a third widget after
completion. `llm-coalesce` deliberately does not cache settled streams
(see its README's "Non-goals" and ADR 0003), so the correct behavior is a
*fresh* call on both sides, not a rejoin to a dead entry:

```
before late widget: {"naiveCalls":"2","coalescedCalls":"1"}
after late widget:  {"naiveCalls":"3","coalescedCalls":"2"}
PASS
```

**A clean-room decoupling check**, the same discipline
`TUTORIAL-decoupling-and-framework-agnostic.md` established: the entire
`llm-coalesce` source directory was moved out of reach on disk, and this
demo's `npm install && npm test` was re-run from a copy with only the
committed tarball in `vendor-packages/` — no sibling checkout anywhere
the filesystem could see:

```
$ mv llm-coalesce llm-coalesce-SOURCE-HIDDEN
$ cd llm-coalesce-demo-copy && npm install && npm test
# pass 3
# fail 0
```

All three passed with the source tree completely absent, confirming the
dependency is a real, self-contained package install — not something
that happens to work only because a source checkout is sitting nearby.

## 7. What changed, file by file

```
llm-coalesce/                                  PRE-EXISTING, now the active package (v0.1.0)
use-llm-stream/                                UNCHANGED, left on disk — superseded, not deleted

llm-coalesce-demo/public/sse.js                NEW — this demo's own SSE-to-AsyncIterable helper
llm-coalesce-demo/public/app.js                imports createCoalescer + ./sse.js; coalesced
                                                branch is now `await coalescer.stream(...)`
llm-coalesce-demo/public/index.html            import map now maps "llm-coalesce"; copy updated
llm-coalesce-demo/src/server.js                static route now serves node_modules/llm-coalesce/dist
llm-coalesce-demo/test/integration.test.js     imports createCoalescer + ../public/sse.js;
                                                coalesced call sites now `await coalescer.stream(...)`
llm-coalesce-demo/package.json                 dependency swapped to the llm-coalesce tarball; 0.7.0
llm-coalesce-demo/vendor-packages/*.tgz        llm-coalesce-0.1.0.tgz replaces use-llm-stream-0.5.0.tgz
llm-coalesce-demo/README.md                    current-state sections updated to llm-coalesce
llm-coalesce-demo/TUTORIAL-unifying-the-registry.md   gained an Update note pointing here
```

## The lesson worth keeping

The review comment that started this wasn't "your code has a bug" — it
was "your package is doing something it shouldn't be responsible for."
That's a different, and in some ways harder, kind of feedback to act on
well: nothing was broken, so there was no failing test pointing at the
fix. The response wasn't just "narrow the scope" — it was checking
whether that scope-narrowing had already been done, more rigorously,
somewhere else in reach, and being honest about that before writing a
line of new code. A library that does one thing and lets its caller
supply everything else — the transport, the wire format, the provider —
is more valuable specifically *because* of what it refuses to own; adding
`createSSEStream` back in "for convenience" would undo the exact property
this whole change was for.
