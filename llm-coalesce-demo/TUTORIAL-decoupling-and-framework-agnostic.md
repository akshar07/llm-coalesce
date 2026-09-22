# Tutorial: a real install, and a package that isn't secretly React

Two separate problems got fixed together here, and it's worth being
precise about which is which, because they look like one change but
they're actually independent claims:

1. **`use-llm-stream`'s root export still assumed React**, even though
   nothing in the actual coalescing engine — `MulticastStream`,
   `subscribe`, `createSSEStream` — touches it. A package that calls
   itself framework-agnostic but only *probably* doesn't need React
   installed (verified by grepping a bundler's output) isn't actually
   framework-agnostic. It's React-optional-if-your-bundler-behaves.
2. **The demo's dependency on the package wasn't a real install.** It was
   `"file:../use-llm-stream"` — a live link to that package's *source*
   directory. That meant: both projects had to be checked out as
   siblings, in a specific build order (`use-llm-stream` built first, or
   nothing works), and getting the package into a browser page needed a
   bespoke esbuild step. None of that is what "depends on a package"
   normally means.

Fixing #1 turned out to make fixing #2 easier than expected — which is
the more interesting part of this tutorial, and the reason to fix them
together rather than separately.

## 1. Making the React-optionality structural, not empirical

The previous version of `use-llm-stream` had one entry point
(`src/index.ts`) that exported everything, including `useLlmStream`:

```ts
// the old src/index.ts
export { MulticastStream } from "./multicast.js";
export { subscribe } from "./registry.js";
export { createSSEStream } from "./sse.js";
export { useLlmStream } from "./useLlmStream.js";   // <- imports "react"
```

A consumer who only wanted `subscribe`/`createSSEStream` was *supposed*
to get away without React being resolved, because a bundler doing dead
code elimination should notice `useLlmStream` is never referenced and
drop that whole module, `import "react"` included. It worked — the
demo's old vendor bundle was 6.4kb with zero `react` references — but
"it worked" was a fact about esbuild's tree-shaking behavior on that
particular day, not a fact about the package's structure. Change
bundlers, misconfigure `sideEffects`, or have a future refactor add a
side effect to the wrong file, and the guarantee silently stops holding,
with no signal until someone notices their bundle got fat.

The fix is to make the split physical:

```ts
// src/index.ts — root entry, nothing here can ever import react
export { MulticastStream } from "./multicast.js";
export { subscribe } from "./registry.js";
export { createSSEStream } from "./sse.js";

// src/react.ts — a completely separate entry point
export { useLlmStream } from "./useLlmStream.js";
```

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  "./react": { "types": "./dist/react.d.ts", "import": "./dist/react.js" }
}
```

Now `import { subscribe } from "use-llm-stream"` *cannot* reach React —
not "shouldn't," not "won't if the bundler behaves," cannot, because
`dist/index.js` (the file that specifier resolves to) has no line of
code that mentions it:

```
$ grep -rn "react" dist/index.js dist/multicast.js dist/registry.js dist/sse.js
dist/index.js:7:// React bindings live at the separate "use-llm-stream/react" entry
```

One comment. No import. This is the general move worth remembering:
**when you can make a guarantee structural instead of relying on a build
tool to arrive at the right answer, do that** — it fails loudly (an
import error at the wrong entry point) instead of silently (an
unnecessarily fat bundle nobody notices until it's a problem).

`react` stays a `peerDependenciesMeta`-optional peer dependency — still
correct, since `use-llm-stream/react` genuinely needs it — but now it's
optional for a *provably* React-free root, not an empirically-mostly-free
one.

## 2. From a source link to a real install

The old dependency:

```json
"use-llm-stream": "file:../use-llm-stream"
```

`file:` pointing at a directory is a live link into that directory's
current state — effectively `npm link` with extra steps. It ignores the
package's own `"files"` allowlist (you get whatever's on disk, including
anything a `.gitignore` would normally keep out of a real install), it
requires the target to already be built (`dist/` populated) before
`npm install` in the consumer can possibly work, and it requires both
projects to exist side by side on whoever's machine is running this.
None of that is true of installing a package from the registry, so a
demo depending on a package this way isn't really testing "does someone
installing this package get a working experience" — it's testing "does
this specific checkout, in this specific relative position, with this
specific build already run, work."

The fix: package it the way it would actually ship.

```
cd use-llm-stream
npm pack
# → use-llm-stream-0.3.0.tgz
```

`npm pack` is not a preview or a dry run of publishing — the tarball it
writes is *the exact artifact* `npm publish` would upload to the
registry, built from the same `"files"` field, running the same
lifecycle scripts. Copying that one file into the consumer and pointing
at it:

```json
"use-llm-stream": "file:./vendor-packages/use-llm-stream-0.3.0.tgz"
```

turns `npm install` here into a real install: npm unpacks the tarball
into `node_modules/use-llm-stream/` as an ordinary flattened directory —
not a symlink, not a live view into someone else's `src/` — containing
exactly `dist/`, `README.md`, `LICENSE`, `package.json`. Nothing else.
That directory is indistinguishable from what `npm install
use-llm-stream` against the real registry would produce, which is the
actual bar for "decoupled": **if you deleted the `use-llm-stream` source
directory entirely right now, this demo would keep working, because its
only remaining dependency on it is one committed `.tgz` file.** The old
`file:../` setup would have broken immediately under that test; this one
doesn't. That's the concrete, checkable definition of decoupled being
used here — not a vibe, a specific thing you could delete and see for
yourself.

(In a real publish, that dependency line becomes `"use-llm-stream":
"^0.3.0"` and nothing else about this project changes — the tarball is a
faithful stand-in for exactly that scenario, one registry lookup away
from the real thing.)

## 3. The simplification #1 unlocked: no bundler needed at all

This is the part that wasn't originally planned — fixing the React
split made an entire build step in the demo unnecessary.

Before, getting the package into a bundler-free browser page needed
esbuild specifically *because* the root entry could theoretically pull in
React, so the safe move was: bundle it, mark `react` external, and verify
by grepping the output. After the split, the root entry structurally
cannot import React (or anything else Node/browser-incompatible) — so
there's nothing left for a bundler to protect against. The package's own
compiled output is already browser-safe as-is:

```html
<!-- public/index.html -->
<script type="importmap">
{ "imports": { "use-llm-stream": "/vendor/use-llm-stream/index.js" } }
</script>
```

```js
// src/server.js — serves the INSTALLED package's real dist/ directly
app.use(
  "/vendor/use-llm-stream",
  express.static(path.join(__dirname, "..", "node_modules", "use-llm-stream", "dist")),
);
```

```js
// public/app.js
import { subscribe, createSSEStream } from "use-llm-stream"; // bare specifier, resolved by the import map above
```

`dist/index.js`'s own internal imports (`from "./multicast.js"`, `from
"./registry.js"`) are plain relative URLs — once the whole `dist/`
directory is served from one path, those resolve on their own with no
bundler rewriting anything. `vendor-entry.js`, the `esbuild` dev
dependency, `npm run build:vendor`, and the generated
`public/vendor/use-llm-stream.js` are all just gone — not replaced by
something else, removed, because there was nothing left for them to do.

## 4. Verifying it in an actual browser, not just reading the code

An import map resolving a bare specifier to a real npm package's real
relative-importing output is exactly the kind of mechanism that reads
correctly and still might not work — a MIME type mismatch, an import map
ordering issue (it must appear before the module script that uses it), a
resolution edge case. Code review doesn't settle that; running it does.
So this got checked with a real, non-headless-in-appearance Chromium
instance driven by Playwright, not just `node --check`:

```js
const moduleWorks = await page.evaluate(async () => {
  const mod = await import("use-llm-stream");
  return typeof mod.subscribe === "function" && typeof mod.createSSEStream === "function";
});

await page.click("#runBtn");
await page.waitForFunction(() => {
  const naive = document.getElementById("naiveCalls")?.textContent;
  const coalesced = document.getElementById("coalescedCalls")?.textContent;
  return naive === "3" && coalesced === "1";
});
```

```
moduleWorks (bare 'use-llm-stream' import in the browser): true
naiveCalls: 3 coalescedCalls: 1
all coalesced widgets identical text: true
same-origin failures (should be empty): []
uncaught page errors (should be empty): []

PASS: real headless-Chromium run, import map + installed package, no bundler.
```

(The only network failure this test's environment produced was the
external Google Fonts stylesheet, blocked by that sandbox's own egress
policy — filtered out explicitly by checking same-origin failures only,
rather than by guessing at console-message text, which turned out to be
an unreliable signal for what actually failed versus what Chrome merely
logged about.) This is the same instinct as `test/integration.test.js`
from the previous tutorial: test the actual mechanism, in the actual
environment it runs in, not a proxy for it.

## Running it

```
npm install
npm start
```

No separate build step, no sibling checkout, no bundler. `npm test`
still runs the same integration suite as before — unaffected, since it
already imported the package the normal Node way.

## What changed, file by file

```
use-llm-stream/src/index.ts     now exports only MulticastStream/subscribe/createSSEStream
use-llm-stream/src/react.ts     NEW — useLlmStream, at its own "./react" subpath
use-llm-stream/package.json     "exports" gained "./react"; version bumped (breaking: useLlmStream moved)

llm-coalesce-demo/vendor-packages/use-llm-stream-0.3.0.tgz   NEW — npm pack output, committed
llm-coalesce-demo/package.json    "use-llm-stream" now points at that tarball, not "../use-llm-stream"
llm-coalesce-demo/src/server.js   serves node_modules/use-llm-stream/dist statically
llm-coalesce-demo/public/index.html   gained the import map
llm-coalesce-demo/public/app.js   imports "use-llm-stream" (bare specifier) instead of a local vendor bundle

REMOVED: vendor-entry.js, the esbuild dev dependency, npm run build:vendor,
the postinstall hook, public/vendor/ (generated bundle)
```

Net effect on the demo's own dependency tree: one fewer dev dependency,
one fewer build step, and (as a side effect worth noticing) the
`npm install` output went from reporting a moderate-severity
vulnerability — from esbuild's own transitive dependencies — to zero.
Removing a build step you don't need isn't just simpler; it's less
surface area for everything that build step's own dependencies bring
with it.
