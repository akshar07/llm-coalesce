// The package's root entry — framework-agnostic on purpose. Nothing
// reachable from here imports React (or any other UI framework); the
// coalescing engine (MulticastStream, subscribe) and the SSE network
// bridge (createSSEStream) work the same way whether the caller is a
// React component, a Vue composable, or a plain script — and the same
// way whether every caller is in one bundle or spread across several
// independently built microfrontends on one page. See registry.ts's doc
// comment for why `subscribe()` doesn't need a separate entry point for
// that last case.
//
// React bindings live at the separate "use-llm-stream/react" entry
// point (src/react.ts) — see that file, or the README's "Framework
// bindings" section, for why the split exists and how a binding for a
// different framework would be added the same way.

export { MulticastStream } from "./multicast.js";
export type { MulticastOptions } from "./multicast.js";

export { subscribe, DEFAULT_NAMESPACE } from "./registry.js";
export type { Fetcher, SubscribeOptions } from "./registry.js";

export { createSSEStream } from "./sse.js";
export type { CreateSSEStreamOptions } from "./sse.js";
