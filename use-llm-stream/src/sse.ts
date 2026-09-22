/**
 * Turns a Server-Sent Events HTTP response into the plain
 * `AsyncIterable<string>` shape `subscribe()` / `useLlmStream()` expect
 * from a fetcher — the piece that was missing to point this package at a
 * real backend instead of an in-memory mock stream.
 *
 * `fetch()`'s `response.body` is a pull-based `ReadableStream` of raw
 * bytes, which is exactly the shape `MulticastStream`'s pump loop wants
 * (`await reader.next()`, one value at a time) — no push-to-pull adapter
 * needed the way you'd need one for `EventSource`. The only real work is
 * reassembling bytes into frames: a chunk boundary from the network has
 * no relationship to a message boundary in the stream, so partial text is
 * buffered until a complete `"event: ...\ndata: ...\n\n"` frame appears.
 *
 * `return()` (called by `MulticastStream`'s refcounted abort, once the
 * *last* subscriber has left) calls `reader.cancel()` — or, if abort
 * happens before the response has even arrived, cancels the response body
 * once it does — so an abandoned coalesced stream actually tears down the
 * underlying connection instead of finishing unread in the background.
 */
export interface CreateSSEStreamOptions {
  /** Passed straight through to `fetch()`. */
  init?: RequestInit;
  /** Event names that end the stream normally. Default: `["done"]`. */
  doneEvents?: string[];
  /**
   * Event names that end the stream with an error. Each one's `data` is
   * parsed as JSON and its `.message` field used as the thrown `Error`'s
   * message, falling back to the raw payload. Default: `["error"]`.
   */
  errorEvents?: string[];
  /**
   * Event names carrying bookkeeping rather than tokens, silently
   * dropped. Default: `["meta"]`.
   */
  skipEvents?: string[];
  /**
   * Extracts the token to yield from an event's raw `data:` payload.
   * Default: parse the payload as JSON and return its `.token` field,
   * falling back to the raw payload for non-JSON servers.
   */
  parseToken?: (data: string, event: string | null) => string;
}

interface ParsedFrame {
  event: string | null;
  data: string;
}

function parseFrame(frame: string): ParsedFrame | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

function defaultParseToken(data: string): string {
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

function defaultErrorMessage(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    // Not JSON.
  }
  return data || "stream error";
}

export function createSSEStream(url: string, options: CreateSSEStreamOptions = {}): AsyncIterable<string> {
  const {
    init,
    doneEvents = ["done"],
    errorEvents = ["error"],
    skipEvents = ["meta"],
    parseToken = defaultParseToken,
  } = options;

  // Fired once, immediately, no matter how many times the returned
  // iterable is iterated — matches what a single `fetch()` call should
  // do. (Whether this function is even *called* once or N times for a
  // group of coalesced callers is decided entirely by `subscribe()`'s
  // lazy registration, not by anything in here.)
  const responsePromise = fetch(url, init);

  return {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let decoder: TextDecoder | null = null;
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
              buf += decoder!.decode(value, { stream: true });
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
        async return(value?: unknown) {
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
          return { value: value as string, done: true };
        },
      };
    },
  };
}
