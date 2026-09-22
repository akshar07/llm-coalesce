// This demo's OWN local SSE-parsing helper — deliberately NOT part of
// llm-coalesce. llm-coalesce's `coalescer.stream()` accepts a thunk
// returning any AsyncIterable or ReadableStream; what produces that stream
// is entirely the caller's business, whether that's the Vercel AI SDK, the
// OpenAI or Anthropic SDKs, or — as here — a raw `fetch()` against this
// demo's own Express endpoint. Baking one specific wire format (SSE, with
// this demo's own `done`/`error`/`meta` event names) into the coalescing
// library itself would make it less useful to everyone who doesn't happen
// to talk to a server shaped exactly like this one.
//
// This file works unmodified in both the browser (served statically,
// imported by public/app.js) and Node 18+ (imported directly by
// test/integration.test.js) — it only uses `fetch`, `ReadableStream`, and
// `TextDecoder`, which both environments provide natively.

/**
 * Turns a Server-Sent Events HTTP response into a plain
 * `AsyncIterable<string>` of token deltas — the shape `coalescer.stream()`
 * expects from its thunk. Reassembles `event:`/`data:` frames across
 * network chunk boundaries by hand (no `EventSource`, which is push-based
 * and awkward to bridge into a pull-based multicast).
 *
 * @param {string} url
 * @param {{
 *   init?: RequestInit,
 *   doneEvents?: string[],
 *   errorEvents?: string[],
 *   skipEvents?: string[],
 *   parseToken?: (data: string, event: string | null) => string,
 * }} [options]
 * @returns {AsyncIterable<string>}
 */
export function createSSEStream(url, options = {}) {
  const {
    init,
    doneEvents = ["done"],
    errorEvents = ["error"],
    skipEvents = ["meta"],
    parseToken = defaultParseToken,
  } = options;

  // Fired once, immediately, no matter how many times the returned
  // iterable is iterated — matches what a single fetch() call should do.
  // Whether this function is even *called* once or N times for a group of
  // coalesced callers is decided entirely by llm-coalesce's registration
  // ordering, not by anything in here.
  const responsePromise = fetch(url, init);

  return {
    [Symbol.asyncIterator]() {
      let reader = null;
      let decoder = null;
      let buf = "";

      return {
        async next() {
          if (!reader) {
            const res = await responsePromise;
            if (!res.ok || !res.body) {
              throw new Error(`createSSEStream: request to ${url} failed with status ${res.status}`);
            }
            reader = res.body.getReader();
            decoder = new TextDecoder();
          }
          while (true) {
            const frameEnd = buf.indexOf("\n\n");
            if (frameEnd === -1) {
              const { value, done } = await reader.read();
              if (done) return { done: true, value: undefined };
              buf += decoder.decode(value, { stream: true });
              continue;
            }
            const frame = buf.slice(0, frameEnd);
            buf = buf.slice(frameEnd + 2);
            const parsed = parseFrame(frame);
            if (!parsed) continue;
            const { event, data } = parsed;
            if (event && doneEvents.includes(event)) return { done: true, value: undefined };
            if (event && errorEvents.includes(event)) throw new Error(defaultErrorMessage(data));
            if (event && skipEvents.includes(event)) continue;
            return { done: false, value: parseToken(data, event) };
          }
        },
        async return(value) {
          try {
            if (reader) {
              await reader.cancel();
            } else {
              const res = await responsePromise;
              await res.body?.cancel();
            }
          } catch {
            // Already closed or errored — nothing left to cancel.
          }
          return { value, done: true };
        },
      };
    },
  };
}

function parseFrame(frame) {
  let event = null;
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function defaultParseToken(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed === "object" && typeof parsed.token === "string") {
      return parsed.token;
    }
  } catch {
    // Not JSON — treat the raw payload as the token.
  }
  return data;
}

function defaultErrorMessage(data) {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return data || "stream error";
}
