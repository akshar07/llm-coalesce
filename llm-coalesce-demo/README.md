# llm-coalesce demo

The step 1 demo ("One call, many widgets"), backed by a real Node server
and an actual *installed dependency* on
[`llm-coalesce`](../llm-coalesce/) — not a
sibling source checkout, not a bundled copy. `npm install` pulls in the
real package; the browser loads the real package's real compiled output,
with no bundler in between. `llm-coalesce` itself is provider- and
transport-agnostic: it never parses SSE, never calls a specific LLM API,
and only ever sees a plain `AsyncIterable`/`ReadableStream` that the
caller supplies. This demo's own SSE parsing lives in `public/sse.js`,
a small helper this project owns — see `TUTORIAL-provider-agnostic-core.md`.

## Run it

```
npm install
npm start
```

That's the whole setup. This project is self-contained — it does not
need `llm-coalesce`'s source repository checked out anywhere nearby.
(See "How the dependency actually works" below for what `npm install` is
pulling in and why.)

Open `http://localhost:3000`, click "Run demo", and compare the two
columns. The stat tiles show the server's own count of requests it
received — not a number the browser is claiming about itself.

Open `http://localhost:3000/microfrontends` for the harder case: three
genuinely separate ES module graphs (see "Files" below), coordinated only
through `windowAdapter()`, side by side with the same three graphs
*without* it — same demo server, same stats mechanism, a different claim
being proven. See `TUTORIAL-microfrontends-live-demo.md`.

## Tutorials, in the order this project actually evolved

- `TUTORIAL.md` — the original problem and the naive-vs-coalesced fix.
- `TUTORIAL-evolving-the-package.md` — pulling the engine out of this demo
  and into a real dependency.
- `TUTORIAL-decoupling-and-framework-agnostic.md` — a real tarball install
  instead of a sibling checkout, and dropping the bundler entirely.
- `TUTORIAL-microfrontends.md` — coalescing across independently bundled
  microfrontends on the same page, not just components in one bundle.
  *(Superseded design — see the Update note at the top of that file.)*
- `TUTORIAL-unifying-the-registry.md` — collapsing that fix's separate,
  required-namespace entry point into `subscribe()`'s own default
  behavior, with namespace as an optional escape hatch.
  *(That package, `use-llm-stream`, is superseded too — see the Update
  note at the top of that file.)*
- `TUTORIAL-provider-agnostic-core.md` — the switch to `llm-coalesce`: an
  independently-built, more complete package solving the same problem,
  adopted in place of `use-llm-stream` in order to keep the coalescing
  core provider-agnostic (no bundled SSE parser, no bundled fetch logic).
- `TUTORIAL-microfrontends-live-demo.md` — the microfrontend claim,
  actually demonstrated in this browser: three separately-served module
  graphs, a real Chromium run proving they're genuinely separate classes,
  and the isolated-vs-shared contrast — not asserted from the source or a
  unit test's fake `window` object.

## The architecture, precisely

`src/server.js` is intentionally dumb. `/api/stream` takes `mode`, `key`,
and `widget` as plain labels for the stats display — none of them change
server behavior. Every single request that reaches this endpoint starts a
brand new provider stream. There is no registry, no cache, no lookup by
key, anywhere on the server.

The coalescing engine — `MulticastStream`, the adapter-backed registry,
and the exact-key hashing — isn't duplicated in this project at all. It's
imported from `llm-coalesce`, which is deliberately provider- and
transport-agnostic: it takes a *thunk* that returns any
`AsyncIterable`/`ReadableStream`, and has no idea what's inside it. SSE
parsing is this demo's own concern (`public/sse.js`), not the library's:

```js
// public/app.js
import { createCoalescer } from "llm-coalesce";
import { createSSEStream } from "./sse.js"; // this demo's own helper, not part of llm-coalesce

const coalescer = createCoalescer();

// naive: every widget calls the server on its own
const iterator = createSSEStream(url)[Symbol.asyncIterator]();

// coalesced: every widget offers a *function*, not a call — coalescer.stream()
// only invokes it for the first widget in a group; everyone else joins
// the stream that call started
const iterator = await coalescer.stream(KEY, () => createSSEStream(url));
```

Because `coalescer.stream()` defers actually calling the fetcher until the
first subscriber starts pulling — and registers the in-flight entry
*before* that happens — N widgets mounting in the same tick for the same
key collapse into exactly one `fetch()` call. The server sees one request,
not because it was told to expect one, but because the browser never sent
the others. `stream()` itself resolves asynchronously (unlike the
predecessor package's synchronous `subscribe()`), but the registration
still happens synchronously inside it, before that promise's continuation
runs — see `TUTORIAL-provider-agnostic-core.md` for why that ordering
still holds. See `llm-coalesce`'s own README/ADRs for the full mechanism.

## How the dependency actually works

`package.json` depends on a local tarball:

```json
"llm-coalesce": "file:./vendor-packages/llm-coalesce-0.1.0.tgz"
```

That tarball is exactly what `npm pack` would produce right before
publishing to the registry — same `dist/` build output, same
`package.json`, same `README.md`/`LICENSE`, nothing from `src/` or
`test/` (npm respects the package's own `"files"` allowlist when packing
a tarball, same as it would for a real publish). `npm install` unpacks it
into `node_modules/llm-coalesce/` as a normal, flattened directory — not
a symlink to a source tree. If `llm-coalesce` were published for real,
the only change here would be that one line becoming
`"llm-coalesce": "^0.1.0"`; everything downstream of `npm install`
behaves identically either way, which is the whole point of packaging it
as a tarball instead of pointing at a sibling checkout. A clean-room
check proves this: the entire `llm-coalesce` source tree can be moved
out of reach and this demo's `npm install && npm test` still passes,
using only the tarball.

### Getting that installed package into a bundler-free page

`public/app.js` is a plain `<script type="module">`, no build step of its
own. Browsers can't resolve a bare specifier like `"llm-coalesce"`
without help, so `public/index.html` declares an import map:

```html
<script type="importmap">
{ "imports": { "llm-coalesce": "/vendor/llm-coalesce/index.js" } }
</script>
```

and `src/server.js` serves the installed package's compiled output at
that path directly from `node_modules`:

```js
app.use("/vendor/llm-coalesce", express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")));
```

`public/sse.js` needs no import-map entry or special route at all — it's
this demo's own file, already served from `public/` like any other
static asset, and `app.js` imports it by ordinary relative path.

No esbuild, no bundling step, nothing generated. The file the browser
loads at `/vendor/llm-coalesce/index.js` is byte-for-byte what's sitting
in `node_modules/llm-coalesce/dist/index.js` — its own internal imports
(`from "./multicast.js"`, etc.) are plain relative URLs that resolve on
their own once everything is served from one directory. This works
cleanly specifically *because* `llm-coalesce`'s entry has zero dependency
on React, a specific LLM SDK, or anything else that doesn't run
unmodified in a browser — see that package's README's "Non-goals".

Aborting a stream mirrors the original design: `MulticastStream` only
calls the source's `return()` once the *last* subscriber has left
(refcounted abort), which for a real stream means the underlying HTTP
connection (`reader.cancel()`) only closes when nobody is still
listening — one widget leaving early doesn't cut off the others.

### Simulating three independently bundled microfrontends

`/microfrontends` (`public/microfrontends.html`) needs a harder setup than
one vendor mount. `src/server.js` mounts the identical
`node_modules/llm-coalesce/dist` directory three times, under three
different path prefixes:

```js
for (const mfe of ["mfe-a", "mfe-b", "mfe-c"]) {
  app.use(`/vendor/${mfe}/llm-coalesce`, express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")));
}
```

`public/mfe-a.js`, `mfe-b.js`, and `mfe-c.js` each import from their own
prefix (`/vendor/mfe-a/llm-coalesce/index.js`, etc.) rather than a shared
bare specifier. Browsers key ES module identity on the resolved URL, not
file content or inode, so three different URLs serving byte-identical
files still evaluate as three wholly separate module graphs — separate
`MulticastStream` class, separate `windowAdapter()` closure, the works.
That's a faithful stand-in for three genuinely separate webpack/esbuild
builds, without this repo needing three actual build configs. See
`TUTORIAL-microfrontends-live-demo.md` for the real-browser proof that
this is actually true and not just asserted.

## Run the tests

```
npm test
```

3 integration tests (`node:test`) that spin up the real server as a child
process and drive it with `createCoalescer` imported directly from the
installed `llm-coalesce` package, plus `createSSEStream` from this
project's own `public/sse.js` — not a mock, not a copy: naive calls each
reach the server independently, N concurrent coalesced calls reach it
exactly once with identical streamed text across all of them, and a
widget arriving after the stream has settled correctly triggers a fresh
call rather than being (wrongly) joined to a dead one. The coalescing
*algorithm* itself is unit-tested where it's defined, in `llm-coalesce`'s
own test suite (31 tests, including property-based tests) — this
project's tests exist to prove the wiring, not to re-prove the algorithm.

```
npm run test:browser
```

A separate, real-browser check (Playwright + headless Chromium — a
`devDependency`, not needed for `npm test` above) that drives
`/microfrontends` directly: it imports each `mfe-*`'s own vendor copy of
`MulticastStream` and asserts the class objects are `!==` each other
(genuinely separate module graphs, not the same module three times), then
runs the page and asserts the server sees exactly 3 requests on the
isolated side and exactly 1 on the shared side. This one needs a real
Chromium binary — set `PLAYWRIGHT_CHROMIUM_PATH` if Playwright's default
browser resolution doesn't find one in your environment.

## Using a real LLM instead of the mock

By default the server streams a canned response at a realistic per-token
pace (`src/provider.js`) — zero setup, zero cost. To use the real
Anthropic API instead:

```
npm install @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

`@anthropic-ai/sdk` is an `optionalDependency`, loaded via dynamic
`import()`, so the server works without it installed as long as
`ANTHROPIC_API_KEY` is unset. This is completely orthogonal to
coalescing — it only changes where tokens come from, never how many
requests get sent.

## Deploying

Single Express process serving the API and the static frontend from the
same origin, specifically so there's no CORS to configure.

- **Any Node PaaS**: reads `process.env.PORT` (falls back to `3000`
  locally); point the platform at `npm start`. `npm install` is all the
  build step this project needs — no bundler to run.
- **Docker**: the `Dockerfile` copies `package.json`,
  `vendor-packages/`, `src/`, and `public/`, then runs `npm install
  --omit=dev`, which is enough to produce a working
  `node_modules/llm-coalesce` from the committed tarball.
- `GET /healthz` is provided for platforms that expect a health check.

Because coalescing lives entirely in the browser, this server scales
horizontally with zero extra work — there's no shared registry to worry
about keeping in sync across replicas, unlike a server-side coalescing
design would need. The tradeoff is the one `llm-coalesce`'s docs already
call out: this only coalesces requests made by the *same browser tab* —
it was never meant to coalesce across different users' machines, so this
isn't a limitation introduced by the demo, it's the shape of the actual
problem being solved.

## Files

```
package.json                       depends on the packed tarball below — a normal npm dependency
vendor-packages/llm-coalesce-*.tgz  `npm pack` output from llm-coalesce — install this, don't build it
src/server.js                       coalescing-unaware Express API: SSE streaming, stats, reset, health,
                                     serves the installed package's dist/ statically — once for the main
                                     demo, three more times (mfe-a/b/c) for the microfrontends demo
src/provider.js                     mock token stream, optional real Anthropic streaming
public/index.html                   declares the import map that resolves "llm-coalesce" in the browser
public/app.js                       imports "llm-coalesce" (bare specifier) + "./sse.js" (relative); demo UI/orchestration
public/sse.js                       this demo's own SSE-to-AsyncIterable helper — not part of llm-coalesce
public/microfrontends.html          the harder demo: 3 separately-served module graphs, isolated vs shared
public/microfrontends.js            orchestrates microfrontends.html; never imports llm-coalesce itself
public/mfe-a.js, mfe-b.js, mfe-c.js each imports llm-coalesce from its OWN /vendor/mfe-*/ mount — the
                                     one thing that has to be genuinely separate per file for this to be real
public/mfe-shared-ui.js             DOM helpers shared across mfe-*.js (UI plumbing, not part of the proof)
test/integration.test.js            node:test coverage proving the wiring against the real server + installed package
browser-tests/microfrontends-check.mjs  Playwright check for /microfrontends — separate from `npm test`,
                                     see "Run the tests"
```

## License

MIT
