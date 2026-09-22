# use-llm-stream

A framework-agnostic engine that lets any number of callers request the
same streaming LLM completion at the same time — the provider is called
exactly once, and every caller reads the same live token stream. This
holds whether those callers are components in one bundle or spread across
several independently built microfrontends sharing one page; there's one
`subscribe()`, not a different one for each case. Works against a real
HTTP/SSE backend or an in-memory source. React is an optional binding, not
a requirement: the root package has no dependency on React (or any other
framework) at all.

```
npm install use-llm-stream
```

```ts
import { subscribe, createSSEStream } from "use-llm-stream";

// Two calls with the same key, made concurrently — from anywhere, in any
// framework — result in exactly one request to /api/stream.
const stream = subscribe("clause-7", () => createSSEStream("/api/stream?clauseId=7"));
for await (const token of stream) {
  process.stdout.write(token);
}
```

## Framework bindings

`use-llm-stream/react` exports the React hook, kept at its own entry
point so importing it — and pulling in React — is opt-in:

```tsx
import { useLlmStream } from "use-llm-stream/react";
import { createSSEStream } from "use-llm-stream";

function ClauseExplainer({ clauseId }: { clauseId: string }) {
  const { text, status } = useLlmStream(clauseId, () =>
    createSSEStream(`/api/stream?clauseId=${clauseId}`),
  );
  return <p>{status === "loading" ? "Thinking…" : text}</p>;
}
```

Mount this from as many independently-rendered components as you like for
the same key — the model gets asked once. `useLlmStream` is a thin
wrapper (`src/useLlmStream.ts`): subscribe on mount, accumulate chunks
into state, and call `.return()` on unmount so the underlying request
only aborts when the *last* attached component goes away.

No other framework binding exists yet, but the shape for adding one is
the same: a new `src/<framework>.ts` entry that calls `subscribe()`
internally, exported at its own `"./<framework>"` subpath in
`package.json`'s `exports` map, so a Vue or Svelte consumer never touches
React and a plain-script consumer never touches either.

Why `use-llm-stream` — a name that reads like a hook — has a
framework-agnostic root: it started as exactly a React hook (see
`TUTORIAL.md`'s Step 1), and the name stuck through the generalization
rather than getting a rename. The root export is the actual engine; the
name is a bit of history.

## Coordinating across independently bundled microfrontends

`subscribe()` is backed by a registry stored on `globalThis` (under a
`Symbol.for()` key), not module scope — unconditionally, for every caller.
That's what makes it work the same way whether two callers are components
in one bundle or independently built microfrontends sharing a page: a
plain module-scoped `Map` would only be shared in the first case (module
scope is a singleton per bundle, not per page), but `globalThis` really is
one shared object for every script in the same realm, regardless of how
many separate builds put code there. There's no separate API to reach for
in the microfrontend case — it's the same `subscribe()`:

```ts
import { subscribe, createSSEStream } from "use-llm-stream";

// Works identically whether this runs once (one bundle) or is duplicated
// across several independently built microfrontends on the same page.
const stream = subscribe("summarize-cart", () => createSSEStream("/api/stream?key=cart"));
```

By default, every call shares one namespace (`DEFAULT_NAMESPACE`), which
is the right choice almost all the time: it assumes you're not sharing a
page with a *different product* that also happens to depend on this exact
package. If you are — a host page embedding independently vendored
widgets, say — pass an explicit `namespace` to opt back into isolation:

```ts
subscribe("summarize-cart", fetcher, { namespace: "acme-checkout" });
```

`globalThis` is shared by *everything* on the page, so the namespace is
what scopes the sharing boundary to callers that deliberately opted in
together; two different namespaces never share state, even for an
identical key. See `src/registry.ts`'s module doc for the full reasoning
(the `Symbol.for` choice, the version-segmented key, and why the default
is optional rather than required).

One caveat worth stating plainly: whichever bundle's call actually creates
a shared entry is the version of this package whose code governs that
entry's behavior for its lifetime; a newer bundle attaching to it rides
along on the older one's implementation. Keep every microfrontend that
shares a namespace on the same major version of this package — the same
discipline you'd already apply to a shared React instance.

*(Earlier, this lived at a separate `use-llm-stream/window` entry point
with a required namespace, opt-in. It was folded into the one `subscribe()`
almost immediately after shipping — see `TUTORIAL-unifying-the-registry.md`
in the demo project for why a single mechanism with a safe default beat
two mechanisms the consumer had to choose between.)*

## Talking to a real backend

`fetcher` can be anything that returns an `AsyncIterable<string>` — it
doesn't have to be an in-memory mock or a client-side SDK call. The
package ships `createSSEStream()` for the common case of a Node/Express
(or any) backend streaming tokens over Server-Sent Events — used in both
examples above.

`createSSEStream(url, options?)` turns `fetch()`'s response body — a
pull-based `ReadableStream` of raw bytes — into the same pull-based
`AsyncIterable<string>` shape `subscribe()` expects, reassembling
`event:`/`data:` frames across chunk boundaries by hand (no `EventSource`,
which is push-based and would need its own adapter). It defaults to a
`{ token: string }` JSON payload per `data:` line, a `done` event to end
the stream, an `error` event whose `data.message` becomes a thrown
`Error`, and a `meta` event that's silently skipped — override any of
`doneEvents` / `errorEvents` / `skipEvents` / `parseToken` to match a
different server's contract. Aborting (the last subscriber leaving)
calls `reader.cancel()`, so the underlying HTTP connection actually closes
instead of finishing, unread, in the background.

## How it works

Two pieces, both under the root entry: `MulticastStream`
(`src/multicast.ts`) buffers a source's output so any number of
subscribers can read it independently, each at its own pace, without the
source being consumed more than once. `subscribe()` (`src/registry.ts`)
keeps a shared registry keyed by request — stored on `globalThis`, not
module scope, namespaced so unrelated uses of this package can't collide —
and, critically, wraps the fetcher so it isn't actually invoked until the
first subscriber's stream starts pumping, which lets registration happen
*before* the network/model call rather than after it. That ordering is
what stops two concurrent callers from both triggering a request; see
`TUTORIAL.md` for the full walkthrough of why it matters and the bug it
fixes. Neither file has ever imported React — `useLlmStream` (the only
thing that does) sits on top of `subscribe()`, not the other way around.

## Scope (Step 1)

This is deliberately the smallest version of the problem: one JS runtime,
in-flight coalescing only — but coalescing across every caller sharing a
namespace, whether they're in one bundle or independently built and
bundled separately, since that distinction doesn't actually matter to a
`globalThis`-backed registry. Explicitly still out of scope (see
`TUTORIAL.md`'s closing section): resolved-value reuse after a stream has
already finished, and cross-*tab*/cross-window coordination (a real
`window` object per tab means `globalThis` itself isn't shared across
tabs the way it is across same-tab microfrontends — that would need
`BroadcastChannel` or `SharedWorker`, a different mechanism entirely).

## Testing

```
npm test
```

21 tests: `MulticastStream` correctness (single start, replay-to-late-
joiner, error propagation, refcounted abort), the registry's coalescing
behavior (including the back-to-back-calls case that would catch the
ordering bug described in the tutorial), `createSSEStream` parsing real
HTTP responses (token extraction, custom event contracts, error
propagation, cancellation on abort, and composing with `subscribe()` to
confirm N concurrent callers still trigger exactly one `fetch()`),
`useLlmStream` rendered with React Testing Library — including two
components mounted together, a component joining mid-stream, and one of
two consumers unmounting early without cutting off the other — and the
cross-bundle behavior, verified against genuinely separate module
instances (two distinct evaluations of the same source, the same
isolation two independently built microfrontends would have): the
default (no-namespace) `subscribe()` provably coalesces across them, an
explicit namespace provably isolates from the shared default and from
other namespaces, and an explicit empty-string namespace is rejected
outright.

## Breaking change in 0.3.0

`useLlmStream` moved from the root export to `use-llm-stream/react`. If
you're upgrading from 0.1.x/0.2.x:

```diff
-import { useLlmStream } from "use-llm-stream";
+import { useLlmStream } from "use-llm-stream/react";
```

`subscribe`, `createSSEStream`, and `MulticastStream` are unaffected —
still at the root.

## Behavior change in 0.5.0

`subscribe()`'s registry moved from module scope to `globalThis` (see
"Coordinating across independently bundled microfrontends" above). No
import or call site needs to change — `subscribe(key, fetcher)` still
works exactly as before for the common single-bundle case — but it's
worth knowing the registry now has a (namespaced, symbol-keyed) footprint
on the global object where it previously had none. The short-lived
`use-llm-stream/window` entry point from 0.4.0 is gone; its functionality
is now just `subscribe()`'s default behavior, with `{ namespace }` as an
option rather than a separate import.

## License

MIT
