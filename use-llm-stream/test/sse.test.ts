import { afterEach, describe, expect, it, vi } from "vitest";
import { createSSEStream } from "../src/sse.js";
import { __resetRegistryForTests, subscribe } from "../src/registry.js";
import { drain } from "./test-utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRegistryForTests();
});

function sseResponse(frames: string[], opts: { onCancel?: () => void } = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
    cancel() {
      opts.onCancel?.();
    },
  });
  return new Response(body, { status: 200 });
}

describe("createSSEStream — parsing a real HTTP response into tokens", () => {
  it("yields tokens from data: frames and stops at a done event", async () => {
    const frames = [
      'event: meta\ndata: {"requestId":1}\n\n',
      'data: {"token":"Hello"}\n\n',
      'data: {"token":" world"}\n\n',
      "event: done\ndata: {}\n\n",
    ];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse(frames))));

    const out = await drain(createSSEStream("http://example.test/stream"));
    expect(out).toEqual(["Hello", " world"]);
  });

  it("skips configured bookkeeping events by default (meta)", async () => {
    const frames = ['event: meta\ndata: {"anything":true}\n\n', 'data: {"token":"ok"}\n\n', "event: done\ndata: {}\n\n"];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse(frames))));

    expect(await drain(createSSEStream("http://example.test/stream"))).toEqual(["ok"]);
  });

  it("throws using the error event's message", async () => {
    const frames = ['event: error\ndata: {"message":"boom"}\n\n'];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse(frames))));

    await expect(drain(createSSEStream("http://example.test/stream"))).rejects.toThrow("boom");
  });

  it("falls back to the raw payload for a non-JSON, non-token server", async () => {
    const frames = ["data: plain-text-chunk\n\n", "event: done\ndata: end\n\n"];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse(frames))));

    expect(await drain(createSSEStream("http://example.test/stream"))).toEqual(["plain-text-chunk"]);
  });

  it("respects custom doneEvents/skipEvents/parseToken for a different server contract", async () => {
    const frames = ['event: chunk\ndata: {"delta":"A"}\n\n', 'event: chunk\ndata: {"delta":"B"}\n\n', "event: complete\ndata: {}\n\n"];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse(frames))));

    const out = await drain(
      createSSEStream("http://example.test/stream", {
        doneEvents: ["complete"],
        skipEvents: [],
        parseToken: (data) => JSON.parse(data).delta,
      }),
    );
    expect(out).toEqual(["A", "B"]);
  });

  it("cancels the underlying reader when abandoned mid-stream", async () => {
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          sseResponse(['data: {"token":"a"}\n\n', 'data: {"token":"b"}\n\n'], { onCancel: () => (cancelled = true) }),
        ),
      ),
    );

    const stream = createSSEStream("http://example.test/stream");
    const it = stream[Symbol.asyncIterator]();
    await it.next();
    await it.return?.();
    expect(cancelled).toBe(true);
  });

  it("composes with subscribe(): N concurrent callers still trigger exactly one fetch()", async () => {
    let cancelled = false;
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sseResponse(['data: {"token":"The "}\n\n', 'data: {"token":"answer."}\n\n', "event: done\ndata: {}\n\n"], {
          onCancel: () => (cancelled = true),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const subs = [1, 2, 3].map(() => subscribe("doc-1", () => createSSEStream("http://example.test/stream")));
    const results = await Promise.all(subs.map(drain));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.join("") === "The answer.")).toBe(true);
    expect(cancelled).toBe(false); // stream ran to completion; nothing should be cancelled
  });
});
