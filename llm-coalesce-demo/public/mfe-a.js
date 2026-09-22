// "Microfrontend A" — stands in for one independently-built,
// independently-deployed piece of UI that happens to share a page with
// mfe-b.js and mfe-c.js. The one thing that must be genuinely separate
// per microfrontend — for this page to be a real test and not a staged
// one — is this next line: it imports llm-coalesce from THIS
// microfrontend's own vendor mount, not a bare "llm-coalesce" specifier
// shared with anyone else on the page.
//
// /vendor/mfe-a/llm-coalesce/index.js and /vendor/mfe-b/llm-coalesce/index.js
// are different URLs serving byte-identical files (see src/server.js) — the
// browser's ES module loader treats different URLs as different module
// graphs regardless of content, so this import (and everything it
// transitively imports: adapters.js, coalescer.js, multicast.js, ...) is
// evaluated completely independently of mfe-b's and mfe-c's copies. Two
// separate `MulticastStream` classes, two separate closures inside
// windowAdapter() — nothing here is shared except what the library itself
// deliberately shares via `window`.
import { createCoalescer, windowAdapter } from "/vendor/mfe-a/llm-coalesce/index.js";
import { createSSEStream } from "./sse.js";

export const MFE_NAME = "Microfrontend A";
export { createSSEStream };

// Two coalescers, both private to this module's own top-level scope:
// - isolatedCoalescer: the default in-process adapter. Even though all
//   three microfrontends ask for the same key, each one's Map is its own —
//   proving the bug this whole page exists to demonstrate.
// - sharedCoalescer: backed by windowAdapter(), which reaches through
//   `window` — the one object all three microfrontends' separate module
//   graphs actually do share, by construction, in any real browser page.
const isolatedCoalescer = createCoalescer();
const sharedCoalescer = createCoalescer({ streamAdapter: windowAdapter() });

export function getCoalescer(mode) {
  return mode === "shared" ? sharedCoalescer : isolatedCoalescer;
}
