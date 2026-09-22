// The React binding, isolated behind its own entry point (`use-llm-stream/react`)
// so that importing the package's root — `subscribe`, `createSSEStream`,
// `MulticastStream` — never pulls React into a project that doesn't use
// it. This is the only file in the package that imports "react"; nothing
// under the root entry (src/index.ts) reaches it.
export { useLlmStream } from "./useLlmStream.js";
export type { StreamStatus, UseLlmStreamResult, Fetcher, SubscribeOptions } from "./useLlmStream.js";
