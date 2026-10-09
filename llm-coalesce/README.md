# llm-coalesce

Share one in-flight request or token stream among concurrent callers with the
same key. Late stream subscribers receive buffered chunks, then live chunks.
The library accepts provider-supplied async iterables and readable streams;
it has no runtime dependencies.

## Installation

```sh
npm install llm-coalesce
```

## Local setup

From this repository's root:

```sh
cd llm-coalesce
npm ci
npm run build
```

The demo uses a committed npm archive, so it does not require registry
publication. See the [demo](https://github.com/akshar07/llm-coalesce/tree/main/llm-coalesce-demo)
for a browser example with an SSE backend.

## Usage

```ts
import { createCoalescer } from "llm-coalesce";

const coalescer = createCoalescer();

async function* generate() {
  yield "Hello";
  yield " world";
}

// Subscribe both callers before consuming the stream.
const first = await coalescer.stream("greeting", generate);
const second = await coalescer.stream("greeting", generate);

async function read(stream: AsyncIterable<string>) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

console.log(await Promise.all([read(first), read(second)]));
// ["Hello world", "Hello world"] — one invocation of generate().
```

Replace `generate` with a factory returning your provider's `AsyncIterable`
or `ReadableStream`, directly or through a promise. Creating a subscription
starts the source; callers must consume it or close it with `return()`.
Once the source settles, the next call with the same key starts fresh.

## API

`createCoalescer(options?)` returns:

- `run(request, fn)`: share a promise among concurrent callers with the same key.
  The entry is removed on success or failure.
- `stream(request, fn)`: return a promise for an independent async iterator over
  a shared stream. Buffered chunks replay before live chunks.

Options:

| Option | Default | Purpose |
| --- | --- | --- |
| `runAdapter` | `memoryRunAdapter()` | Store in-flight promises. |
| `streamAdapter` | `memoryAdapter()` | Store in-flight streams. |
| `keyFn` | `stableHash` | Convert object requests into sharing keys. |

Each default adapter has its own registry. Reuse a coalescer or explicitly
share an adapter to coordinate callers. For separate bundles in the same page:

```ts
import { createCoalescer, windowAdapter } from "llm-coalesce";

const coalescer = createCoalescer({ streamAdapter: windowAdapter() });
```

`windowAdapter()` shares streams through the same global object. It does not
share `run()` calls, coordinate browser tabs, or coordinate separate processes.

Additional exports: `MulticastStream`, `memoryAdapter`, `memoryRunAdapter`,
`windowAdapter`, `stableStringify`, `stableHash`, `toAsyncIterable`, and
`PROTOCOL_VERSION`, plus their public types.

## React

React 18 and 19 apps can use the optional `llm-coalesce/react` entry point.
The core entry point does not import React. Install React in your application.

```tsx
import { createCoalescer } from "llm-coalesce";
import { useLlmStream, type StreamFetcher } from "llm-coalesce/react";

// Share this instance between widgets in this client application.
const coalescer = createCoalescer();

function Summary({ requestKey, generate }: {
  requestKey: string;
  generate: StreamFetcher;
}) {
  const { text, status, error } = useLlmStream(requestKey, generate, { coalescer });
  if (status === "error") return <p role="alert">{String(error)}</p>;
  return <p aria-busy={status !== "done"}>{text || "Loading…"}</p>;
}
```

`useLlmStream(key, fetcher, { coalescer })` accepts a string key and a factory
returning an `AsyncIterable<string>` or `ReadableStream<string>`, directly or
through a promise. It returns accumulated `text`, `status` (`loading`,
`streaming`, `done`, or `error`), and `error`. Map structured provider events
to text chunks before returning the stream.

Changing the key or coalescer closes the previous subscription and starts a
new one. Inline fetcher functions and options objects do not restart it; the
latest committed fetcher is used on the next subscription. Put every input
that affects the response in the key. Keep the coalescer instance stable.
Unmounting closes only that component's subscription; other readers continue.
React Strict Mode can replay effect setup and cleanup in development, so do
not assume exactly one provider start across separate subscription lifetimes.

The hook starts work in an effect, not during server rendering. In frameworks
with server components, use it from a client component. Scope the coalescer to
your client application or provider; do not share tenant-specific work through
a process-global server instance. Use a coalescer configured with
`windowAdapter()` for independently bundled widgets on the same page.

The retired `use-llm-stream/react` hook is replaced by this entry point. Migration
requires supplying a shared coalescer; there is no implicit global registry or
built-in SSE parser.

## Request keys

Requests can be explicit string keys or JSON-shaped objects. **The same key
means the first factory wins.** The library does not inspect provider arguments
inside the factory. Include the model, prompt, generation parameters, and any
user or tenant scope that affects whether sharing is appropriate.

Object fields are sorted before serialization; array order is preserved.
String and object keys use separate internal prefixes. Despite its historical
name, `stableHash()` returns the full canonical serialization, not a digest.
Keys contain request contents and should not be treated as redacted.

Supported values are plain objects, dense arrays, strings, finite numbers,
booleans, and null. Undefined, functions, symbols, bigint, non-finite numbers,
cycles, and class instances are rejected. Convert these explicitly or supply
a custom `keyFn`, which is responsible for its own collision behavior.

## Stream lifecycle

Each subscriber has its own read cursor. A slow reader does not block other
subscribers. Calling `return()` or `throw()` closes that subscriber; pending
and future reads finish without more chunks. Other subscribers remain active.
When the last subscriber leaves before completion, the library requests
upstream cancellation through the source iterator's `return()` method.
Whether pending provider work stops immediately depends on the source.

The replay buffer holds the full stream without a size limit. Use finite
request/response streams. There is no post-completion cache, semantic matching,
cross-tab coordination, or distributed registry.

Custom stream adapters must implement `release(key, expectedEntry)` and delete
only when the stored entry is exactly `expectedEntry`. Comparison and deletion
must happen synchronously so delayed cleanup cannot remove a replacement.
The shared registry protocol is version 2; incompatible versions do not
coalesce. Upgrade cooperating bundles together.

## Development

From the package directory:

```sh
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The package includes `dist/`, this README, and the license. Tests cover request
sharing, replay, cancellation, error propagation, keys, and registry ownership.
Design decisions are recorded in the
[ADRs](https://github.com/akshar07/llm-coalesce/tree/main/llm-coalesce/docs/adr).

## License

MIT
