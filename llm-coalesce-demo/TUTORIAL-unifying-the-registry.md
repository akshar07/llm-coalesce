# Tutorial: one registry, not two

> **Update:** this tutorial's fix landed inside `use-llm-stream`, a
> package that also bundled its own SSE-to-AsyncIterable adapter
> (`createSSEStream`) as part of its core exports. A later review
> objection — "don't make `createSSEStream` part of your core library;
> the caller should be able to supply any async stream" — led to
> discovering an independently-built, more complete package,
> `llm-coalesce`, that already solved this problem correctly: adapter
> objects instead of a bare `globalThis` lookup, protocol-versioned
> registry entries, exact-key hashing over arbitrary request objects (not
> just string keys), and a provider-agnostic core with zero SSE-parsing
> code in it. `use-llm-stream` was retired in favor of adopting it; see
> `TUTORIAL-provider-agnostic-core.md`. The `globalThis`-plus-`Symbol.for`
> design this file documents is still exactly how `llm-coalesce`'s own
> `windowAdapter()` works internally — the *mechanism* described below
> didn't get thrown away, it got adopted wholesale into the more complete
> package, alongside the option to swap in a different adapter entirely.

`TUTORIAL-microfrontends.md` shipped a real fix for a real problem —
independently bundled microfrontends silently failing to coalesce with
each other — but it shipped that fix as a second, parallel mechanism:
`use-llm-stream/window`, a separate entry point, with a `namespace`
argument that was *required*. The plain root `subscribe()` kept its old,
module-scoped behavior untouched. That design got reviewed, and the
review's objection was simple and correct: **there shouldn't be a separate
`use-llm-stream/window` — the same mechanism should just handle both the
single-bundle and multi-bundle cases.** This tutorial is that revision.

## Why two entry points was the wrong shape

The previous design asked every consumer to answer a question up front:
"will this code ever run split across independently built microfrontends?"
— and to pick an import based on the answer. That's a bad question to make
someone answer at `import` time, for a few reasons:

- **The answer can change after the code is written.** An app that starts
  as one bundle and later gets split into microfrontends doesn't get a
  compile error reminding it to switch imports — it just quietly coalesces
  worse than before, the exact invisible regression the whole feature
  exists to prevent.
- **The two mechanisms had no reason to behave differently in the common
  case.** A `globalThis`-backed registry works perfectly fine for two
  components in one bundle — `globalThis` is just as reachable there. The
  module-scoped registry was never *better* for that case, just
  historical. Once that's true, keeping it as a separate default isn't
  protecting anything; it's just an extra concept.
- **"Pick the right one" is exactly the kind of decision a library should
  make unnecessary when it safely can.** The same instinct that moved
  `useLlmStream` behind its own entry point earlier in this project
  doesn't apply here in reverse: that split existed because React
  *couldn't* be made optional any other way (either the code imports it or
  it doesn't). Here, nothing stops the multi-bundle-safe mechanism from
  also being correct for the single-bundle case — so unlike the React
  split, this axis doesn't need two entry points to be honest about a real
  difference. It needs one mechanism that's simply correct for both.

## The fix: `subscribe()` is always `globalThis`-backed now

`registry.ts` no longer has a plain module-scoped `Map` at all. Every call
to `subscribe()` — regardless of how many bundles are involved — goes
through the same `globalThis`-backed registry that used to live only
behind `use-llm-stream/window`:

```ts
// src/registry.ts
export const DEFAULT_NAMESPACE = "use-llm-stream/default";

export interface SubscribeOptions {
  namespace?: string;
}

function getRegistry(namespace: string) {
  const key = Symbol.for(`use-llm-stream/registry/v1/${namespace}`);
  const target = globalThis as any;
  return (target[key] ??= new Map());
}

export function subscribe(key: string, fetcher: Fetcher, options: SubscribeOptions = {}) {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  return createSubscribe(() => getRegistry(namespace))(key, fetcher);
}
```

`use-llm-stream/window` and `createWindowSubscribe()` are gone entirely —
not deprecated, removed, since nothing outside this same feature had
shipped against them yet. There is exactly one way to call this now:

```ts
import { subscribe, createSSEStream } from "use-llm-stream";

// Identical whether this line runs once (one bundle) or is duplicated
// across three independently built microfrontends on the same page.
const stream = subscribe("summarize-cart", () => createSSEStream("/api/stream?key=cart"));
```

## The one place a required argument became an optional one

The old `use-llm-stream/window` required a `namespace` on every call — no
default, because there was no safe default to fall back to; the whole
point of that entry point was explicit, deliberate sharing. Making
`subscribe()` itself always `globalThis`-backed forces a decision the old
design avoided: what does the *common* case — the overwhelming majority of
callers who are just one product, not sharing a page with anyone else's
use of this package — get by default?

The answer is `DEFAULT_NAMESPACE`, a single shared constant every
no-namespace call uses. This is a genuine, honest trade-off, not a free
lunch:

- **What it buys:** zero extra concepts for the common case.
  `subscribe(key, fetcher)` behaves exactly as it always did for one app,
  one bundle — and, new for free, exactly as it always did for one app
  split across several bundles too. Nobody has to know this registry lives
  on `globalThis` at all unless they go looking.
- **What it costs:** two *unrelated* products sharing a host page, both
  depending on this exact package, both never passing `namespace`, could
  now coincidentally coalesce if their `key`s happen to match. That was
  structurally impossible with per-bundle module scope (their separate
  bundles guaranteed separate Maps) and is now possible, if unlikely, with
  a single default global bucket.

The mitigation is the same `namespace` option the old design had, just
optional instead of required: `subscribe(key, fetcher, { namespace: "acme-checkout" })`
opts back into full isolation whenever that's a real concern — a host page
you don't control the other tenants of, say. Most consumers will never
need it; the ones who do get an explicit, one-line way to ask for it.

## What the tests had to prove, now that the claim flipped

The previous tutorial's tests proved the *default*, no-namespace
`subscribe()` did **not** coalesce across separate bundles — that was
the bug the window adapter fixed. After this change, that's no longer
true, and the tests needed to prove the opposite claim just as rigorously
as they'd proven the original one — the same "two genuinely separate
module instances" technique, pointed at the new behavior:

```ts
// test/crossBundle.test.ts
const copyA = await import("../src/registry.js?bundle=a");
const copyB = await import("../src/registry.js?bundle=b");

const subA = copyA.subscribe("shared-key", fetcher); // no namespace argument
const subB = copyB.subscribe("shared-key", fetcher);

expect(fetcher).toHaveBeenCalledTimes(1); // <- now coalesces by default
```

```ts
// an explicit namespace still isolates — from the default, and from
// other explicit namespaces
await drain(subscribe("shared-key", fetcher));                                   // default
await drain(subscribe("shared-key", fetcher, { namespace: "acme-checkout" }));    // isolated
expect(fetcher).toHaveBeenCalledTimes(2);
```

```
$ cd use-llm-stream && npm test
 ✓ test/crossBundle.test.ts (4 tests)
 ✓ test/sse.test.ts (7 tests)
 ✓ test/useLlmStream.test.tsx (3 tests)
 ✓ test/registry.test.ts (3 tests)
 ✓ test/multicast.test.ts (4 tests)
 Tests  21 passed (21)
```

And, as with the original window-adapter change, the same contrast was
re-run in real headless Chromium against the compiled output — two
`?mfe=…`-tagged module instances of `registry.js`, no namespace argument,
one real call:

```
results: {
  "defaultFetcherCalls": 1,
  "resultA": "hello from one real call",
  "resultB": "hello from one real call",
  "namespacedFetcherCalls": 2
}
uncaught page errors: []

PASS: default subscribe() (no namespace) coalesces across separate module
instances; explicit different namespaces still isolate from each other
and from the default.
```

## `useLlmStream` inherits this for free

One side effect worth calling out: the React hook (`useLlmStream`) was
never touched by the original window-adapter work — it called the plain,
module-scoped `subscribe()` directly, so React components in separately
bundled microfrontends had no cross-bundle-safe path at all. Now that
`subscribe()` itself is unconditionally `globalThis`-backed, `useLlmStream`
gets the same guarantee automatically, with one small addition — an
optional `options` parameter threaded through to `subscribe()`:

```ts
useLlmStream(key: string, fetcher: Fetcher, options?: SubscribeOptions): UseLlmStreamResult
```

No consumer has to do anything differently to get this; it's the same
"make the common path already correct" move as everything else in this
revision.

## What changed, file by file

```
use-llm-stream/src/windowAdapter.ts        REMOVED
use-llm-stream/test/windowAdapter.test.ts  REMOVED
use-llm-stream/src/registry.ts             now the ONLY registry — globalThis-backed,
                                            unconditionally, with an optional `namespace`
use-llm-stream/src/useLlmStream.ts         gained an optional `options: SubscribeOptions` param
use-llm-stream/src/index.ts                exports `DEFAULT_NAMESPACE`, `SubscribeOptions`
use-llm-stream/package.json                "./window" export removed; version bumped
use-llm-stream/test/crossBundle.test.ts    NEW — replaces windowAdapter.test.ts,
                                            proves the flipped default + namespace isolation

llm-coalesce-demo/vendor-packages/use-llm-stream-0.5.0.tgz   updated tarball
llm-coalesce-demo/package.json                               dependency path bumped to match
```

The lesson worth keeping past this specific change: shipping a fix as an
opt-in, separately-imported mechanism *feels* safe — it can't break
anyone who doesn't reach for it — but "doesn't break anyone" and "actually
solves the problem for everyone who has it" aren't the same bar. A
consumer who doesn't know to reach for the opt-in gets no error, no
warning, just the same silent under-coalescing the feature was built to
fix. When the safer behavior can be made the default without a real cost
to the common case — as it could here — that's the version worth shipping,
even if it means deleting code you wrote an hour earlier.
