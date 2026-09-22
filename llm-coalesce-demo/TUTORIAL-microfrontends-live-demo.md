# Tutorial: proving the microfrontend claim, not just citing it

The question that started this was blunt and fair: *how does the demo
confirm this for multiple microfrontends?* The honest answer at the time
was that it didn't. `public/app.js` calls `createCoalescer()` with no
options — the default `memoryAdapter()`, one module, one script tag. Every
"widget" in the original demo is a DOM card created by that one script
calling one shared `coalescer` object directly. That was never a
cross-bundle scenario; it's multiple callers in one module, which was
never in question.

And `llm-coalesce`'s own unit tests for `windowAdapter()` don't close that
gap either. Read literally, `test/adapters.window.test.ts` does this:

```ts
const widgetA = windowAdapter(fakeWindow as never);
const widgetB = windowAdapter(fakeWindow as never);
widgetA.register("key-1", entry);
expect(widgetB.acquire("key-1")).toBe(entry);
```

Both calls happen in the same test file, the same module instance, the
same `windowAdapter` function. It proves the adapter correctly reads and
writes through whatever object you hand it — genuinely useful, but not the
same claim as "two independently bundled copies of this library, each
with their own class definitions, correctly interoperate through one
shared object." That's a materially weaker proof than the one this
project used to have: `use-llm-stream/test/crossBundle.test.ts` forced two
*actually separate* module evaluations via Vite's `?bundle=a`/`?bundle=b`
query-string trick, and I additionally re-ran that contrast in real
headless Chromium with two separate `<script type="module">` tags. Neither
of those two harder checks carried over to `llm-coalesce` when the project
switched to it. This tutorial is what closes that gap, in this demo,
where the original claim was actually made.

## 1. Getting "genuinely separate module graphs" without a bundler

The old trick used Vite's dev-server query-string handling — not
available here, since this demo deliberately has no bundler at all (see
`TUTORIAL-decoupling-and-framework-agnostic.md`). The replacement needed
to work with plain static file serving and a browser's native module
loader, with nothing else in between.

The fix is simpler than the old trick, and arguably more honest about
what it's simulating: serve the *identical* `node_modules/llm-coalesce/dist`
directory from three different URL prefixes.

```js
// src/server.js
for (const mfe of ["mfe-a", "mfe-b", "mfe-c"]) {
  app.use(
    `/vendor/${mfe}/llm-coalesce`,
    express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")),
  );
}
```

Browsers key ES module identity on the *resolved URL*, never on file
content or filesystem inode. `/vendor/mfe-a/llm-coalesce/index.js` and
`/vendor/mfe-b/llm-coalesce/index.js` are different URLs, so the browser
fetches and evaluates each as an independent module record — even though
Express is streaming byte-identical bytes for both from the same file on
disk. Critically, this isolation isn't limited to the one file you
explicitly import: `index.js`'s own internal imports (`from
"./adapters.js"`, `from "./multicast.js"`, ...) are plain *relative* URLs,
resolved against the importing module's own URL. So importing
`/vendor/mfe-a/llm-coalesce/index.js` pulls in
`/vendor/mfe-a/llm-coalesce/adapters.js`,
`/vendor/mfe-a/llm-coalesce/multicast.js`, and so on — the browser never
crosses back over to `mfe-b`'s copies of anything. Three prefixes, three
complete, wholly independent dependency graphs: separate
`MulticastStream` class, separate closures inside `windowAdapter()`,
separate everything — a faithful stand-in for three genuinely separate
webpack/esbuild builds, without this repo needing three actual build
configs.

## 2. Three widget files, not one script with a loop

`public/mfe-a.js`, `mfe-b.js`, and `mfe-c.js` are nearly identical, and
that's deliberate — each one hardcodes its own vendor prefix:

```js
// public/mfe-a.js
import { createCoalescer, windowAdapter } from "/vendor/mfe-a/llm-coalesce/index.js";
import { createSSEStream } from "./sse.js";

const isolatedCoalescer = createCoalescer();
const sharedCoalescer = createCoalescer({ streamAdapter: windowAdapter() });

export function getCoalescer(mode) {
  return mode === "shared" ? sharedCoalescer : isolatedCoalescer;
}
```

`mfe-b.js` and `mfe-c.js` differ only in their vendor path and display
name. Writing three separate files instead of one parameterized loop was
a deliberate choice: a loop that constructs three `import()` calls from a
template string would still prove the URL-keying claim, but three
hand-written files read more honestly as "three teams, three widgets" —
the shape this page is actually standing in for. What *is* shared across
the three — `public/mfe-shared-ui.js` (card rendering, logging) and
`public/microfrontends.js` (the orchestrator that decides when each one
mounts) — never imports `llm-coalesce` at all, so sharing that plumbing
doesn't undermine the proof. A real microfrontend platform's host shell
and design system work the same way: shared chrome, independent business
logic.

Each `mfe-*.js` exposes two coalescers from its own private module scope:
`isolatedCoalescer` (the library's default in-process `Map`) and
`sharedCoalescer` (backed by `windowAdapter()`). `microfrontends.html`
runs both groups side by side against the identical request key, so the
contrast is visible in one run rather than two separate ones.

## 3. Proving it, in a real browser, two different ways

**Module identity, checked directly.** Before ever clicking "Run demo,"
the page's own dependency graph is interrogated from the browser console
context:

```js
const a = await import("/vendor/mfe-a/llm-coalesce/multicast.js");
const b = await import("/vendor/mfe-b/llm-coalesce/multicast.js");
a.MulticastStream === b.MulticastStream; // false
```

That's the load-bearing claim, checked directly rather than inferred from
behavior: two `MulticastStream` classes, not one class imported twice.

**Behavior, checked by running the actual page.** Clicking "Run demo"
mounts all three microfrontends' isolated coalescers and all three shared
coalescers, in the same tick, against one shared key — the exact
same-tick-thundering-herd scenario the whole feature exists for:

```
class identity (both must be false — three separate module graphs): { abSameClass: false, acSameClass: false }
stats (isolated must be 3, shared must be 1): { isolatedCalls: '3', sharedCalls: '1' }
shared texts identical: true
page errors: []
relevant failed requests: []
PASS
```

Three isolated coalescers, three real requests — each one's private `Map`
genuinely has no way to see the other two, so this isn't a coincidence,
it's the bug the feature exists to fix, faithfully reproduced. Three
`windowAdapter()`-backed coalescers, one real request, identical streamed
text on all three widgets — coordinated purely through the one object
three separate module graphs actually do share on a real page: `window`.

This check is committed as `browser-tests/microfrontends-check.mjs`,
runnable with `npm run test:browser`, not folded into the plain `npm
test` node:test suite — it needs a real Chromium binary and the
`playwright` package, neither of which the fast, dependency-light
integration tests should require. (It also had to live outside `test/`
entirely: Node's `--test` runner auto-discovers *any* `.js`/`.mjs` file
inside a directory literally named `test`, regardless of filename — the
first version of this file lived at `test/microfrontends.browser.test.mjs`
and broke `npm test` for anyone without `playwright` installed, the moment
it existed. `browser-tests/microfrontends-check.mjs` avoids both of
Node's auto-discovery triggers: it's not under a `test`-named directory,
and its filename doesn't match `*.test.mjs`.)

## 4. What this does and doesn't prove

This is still one browser tab, one `window`, one JS realm — the three
"microfrontends" are separately-bundled in the sense that matters
(separate module graphs, separate classes), but they still share the one
`window` object every script on a page always shares. That's precisely
the boundary `windowAdapter()` is built to bridge, and precisely the
boundary it stops at: two browser *tabs* are two separate `window`
objects in two separate realms, and nothing here — or in `llm-coalesce`
today — bridges that gap. See the previous answer on cross-tab
coordination, and `llm-coalesce`'s own README roadmap (`BroadcastChannel`
adapter, planned v0.3) for what closing that second gap would take.

## What changed, file by file

```
llm-coalesce-demo/src/server.js                  3 new static mounts (mfe-a/b/c), new /microfrontends route
llm-coalesce-demo/public/microfrontends.html     NEW — the isolated-vs-shared page
llm-coalesce-demo/public/microfrontends.js       NEW — orchestrator; never imports llm-coalesce directly
llm-coalesce-demo/public/mfe-a.js                NEW — imports llm-coalesce from /vendor/mfe-a/…
llm-coalesce-demo/public/mfe-b.js                NEW — imports llm-coalesce from /vendor/mfe-b/…
llm-coalesce-demo/public/mfe-c.js                NEW — imports llm-coalesce from /vendor/mfe-c/…
llm-coalesce-demo/public/mfe-shared-ui.js        NEW — DOM helpers shared across mfe-*.js
llm-coalesce-demo/public/index.html              added a link to /microfrontends
llm-coalesce-demo/browser-tests/microfrontends-check.mjs  NEW — Playwright proof, run via `npm run test:browser`
llm-coalesce-demo/package.json                   added `playwright` devDependency + `test:browser` script
llm-coalesce-demo/README.md                      documented the new page, mounts, and test command
```

## The lesson worth keeping

Being asked "how does the demo confirm this?" and not having an answer
better than "the library's README says so" was the actual finding here,
more than any bug. A claim about cross-bundle behavior is a claim about
how a real module loader resolves real URLs — a unit test that hands the
same function two references to one JavaScript object doesn't test that,
no matter how confidently its `describe` block is named. The fix wasn't
writing a better assertion; it was noticing the assertion was answering
an easier question than the one being asked, and building a page where
the harder question actually has to hold up in a real browser to pass.
