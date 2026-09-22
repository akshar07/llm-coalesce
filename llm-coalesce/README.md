# llm-coalesce

Request coalescing and stream multicasting for concurrent LLM calls. When
more than one caller asks a model for the *same* completion at roughly the
same time within a shared registry — a traffic spike hitting one backend
or independently-deployed UI widgets in one browser tab — `llm-coalesce` makes sure the provider
is asked exactly once, and every caller reads the same live token stream:
buffered chunks replay to a late joiner, then it switches to live.

```
cd llm-coalesce
npm ci
npm run build
```

The commands above run from this repository’s root. The demo installs a
committed package archive; registry publication is not required. Cross-tab
and distributed coordination are not implemented in v0.1.

## The problem

The clearest version of this doesn't need any UI at all — just concurrent
identical requests hitting one backend. A post goes viral, a stock ticker
spikes, an "explain this" button sits on a page that just got linked from
somewhere big: enough traffic arrives in the same second that hundreds of
requests for the *same* completion — same article, same ticker, same
underlying question — are in flight before any of them has finished.

This already has a name outside the LLM world: cache stampede, dog-piling,
thundering herd. Backend engineering already has answers for it when the
shared thing is a plain resolved value — Go's `singleflight` package,
memcached's lease mechanism, nginx's `proxy_cache_lock`. None of them
handle the part that matters here: an LLM completion is usually *streamed*,
for time-to-first-token, so sharing one resolved value isn't enough — you
need to fan out one *live* stream to every waiter. That's what
`MulticastStream` is for; `llm-coalesce` is single-flight for something
that streams.

```ts
// a request handler hit by many concurrent requests for the same article
const coalescer = createCoalescer();

export async function POST(req: Request) {
  const { articleId } = await req.json();
  const sub = await coalescer.stream(
    { articleId },
    () => streamText({ model, prompt: summarizePrompt(articleId) }).then(r => r.textStream),
  );
  return new Response(iterableToSseResponse(sub));
}
```

However many requests for the same `articleId` land in the same window,
the model is called once; every request streams the same live tokens.

The same shape shows up in a few other places:

- **Duplicate browser tabs.** A user opens the same account or document in
  two tabs — mundane, constant — and an AI panel that greets with "here's
  what's new" fires in both within the same second. Two tabs are two
  separate `window` objects; they can't share a plain in-memory registry
  even in principle. That's what the `BroadcastChannel` adapter (v0.3 on
  the roadmap) is for.
- **Multi-agent orchestration.** Two branches of an agent graph running
  concurrently can independently need the same grounding call mid-run —
  "look up the current status of order #4521" — because the orchestration
  doesn't thread that result between branches. As agent systems get more
  parallel, redundant identical sub-calls across concurrently-running
  branches is a real and growing cost.
- **Independently-deployed UI widgets.** The micro-frontend case: several
  separately-owned, separately-released pieces of UI on one page ask the
  model the same thing on load, and none of them can see the others to
  coordinate — see the example below.

Provider gateways (routing, metering, server-side observability) and
generic query caches (which dedupe well *within one shared cache instance*)
don't close this gap on their own — independently bundled or independently
running callers don't share a module instance, so exactly the coordination
you need most is what breaks first. `llm-coalesce` is a small, focused
layer for that specific problem: it wraps whatever LLM client you already
use, it doesn't replace it.

**What this doesn't solve:** two requests only coalesce if they're the
identical request — same model, same prompt, same params (see
`docs/adr/0002-exact-key-default.md`) — and only while they overlap in
time. Two different questions about the same underlying document or
resource don't coalesce, and shouldn't: they need different answers. The
same question asked again after the first call already finished doesn't
coalesce in v0.1 either — that's a resolved-value cache, a simpler and
different problem, planned as an opt-in TTL for v0.2 (see Known
limitations below).

## Quick example

```ts
import { createCoalescer } from "llm-coalesce";
import { streamText } from "ai"; // any client works — see examples/

const coalescer = createCoalescer();

// Widget A
const subA = await coalescer.stream(
  { documentId, clauseId },
  () => streamText({ model, prompt: explainClausePrompt(clauseId) }).then(r => r.textStream),
);
for await (const delta of subA) { /* render */ }

// Widget B — mounted independently, milliseconds later, same clause.
// The provider is called once; both widgets read the same stream.
const subB = await coalescer.stream(
  { documentId, clauseId },
  () => streamText({ model, prompt: explainClausePrompt(clauseId) }).then(r => r.textStream),
);
```

See `examples/vercel-ai-sdk.ts` and `examples/raw-fetch-sse.ts` for fuller,
runnable-shaped examples against both an AsyncIterable-returning client and
a raw `fetch` SSE response.

## API

- **`createCoalescer(options?)`** → `{ run, stream }`
  - `runAdapter?` — registry for `run()`. Defaults to an in-process `Map`.
  - `streamAdapter?` — registry for `stream()`. Defaults to an in-process
    `Map`; pass `windowAdapter()` to coordinate across independently
    bundled widgets sharing a page.
  - `keyFn?` — turns a non-string request into a cache key. Defaults to a
    canonical, order-independent serialization of the whole JSON-shaped object — two requests that
    differ only in a parameter (e.g. `maxTokens`) do **not** coalesce by
    default; see `docs/adr/0002-exact-key-default.md`.
- **`coalescer.run(request, fn)`** — coalesce a plain `Promise`-returning
  call. Concurrent callers with the same key share one invocation of `fn`;
  once it settles, the next call invokes `fn` again (in-flight deduping,
  not a result cache).
- **`coalescer.stream(request, fn)`** — coalesce a streaming call. `fn` is
  invoked once per key; every other caller attaches to the same
  `MulticastStream` instead. `request` can be a plain string key or an
  object (serialized via `keyFn`).
- **`MulticastStream`**, **`memoryAdapter`**, **`windowAdapter`**,
  **`stableHash`** — the underlying primitives, exported for direct use or
  a custom adapter. See the source in `src/` — it's a few hundred lines
  total and each file has a doc comment explaining its one job.

## Non-goals

- **Not a provider router.** Keep using the client you already have —
  `llm-coalesce` wraps a thunk, it never talks to a provider itself.
- **Not a hosted service.** Ships as a library; runs wherever your app runs.
- **Not an observability platform.** No dashboards here — pipe events into
  whatever you already use for that.
- **Not a prompt-management or A/B-testing system.**
- **Not a semantic cache.** Exact-key coalescing only; see
  `docs/adr/0003-semantic-caching-out-of-scope.md`.

## Known limitations (v0.1)

- The replay buffer is unbounded — correct for request/response-shaped
  completions, not yet bounded for very long-lived streams (e.g. a runaway
  agent loop). Buffer bounding is planned for v0.2.
- No opt-in post-completion TTL cache yet — once a stream settles, its
  registry entry is released immediately, so the next call with the same
  key always starts a fresh request. A short opt-in TTL is a near-term
  addition, not yet implemented.
- `windowAdapter` coordinates widgets sharing one `window` (one document).
  Cross-tab/cross-iframe coordination needs a `BroadcastChannel`-based
  adapter, planned for v0.3.

## Testing

```
npm test
```

Unit tests cover the coalescer and multicast primitives directly; a
property-based suite (`test/multicast.property.test.ts`, via `fast-check`)
asserts that for subscribers joining at arbitrary offsets into an arbitrary
stream, every subscriber observes every chunk, in order, exactly once; and
`test/integration.test.ts` asserts that N concurrent callers for the same
request produce exactly one upstream call, against both an AsyncIterable
source and a `ReadableStream` (raw SSE) source.

Real latency/cost benchmarks against a live provider are a v0.2 item —
what's here today is correctness, not yet a measured number.

## Roadmap

- **v0.1** (this release) — Coalescer + MulticastStream core, `memory` and
  `window` adapters, worked examples.
- **v0.2** — `llm-coalesce/react` hook, Vue composable, buffer bounding,
  opt-in TTL, published latency/request-reduction benchmarks.
- **v0.3** — `BroadcastChannel` adapter for cross-tab/iframe coordination,
  pluggable custom-registry interface, structured event emitter for piping
  into observability tools.
- **v1.0** — API stability commitment, opt-in semantic-key matcher (off by
  default).

## License

MIT

### Request key compatibility

`stableHash()` retains its historical name but now returns the complete
canonical serialization instead of a 32-bit digest. Object key order is
ignored; distinct supported values remain distinct. String keys and object
keys use separate internal prefixes. Custom `keyFn` implementations remain
responsible for their own collision behavior.

Use JSON-shaped values: plain objects, dense arrays, strings, finite numbers,
booleans, and null. Undefined, functions, symbols, bigint, non-finite numbers,
cycles, and class instances are rejected; convert these explicitly first.
Key strings contain request contents and should not be treated as redacted.
All bundles participating in shared coalescing should use the updated key
format; older bundles will not reliably coalesce with updated ones.

### Stream adapter cleanup compatibility

Custom stream adapters must implement `release(key, expectedEntry)` and remove
an entry only if it is still exactly `expectedEntry`. This prevents delayed
cleanup of a cancelled stream from deleting its replacement. The shared
registry protocol is now version 2; update cooperating bundles together.
