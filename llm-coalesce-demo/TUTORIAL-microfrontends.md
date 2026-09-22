# Tutorial: coordinating microfrontends, not just components

> **Update:** this tutorial shipped the fix as a separate, opt-in entry
> point — `use-llm-stream/window`, with a *required* `namespace` argument
> — living alongside the original `subscribe()`. That was reconsidered
> almost immediately: it made the consumer responsible for predicting,
> at import time, whether their app would ever be split into
> microfrontends, and silently kept coalescing worse than it needed to be
> for anyone who guessed wrong or whose architecture changed later. The
> two entry points were collapsed into one in
> `TUTORIAL-unifying-the-registry.md` — `subscribe()` is now
> unconditionally `globalThis`-backed, with `namespace` as an *optional*
> parameter rather than a different import. The diagnosis in *this* file
> (why module scope can't bridge separate bundles) still holds completely;
> only the shape of the fix changed.

Every earlier step assumed one thing without saying so: everyone calling
`subscribe()` for the same key lives inside the same JS bundle. Two React
components mounting the same hook, or two plain callers importing
`use-llm-stream` from the same app — either way, "same bundle" was never
in question, so the module-scoped registry Map in `registry.ts` was
automatically shared. That assumption is exactly what breaks once the
callers are independently bundled microfrontends sharing one page.

## 1. The problem `registry.ts` can't see

A JS module is a singleton *within one module graph* — not within one
page. Two components in the same bundle importing `"use-llm-stream"` are
both getting the one evaluated copy of `registry.ts` that bundle produced,
so they share its `Map` for free. Two independently built microfrontends
each run their *own* build of `use-llm-stream` — their own webpack, vite,
or esbuild pass, with no module federation or shared import map tying
them together. Each one evaluates its own private copy of `registry.ts`,
with its own private `Map`, even though the source is byte-for-byte
identical.

Nothing about this throws or warns. Each microfrontend's own internal
calls still coalesce correctly — a reviewer reading any one microfrontend
in isolation sees perfectly correct code. It's only at the seam *between*
microfrontends that the guarantee silently stops holding: three
microfrontends all asking for the same `key` on page load produce three
real calls to the model, not one, because each one's registry genuinely
believes it's the first and only caller. This is the kind of regression
that's invisible in code review and only shows up as an unexplained spike
in provider calls in production.

## 2. The fix: share the one thing that has to be shared

The whole coalescing algorithm — `MulticastStream`, the lazy fetcher, the
delete-on-settle registry entry — doesn't need to change at all. The only
thing that needs to stop being module-scoped is the `Map` itself. So
`registry.ts`'s miss/hit logic was pulled out into a reusable factory:

```ts
// src/coalesce.ts
export function createSubscribe(
  getRegistry: () => Map<string, MulticastStream<string>>,
): (key: string, fetcher: Fetcher) => AsyncIterableIterator<string> {
  return function subscribe(key, fetcher) {
    const registry = getRegistry();
    const existing = registry.get(key);
    if (existing) return existing.subscribe();

    const stream = new MulticastStream(lazySource(fetcher), {
      onAbort: () => registry.delete(key),
      onSettle: () => registry.delete(key),
    });
    registry.set(key, stream);
    return stream.subscribe();
  };
}
```

`registry.ts`'s `subscribe` is now just `createSubscribe(() => registry)`
against its usual module-scoped Map — completely unchanged behavior. The
new `use-llm-stream/window` entry point calls the same factory, but backs
it with a Map that lives on `globalThis` instead:

```ts
// src/windowAdapter.ts
function getWindowRegistry(namespace: string) {
  const key = Symbol.for(`use-llm-stream/window-registry/v1/${namespace}`);
  const target = globalThis as any;
  return (target[key] ??= new Map());
}

export function createWindowSubscribe(namespace: string) {
  return createSubscribe(() => getWindowRegistry(namespace));
}
```

`globalThis`, unlike module scope, really is one shared object for every
script running in the same page — no matter how many separate bundles put
code there. Every independently built microfrontend that imports
`use-llm-stream/window` runs this same lookup and finds (or creates) the
identical Map.

**Why `Symbol.for()` and not a plain string property.** `globalThis.foo =
...` risks colliding with anything else on the page using that name —
another library, an analytics snippet, a future version of this one.
`Symbol.for(key)` reads from the JS engine's own global symbol registry:
every call with the same string returns the identical Symbol, from any
script in the realm, and — because it isn't enumerable through
`Object.keys`/`for...in` — nothing that isn't deliberately calling
`Symbol.for()` with this exact string can stumble into it by accident.
The `v1` segment means a future breaking change to this module's internal
contract just becomes a new key: old and new versions on the same page
fail to find each other and each fall back to coalescing only within
their own bundle — a worse-coalescing but still-correct degradation,
never a corrupted shared Map.

**Why the `namespace` argument is required, not optional.**
`globalThis` is shared by *everything* on the page, not only the
microfrontends that are supposed to coalesce with each other. If some
unrelated widget on the same page also happens to use `use-llm-stream`
and happens to pick the key `"summary"`, you don't want it silently
sharing your app's own `"summary"` request — that's the exact
false-positive-match failure a coalescing engine can't afford (the same
principle behind exact-key matching itself: a missed match just costs
duplicate work, a wrong match silently returns the wrong data).
`createWindowSubscribe(namespace)` folds that string into the Symbol
itself, so two apps that never agreed to share never do, even on an
identical key.

## 3. What isn't shared, and why that's fine

Each microfrontend's bundle still has its own copy of the `MulticastStream`
*class* — only instances of it end up in the shared Map, never the class
definition. Calling `.subscribe()` on an instance created by a different
bundle's copy of the class works exactly like calling any method on any
JS object: dispatch follows the object's own prototype chain, not whoever
happens to be calling it. The one real consequence: whichever bundle's
call wins the race and actually creates an entry is the version of this
package whose code governs that entry for its whole lifetime; a bundle
attaching to it later just rides along. Keeping every microfrontend that
shares a namespace on the same major version of this package is the same
discipline you'd already apply to a shared React instance in a
microfrontend platform — this isn't a new category of problem, just this
package's version of one you likely already manage.

## 4. Proving it, not just arguing it: real module isolation in tests

Asserting "these are separate bundles" isn't enough — the tests reproduce
the actual mechanism that causes the bug. Vite (which `vitest` runs on)
treats a distinct query string as a distinct module: importing the same
file as `?bundle=a` and `?bundle=b` re-evaluates it twice, with two
separate top-level Maps, exactly like two separate builds would produce.

```ts
// test/windowAdapter.test.ts
const copyA = await import("../src/registry.js?bundle=a");
const copyB = await import("../src/registry.js?bundle=b");

const subA = copyA.subscribe("shared-key", fetcher);
const subB = copyB.subscribe("shared-key", fetcher);

expect(fetcher).toHaveBeenCalledTimes(2); // <- the bug, reproduced honestly
```

```ts
const copyA = await import("../src/windowAdapter.js?bundle=a");
const copyB = await import("../src/windowAdapter.js?bundle=b");

const subscribeA = copyA.createWindowSubscribe("demo-app");
const subscribeB = copyB.createWindowSubscribe("demo-app");

const subA = subscribeA("shared-key", fetcher);
const subB = subscribeB("shared-key", fetcher);

expect(fetcher).toHaveBeenCalledTimes(1); // <- fixed, same test shape
```

```
$ cd use-llm-stream && npm test
 ✓ test/windowAdapter.test.ts (4 tests)
 ✓ test/sse.test.ts (7 tests)
 ✓ test/useLlmStream.test.tsx (3 tests)
 ✓ test/registry.test.ts (3 tests)
 ✓ test/multicast.test.ts (4 tests)
 Tests  21 passed (21)
```

The fourth window-adapter test confirms the collision guard: two
different namespaces, identical key, never coalesce — proving the
`namespace` argument actually does what section 2 claims, not just that
it's accepted.

## 5. Verifying it in an actual browser, not just Node's module loader

Vite's query-string trick is a legitimate simulation of separate builds,
but it's still one JS tool's module loader. Real browsers implement ES
module resolution independently, so the same technique was re-run against
the actual compiled output in headless Chromium — two `<script
type="module">` imports of the identical `windowAdapter.js` file under
different query strings, standing in for two microfrontends that each
shipped their own copy:

```js
const mfeA = await import("/windowAdapter.js?mfe=checkout");
const mfeB = await import("/windowAdapter.js?mfe=recommendations");

const subscribeA = mfeA.createWindowSubscribe("acme-shell");
const subscribeB = mfeB.createWindowSubscribe("acme-shell");
// ...one real call, both callers get the full output.

// Contrast, loaded the identical way:
const rootA = await import("/registry.js?mfe=checkout");
const rootB = await import("/registry.js?mfe=recommendations");
// ...the plain, non-window-backed subscribe() — two real calls.
```

```
results: {
  "fetcherCalls": 1,
  "resultA": "hello from one real call",
  "resultB": "hello from one real call",
  "rootFetcherCalls": 2
}
uncaught page errors: []

PASS: window adapter coalesces to 1 real call across separate module
instances; plain root subscribe() (no globalThis bridge) genuinely does
not — 2 calls.
```

That last line is the point of running this in a real browser rather than
trusting the design doc: it's an empirical, side-by-side contrast — same
page, same two "bundles," one mechanism that bridges them and one that
doesn't — not an assumption about how `globalThis` and `Symbol.for`
behave.

## What's still out of scope

Cross-*tab* coordination is a different problem this doesn't solve:
`globalThis` is one object per tab, so two tabs of the same app each get
their own — `Symbol.for`'s global registry is scoped to the realm, and a
browser tab is its own realm. Sharing coalescing across tabs would need a
different transport entirely (`BroadcastChannel` or a `SharedWorker`), not
a bigger `Symbol.for` key. Resolved-value reuse after a stream has already
finished (a short-lived result cache, as opposed to pure in-flight
coalescing) is also still explicitly out of scope — see the README's
"Scope" section.

## What changed, file by file

```
use-llm-stream/src/coalesce.ts        NEW — the miss/hit logic, factored out of registry.ts
use-llm-stream/src/registry.ts        now built on createSubscribe(); same behavior, same Map
use-llm-stream/src/windowAdapter.ts   NEW — createWindowSubscribe(namespace), the "./window" entry
use-llm-stream/package.json           "exports" gained "./window"; version bumped (additive, not breaking)
use-llm-stream/test/windowAdapter.test.ts   NEW — 4 tests, using real separate module instances

llm-coalesce-demo/vendor-packages/use-llm-stream-0.4.0.tgz   updated tarball
llm-coalesce-demo/package.json        dependency path bumped to match
```

`subscribe`, `createSSEStream`, and `MulticastStream` at the root are
untouched — this was additive the same way the React split was: a new,
separately opt-in entry point for a concern most consumers will never
need, rather than a behavior change to the one most consumers already
depend on.
