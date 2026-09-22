# Tutorial: turning a duplicated implementation into a real dependency

The previous tutorial (`TUTORIAL.md`) ended with this demo containing its
own copy of the coalescing engine — `MulticastStream`, the registry, and
a hand-rolled `fetch()`-to-SSE bridge — living in `public/registry.js`
and `public/app.js`. It worked, and it was even tested. It was still the
wrong end state, for a reason that's easy to miss because nothing about
it looks broken: **a demo that reimplements the library it's supposed to
be demonstrating can quietly drift from that library forever.** Fix a bug
in `use-llm-stream`, and the demo doesn't get the fix unless someone
remembers to port it over by hand a second time. That's not a
coalescing bug — it's a packaging bug, and it's the subject of this
tutorial.

The goal: move the network bridge into `use-llm-stream` itself, and make
this demo an actual *consumer* of the published package — `npm install`,
real imports, no copy-pasted source.

> **Update:** this tutorial's `npm install` was still only half a real
> consumer relationship — it depended on `use-llm-stream` via
> `"file:../use-llm-stream"`, a live link to that package's *source*
> directory, requiring both projects checked out as siblings and built in
> a specific order, and got the package into the browser via a small
> esbuild step (`vendor-entry.js` / `npm run build:vendor`). Both of
> those were tightened further — the demo now depends on a packed
> tarball and needs no bundler at all — in
> `TUTORIAL-decoupling-and-framework-agnostic.md`. The lesson in *this*
> file (don't duplicate a library you're supposed to be demonstrating)
> still holds; the *mechanics* of depending on it cleanly went one step
> further after this was written.

## 1. Deciding what belongs in the library

Not everything in `registry.js`/`app.js` deserved to move. The rule that
sorted it: **does this code depend on what a specific demo looks like, or
only on the shape of a network response?**

- `MulticastStream` and `subscribe()` were already in the library —
  correctly so, they're the actual algorithm.
- The `fetch()`-to-async-iterator SSE bridge only cared about HTTP and
  Server-Sent Events, nothing demo-specific. That's a library concern —
  it moved. This became `use-llm-stream`'s new `createSSEStream()`.
- The per-widget logging (`log("coalesced", "provider call #2 started")`)
  and the naive-vs-coalesced UI orchestration are entirely about *this
  demo's* presentation. Those stayed in `app.js`, exactly where they
  belong — a library that grew a logging callback just to satisfy one
  demo's UI would be scope creep, not a feature.

This is the same judgment call as Step 1's "what to leave out" section,
just applied to a different axis: instead of "what feature is out of
scope," it's "which file should this code live in."

## 2. Making the bridge configurable, not demo-specific

`registry.js`'s old `fetchTokenStream()` hardcoded this demo's exact
contract: a `done` event, an `error` event shaped `{message}`, a `meta`
event to skip, and `{token}` JSON payloads. A published library can't
assume every server it'll ever talk to agrees with one demo's naming, so
`use-llm-stream/src/sse.ts` turns each of those into an option with that
same default:

```ts
export interface CreateSSEStreamOptions {
  init?: RequestInit;
  doneEvents?: string[];       // default: ["done"]
  errorEvents?: string[];      // default: ["error"]
  skipEvents?: string[];       // default: ["meta"]
  parseToken?: (data: string, event: string | null) => string; // default: JSON `.token`, else raw
}
```

A server that streams OpenAI-shaped `{"delta": "..."}` chunks under a
`chunk` event, ending on `complete`, now just calls:

```ts
createSSEStream(url, {
  doneEvents: ["complete"],
  parseToken: (data) => JSON.parse(data).delta,
});
```

— no fork, no rewrite. The defaults exist so *this* demo's call site
needs zero options at all; the parameters exist so the next consumer's
server doesn't have to look like this one's.

## 3. The part that actually breaks if you get it wrong: `react` as optional

`use-llm-stream`'s `package.json` still lists `react` as a peer
dependency — `useLlmStream()` genuinely needs it. But this demo has no
React anywhere, and `subscribe()`/`createSSEStream()` don't touch it
either. Without a change, `npm install use-llm-stream` in a React-less
project would still try to satisfy that peer dependency (npm 7+
auto-installs peer deps by default), pulling React into a project that
will never call a single React API. The fix is one field:

```json
"peerDependenciesMeta": {
  "react": { "optional": true }
}
```

This tells npm the peer dependency is a *when-you-need-it*, not a
*whenever-you-install-this*. It's a small line, but it's the difference
between "a React hook library" and "a coalescing engine that happens to
also ship a React hook" — and this demo only makes sense if the second
description is true.

## 4. Getting the real package into a page with no bundler

`public/app.js` is a plain `<script type="module">` — intentionally, so
the demo stays copy-and-run simple. But a browser can't resolve a bare
specifier like `import { subscribe } from "use-llm-stream"` without an
import map or a bundler; that resolution is a Node/npm convention, not a
browser one. So a small, one-time build step bridges the gap:

```js
// vendor-entry.js — the ONLY file that imports the bare package specifier
export { subscribe, createSSEStream } from "use-llm-stream";
```

```json
"scripts": {
  "build:vendor": "esbuild vendor-entry.js --bundle --format=esm --external:react --external:react-dom --outfile=public/vendor/use-llm-stream.js",
  "postinstall": "npm run build:vendor"
}
```

Two details worth understanding rather than copying blindly:

**Why `--external:react` even though nothing here imports `useLlmStream`
(the one export that needs React).** `use-llm-stream`'s package root
(`index.ts`) statically exports `useLlmStream` alongside `subscribe` and
`createSSEStream`. A bundler doing dead-code elimination *should* notice
this build's entry point never references `useLlmStream` and drop that
whole module — including its `import "react"` — before ever trying to
resolve `react`. `sideEffects: false` in the package's `package.json` is
what makes that elimination legal for a bundler to perform. Marking
`react` external is the belt-and-suspenders version: even if tree-shaking
ever failed to eliminate that branch (a different bundler, a
misconfiguration, a future refactor that isn't as clean), the build
wouldn't hard-fail trying to resolve a package that isn't installed — it
would just leave an unresolved `import` statement for a code path that,
in practice, is never reached. Belt and suspenders is cheap here; a build
failing three months from now because someone reordered an export
wouldn't be.

**How to actually verify the elimination worked, instead of assuming
it.** After running the build:

```
grep -n "react" public/vendor/use-llm-stream.js
```

returns nothing. That's not a guess about how bundlers behave in
general — it's a direct check on this specific output. The bundle itself
is also small enough to sanity-check by eye (6.4kb): it's `MulticastStream`,
the registry, and the SSE parser, nothing else.

**Why `postinstall` runs it automatically.** Anyone who clones this repo
and runs `npm install` gets a working `public/vendor/use-llm-stream.js`
without needing to know a separate build step exists. The tradeoff:
`use-llm-stream` itself has to already be built (its own `dist/`
populated) before this runs, since the vendor build bundles compiled
output, not TypeScript source — see the README's install order.

## 5. Wiring the real thing into the demo

Before, the coalesced branch called a locally-defined `registry.subscribe`
with a third, demo-only `onFirstCall` argument grafted onto the local
copy's API. After the move, there's no local copy to graft onto — so the
question becomes: how do you get the same "log exactly once per real
call" behavior using only the package's actual, public `subscribe(key,
fetcher)` signature?

```js
// public/app.js
import { subscribe, createSSEStream } from "./vendor/use-llm-stream.js";

iterator = subscribe(KEY, () => {
  coalescedCallSeq += 1;
  log("coalesced", "provider call #" + coalescedCallSeq + " started (shared)", true);
  return createSSEStream(url);
});
```

The counting and logging move *inside the closure passed to `subscribe`*,
rather than needing a callback parameter from the library. This works for
exactly the same reason `createSSEStream` itself only ever gets called
once per overlapping group: `subscribe()`'s lazy registration defers
invoking the whole closure — logging included — until the first
subscriber's pump actually starts pulling, and it's simply never invoked
again for joiners. The library didn't need a bigger API; the call site
needed to trust the laziness guarantee it was already getting for free.
This is generally the right instinct when a consumer wants "do X exactly
once per shared call": reach for the fetcher closure before reaching for
a new library parameter.

## 6. Testing the algorithm where it's defined, the wiring where it's used

Before this change, this demo had its own unit test
(`test/registry.test.js`) re-proving the coalescing algorithm against a
local copy of it. After the change, that test is gone — not weakened,
*redundant*: `use-llm-stream`'s own suite already proves the algorithm
(now 17 tests, including 7 new ones for `createSSEStream` against mocked
`fetch()` responses built from real `ReadableStream`s).

What replaced it answers a question `use-llm-stream`'s tests structurally
*can't* answer, because they don't know this demo exists:

```js
// test/integration.test.js — spawns the real server, uses the real package
import { subscribe, createSSEStream } from "use-llm-stream"; // from node_modules, not a mock

test.before(async () => {
  child = spawn(process.execPath, ["src/server.js"], { env: { ...process.env, PORT: String(PORT) } });
  await waitForServer();
});

test("coalesced: N subscribe()+createSSEStream() calls hit the server exactly once", async () => {
  const urls = [0, 1, 2].map((i) => `${BASE}/api/stream?mode=coalesced&key=itest&widget=c${i}`);
  const iterators = urls.map((u) => subscribe("itest", () => createSSEStream(u)));
  const texts = await Promise.all(iterators.map(drain));

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  assert.equal(stats.coalescedCalls, 1);
});
```

Running both suites in sequence is the actual proof this refactor
succeeded:

```
$ cd use-llm-stream && npm test
 ✓ test/sse.test.ts (7 tests)
 ✓ test/useLlmStream.test.tsx (3 tests)
 ✓ test/registry.test.ts (3 tests)
 ✓ test/multicast.test.ts (4 tests)
 Tests  17 passed (17)

$ cd ../llm-coalesce-demo && npm test
ok 1 - naive: N independent createSSEStream() calls each hit the server
ok 2 - coalesced: N subscribe()+createSSEStream() calls hit the server exactly once
ok 3 - a widget arriving after the stream settles gets a fresh call, on purpose
```

The general shape worth keeping: **a library's own suite proves its
algorithm is correct in isolation; a consumer's suite proves that
*this specific integration*, wired up the way this project actually
wires it, produces the behavior the UI claims.** Neither one substitutes
for the other, and duplicating the first inside the second (which is what
the old `test/registry.test.js` was doing) doesn't add coverage — it adds
a second copy of the same assertions that has to be kept in sync by hand.

## 7. Running it

```
cd use-llm-stream && npm install && npm run build
cd ../llm-coalesce-demo && npm install   # also runs build:vendor via postinstall
npm start
```

The two directories need to be siblings, because the dependency is a
relative path: `"use-llm-stream": "file:../use-llm-stream"` in
`llm-coalesce-demo/package.json`. That's a reasonable stand-in for what
would normally be a version number pointing at a published npm package —
the point being demonstrated is the *dependency relationship*, not the
registry mechanics of actually publishing one.

## What this bought, concretely

Before: fixing a bug in `MulticastStream` meant remembering to also fix
`public/registry.js`'s copy, or the demo would silently keep the old
behavior. After: fixing it in `use-llm-stream/src/multicast.ts`, running
`npm run build` there, then `npm run build:vendor` in the demo, is the
entire propagation path — one source of truth, two places it's used. For
a library that exists specifically to be a portfolio piece, that
property — a real consumer that would actually notice if the library
regressed — is worth more than the demo looking any different to
someone clicking "Run demo" in a browser. It looks identical. What
changed is which bugs are structurally impossible to reintroduce by hand.
