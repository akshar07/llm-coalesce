// "Microfrontend C" — see mfe-a.js's header comment for the full
// explanation of why this file's llm-coalesce import (and only this
// import) has to point at its own vendor mount for this page to be a real
// cross-bundle test rather than a staged one.
import { createCoalescer, windowAdapter } from "/vendor/mfe-c/llm-coalesce/index.js";
import { createSSEStream } from "./sse.js";

export const MFE_NAME = "Microfrontend C";
export { createSSEStream };

const isolatedCoalescer = createCoalescer();
const sharedCoalescer = createCoalescer({ streamAdapter: windowAdapter() });

export function getCoalescer(mode) {
  return mode === "shared" ? sharedCoalescer : isolatedCoalescer;
}
