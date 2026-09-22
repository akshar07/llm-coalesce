# Tutorial: coalescing over a real network boundary

Step 1 (`use-llm-stream`) proved the core mechanism — `MulticastStream` +
a lazily-registered `subscribe(key, fetcher)` — against an in-memory mock
stream. This demo proves the same mechanism against a real HTTP boundary:
a Node server that actually runs, actually streams, and actually gets
fewer requests when widgets share a key. Nothing about the coalescing
algorithm changes. What changes is what's on the other end of `fetcher()`
— and, just as importantly, where the coalescing decision is allowed to
live.

That second point is worth a section of its own, because I got it wrong
on the first attempt, and the fix is the most transferable lesson here.

> **Update:** sections 3 and 4 originally described this fetch-to-stream
> bridge and the `subscribe()` wiring as code living in this demo's own
> `public/app.js` / `public/registry.js`. As of `use-llm-stream@0.2.0`,
> that bridge (`createSSEStream`) is a first-class export of the package
> itself, and this demo now imports the real package instead of
> reimplementing it a third time. The code below reflects that — the
> *ideas* are unchanged, only where the code physically lives.

## 1. The wrong way to add a server: put the registry on it

The natural-looking first move, when asked to "add a Node server for the
API," is to move the whole coalescing engine onto the server — after all,
the server is what actually talks to the LLM, so surely it's in the best
position to notice duplicate requests. Something like this:

```js
// DON'T — coalescing lives on the server here
const registry = new Map(); // key -> in-flight MulticastStream

app.get("/api/stream", (req, res) => {
  const key = req.query.key;
  let entry = registry.get(key);
  if (!entry) {
    entry = new MulticastStream(getProviderStream(prompt), {
      onSettle: () => registry.delete(key),
    });
    registry.set(key, entry);
  }
  pipeToSSE(res, entry.subscribe());
});
```

This runs, and it even demos fine on a single process. It's still wrong,
for two reasons that only show up once you think about it as a service
rather than a script:

**It doesn't survive the deployment it's built for.** The whole point of
putting this behind a real server was "think as if this needs to be
deployed" — and any real deployment of a Node app worth demoing eventually
means more than one instance behind a load balancer. `registry` is a
plain in-memory `Map`. Replica A and replica B each have their own copy.
Two requests for the same key, routed to different replicas, will *not*
be coalesced — each replica sees an empty registry and calls the provider.
Fixing that server-side means standing up a shared store (Redis pub/sub,
typically) just to answer the question "is anyone else already asking
this?" — a real distributed-systems problem, for a demo that's supposed
to be about one specific, small idea.

**It puts the decision in the wrong place.** Coalescing answers the
question "do the callers currently asking for this actually want the
same live stream?" That's a question about the *callers* — which
component mounted when, which browser tab is asking — not about the
*provider*. The server doesn't know whether "widget A" and "widget B" are
two components in the same page that should share a stream, or two
different users who happen to be asking a similar question and very much
should not share one. The client already knows the answer, because it's
the client that decided to mount both widgets in the same render. Asking
the server to reconstruct that from a `key` string is asking it to
re-derive information it was never actually in a position to have
firsthand.

The fix isn't a better server-side registry. It's not putting a registry
on the server at all.

## 2. The right way: the server stays exactly as dumb as `getProviderStream`

```js
// src/server.js — every request, one fresh provider stream, no exceptions
app.get("/api/stream", async (req, res) => {
  const mode = req.query.mode === "coalesced" ? "coalesced" : "naive";
  // ...
  const streamOrPromise = getProviderStream(prompt);
  const iterable = typeof streamOrPromise.then === "function" ? await streamOrPromise : streamOrPromise;
  const iterator = iterable[Symbol.asyncIterator]();

  send("meta", { requestId, mode, widget });
  // ... pump iterator.next() into SSE frames until done ...
});
```

Read that and notice what's *not* there: no `Map`, no `key` lookup, no
branch that changes behavior based on `mode`. `mode` and `key` reach this
handler as plain strings used only to label which stats bucket to
increment (`stats.coalescedCalls` vs `stats.naiveCalls`) — cosmetic,
not behavioral. Every single request gets its own `getProviderStream()`
call. If you deployed this behind ten replicas tomorrow, nothing here
would need to change, because there's no shared state to keep consistent
across them.

The `/api/stats` endpoint this exposes is the one piece of infrastructure
worth calling out: it's not there to help the server coalesce anything —
it's there so the *demo* can prove, independently of whatever the browser
claims about itself, how many requests actually arrived. That
independence matters: if the stat tiles were computed purely client-side,
a bug in the coalescing logic that accidentally fired two real requests
could still show a truthful-looking "1 call" if the bug was in the
counting code rather than the request logic. Having the server count its
own inbound requests means the number on screen is either right or the
whole demo visibly breaks — there's no way for it to quietly lie.

## 3. Bridging `fetch()` into the shape `MulticastStream` expects — now part of `use-llm-stream` itself

`MulticastStream.pump()` (unchanged from Step 1) drives its source with
`await sourceIterator.next()` in a loop — pull-based, one value at a
time. `fetch()`'s `response.body` is a `ReadableStream` of raw bytes, and
`reader.read()` is *also* pull-based — that match is exactly why `fetch`
was the right choice here over something push-based like `EventSource`
(which fires callbacks on its own schedule and would need a queue/adapter
in between to convert push into pull).

The wrinkle: `fetch` hands you bytes, not tokens. A chunk boundary from
the network has no relationship to a message boundary in the SSE stream
— one `read()` might return half a frame, or three frames at once. So the
adapter has to buffer. This is exactly what `use-llm-stream@0.2.0` ships
as `createSSEStream()` (`src/sse.ts` in that package) — the same code
that used to live directly in this demo's `app.js`, promoted to a real,
tested, documented export so any consumer of the package gets it for
free instead of writing it themselves:

```ts
export function createSSEStream(url: string, options: CreateSSEStreamOptions = {}): AsyncIterable<string> {
  const { init, doneEvents = ["done"], errorEvents = ["error"], skipEvents = ["meta"], parseToken = defaultParseToken } = options;
  const responsePromise = fetch(url, init);

  return {
    [Symbol.asyncIterator]() {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let decoder: TextDecoder | null = null;
      let buf = "";
      return {
        async next() {
          if (!reader) {
            const res = await responsePromise;
            reader = res.body!.getReader();
            decoder = new TextDecoder();
          }
          while (true) {
            const frameEnd = buf.indexOf("\n\n");            // a complete SSE frame?
            if (frameEnd === -1) {
              const { value, done } = await reader.read();   // no — read more bytes
              if (done) return { done: true, value: undefined };
              buf += decoder!.decode(value, { stream: true });
              continue;
            }
            const frame = buf.slice(0, frameEnd);
            buf = buf.slice(frameEnd + 2);
            const parsed = parseFrame(frame);                // { event, data } or null
            if (!parsed) continue;
            const { event, data } = parsed;
            if (event && doneEvents.includes(event)) return { done: true, value: undefined };
            if (event && errorEvents.includes(event)) throw new Error(defaultErrorMessage(data));
            if (event && skipEvents.includes(event)) continue;
            return { done: false, value: parseToken(data, event) };
          }
        },
        async return(v?: unknown) {
          try {
            if (reader) await reader.cancel();
            else await (await responsePromise).body?.cancel();
          } catch { /* already closed */ }
          return { value: v as string, done: true };
        },
      };
    },
  };
}
```

Two details worth pointing at directly (unchanged from when this lived in
the demo — moving code doesn't change what it needs to get right):

**`return()` has to handle the case where no bytes have arrived yet.**
The first version of this only called `this._reader?.cancel()` — which
silently no-ops if `next()` was never called before `return()`, leaving
the `fetch()` promise to resolve and its response body to finish
downloading in the background even though nothing wants it anymore. The
fix awaits the same `responsePromise` either way and cancels whichever
handle actually exists. This is the same *shape* of bug as the
thundering-herd ordering bug from Step 1's tutorial: a codepath that only
gets exercised under a specific timing (abort-before-first-byte, there
register-after-await) and looks fine until you specifically go looking
for it.

**The `meta` event is deliberately swallowed inside `next()`, not
surfaced to the caller.** `MulticastStream` expects a source that only
ever yields real values — teaching this adapter to filter out
bookkeeping frames itself means the registry and `MulticastStream` don't
need to know SSE exists at all. That's the same reason `lazySource` and
`MulticastStream` are unchanged from Step 1 — they were designed against
a plain `AsyncIterable<string>` contract, and a real network stream can
be made to honor that same contract without altering a single line of
the thing that does the actual coalescing.

One thing that *did* change in the move from demo code to package code:
`doneEvents` / `errorEvents` / `skipEvents` / `parseToken` are now
options, not hardcoded strings — because a published package can't
assume every server names its events exactly like this demo's does. The
defaults still match this demo's contract, but a server that streams
OpenAI-shaped `{delta}` chunks under a `chunk` event instead can override
`parseToken` and `doneEvents` without forking the function.

## 4. Wiring it in: the one branch that decides everything

```js
// public/app.js
import { subscribe, createSSEStream } from "use-llm-stream";
// ^ the installed package, resolved via an import map — no bundler
//   involved; see TUTORIAL-decoupling-and-framework-agnostic.md

const url = buildUrl(mode, name);
let iterator;

if (mode === "coalesced") {
  iterator = subscribe(KEY, () => {
    coalescedCallSeq += 1;
    log("coalesced", "provider call #" + coalescedCallSeq + " started (shared)", true);
    return createSSEStream(url);
  });
} else {
  naiveCallSeq += 1;
  log("naive", "provider call #" + naiveCallSeq + " started", true);
  iterator = createSSEStream(url)[Symbol.asyncIterator]();
}
```

This is the entire architecture, in nine lines — and every symbol on the
right-hand side of that `import` is the actual package, not a local
stand-in. Naive widgets call `createSSEStream(url)` themselves — a real
`fetch()` fires immediately, every time, for every widget. Coalesced
widgets hand `subscribe` a *function that would call it* — and because
`subscribe()` (unchanged from Step 1, still living entirely inside
`use-llm-stream`) registers the in-flight entry synchronously, before
that function is ever invoked, N widgets subscribing to the same key in
the same tick result in exactly one of them actually calling
`createSSEStream`. The other N-1 never touch the network at all; they
just attach to the `MulticastStream` that the first one's fetch is
feeding.

Notice there's no third "on first call" argument to `subscribe()` here —
unlike an earlier version of this demo that added one directly to a local
copy of the registry. That would have meant patching the actual package's
public API just to support a demo's log line, which isn't a good reason
to grow a library's surface area. Instead, the counting/logging wrapper
lives entirely at the call site, in the closure passed to `subscribe`:
`coalescedCallSeq += 1; log(...)` runs exactly once per real call for the
same reason `createSSEStream` itself only runs once — `subscribe()`'s
laziness applies to the whole closure, not just the fetch inside it. The
package stays exactly as small as it needs to be; the demo gets its
logging by using the primitive correctly, not by asking for a bigger one.

## 5. Proving it against the real server

Two separate layers of proof now, matching the two-package split:

`use-llm-stream`'s own suite (17 tests, `vitest`) covers the algorithm —
`MulticastStream`, `subscribe`, and `createSSEStream` — against fake
in-memory sources and a mocked `fetch()` that returns real
`ReadableStream` bodies, no actual network involved. That's where the
"does the ordering bug happen, does `return()` cancel a reader, does an
error event throw the right message" questions get answered.

This demo's suite (`test/integration.test.js`, `node:test`, 3 cases)
answers a different question: does the actual installed package, wired up
to the actual server, produce the actual request counts the demo claims?
It spawns `src/server.js` as a real child process and drives it with
`subscribe`/`createSSEStream` imported straight from `node_modules`:

```js
import { subscribe, createSSEStream } from "use-llm-stream"; // not a mock, not a copy

const urls = [0, 1, 2].map((i) => `${BASE}/api/stream?mode=coalesced&key=itest&widget=c${i}`);
const iterators = urls.map((u) => subscribe("itest", () => createSSEStream(u)));
const texts = await Promise.all(iterators.map(drain));

const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
assert.equal(stats.coalescedCalls, 1); // the server's own count, not the client's
```

Running it:

```
$ npm test
ok 1 - naive: N independent createSSEStream() calls each hit the server
ok 2 - coalesced: N subscribe()+createSSEStream() calls hit the server exactly once
ok 3 - a widget arriving after the stream settles gets a fresh call, on purpose
```

The server — which, remember, has no idea what a registry is — counted
exactly one request for the coalesced group and three for the naive one.
That number isn't something the client asserted about itself; it's an
independent count from a process that never received the other two
requests, because they were never sent. The third test is the same
"settled entries aren't reused" property from Step 1, now checked against
a real HTTP round trip instead of an in-memory fake.

This split is itself worth naming as a pattern: **test the algorithm
where it's defined, test the wiring where it's used.** Duplicating
`use-llm-stream`'s own unit tests inside this demo would prove nothing
new; testing that *this specific integration* produces the request counts
the UI claims is the one thing only this project can verify.

## 6. Running it yourself

```
npm install
npm start
# open http://localhost:3000, click "Run demo"
npm test
```

This project is self-contained — `use-llm-stream` is an installed
dependency (a committed tarball under `vendor-packages/`), not a sibling
source checkout. See `TUTORIAL-decoupling-and-framework-agnostic.md` for
how that works and why it changed from an earlier version of this demo.

Set `ANTHROPIC_API_KEY` to swap the mock for real streamed completions —
see the README. It changes nothing about the coalescing story; it only
changes what's generating the tokens the two adapters above are already
built to carry.

## What this still doesn't cover

Same boundaries as Step 1, because the underlying mechanism is identical
— only now made concrete against a real deployment shape:

- **One browser tab, one registry.** `use-llm-stream`'s registry is a
  module-level `Map` — one instance per page load, shared by everything
  that imports the package on that page. A second tab, or a page reload
  mid-demo, starts a fresh one. Coordinating across tabs needs
  `BroadcastChannel`; across independently-bundled widgets on the same
  page needs a version-negotiated `window`-global registry, the same
  shape a fuller "llm-coalesce" project would document.
- **No resolved-value reuse.** A widget that mounts after the stream has
  already settled gets a brand new request on both sides of the demo —
  the "mount one more widget now" button demonstrates this on purpose.
  The registry entry is released the moment the stream finishes; keeping
  it around a while longer is a real, small extension, not built here.
- **Horizontal scaling is a non-issue, not a solved one.** Because
  coalescing never touches the server, this deploys to any number of
  replicas with zero additional work — but that's because the server was
  never asked to solve the multi-replica version of this problem, not
  because it solved it. If you ever *did* want cross-replica coalescing
  (two different users' browsers, somehow, sharing a stream), that's a
  fundamentally different, much harder problem this pattern doesn't
  address at all.
