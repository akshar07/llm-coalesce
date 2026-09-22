import { describe, expect, it, vi } from "vitest";
import { createCoalescer } from "../src/coalescer.js";
import { drain } from "./test-utils.js";

/** Simulates a provider's SSE response as a ReadableStream, the shape a raw
 * `fetch()` body reader gives you — distinct from the AsyncIterable shape
 * (e.g. the Vercel AI SDK's `textStream`) exercised in coalescer.stream.test.ts. */
function makeSseStream(tokens: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const t of tokens) controller.enqueue(t);
      controller.close();
    },
  });
}

describe("integration: mock provider, ReadableStream shape", () => {
  it("N concurrent widgets requesting the same completion produce exactly one upstream call", async () => {
    const coalescer = createCoalescer();
    const tokens = ["This ", "agreement ", "renews ", "annually."];
    const provider = vi.fn(() => makeSseStream(tokens));

    const request = { docId: "env-123", intent: "summarize" };
    const WIDGET_COUNT = 10;

    // All ten "widgets" call in the same tick, the way independently
    // mounted components would on the same page render.
    const subs = await Promise.all(
      Array.from({ length: WIDGET_COUNT }, () => coalescer.stream(request, provider)),
    );
    const results = await Promise.all(subs.map((s) => drain(s)));

    expect(provider).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual(tokens);
    }
  });

  it("a widget mounting mid-stream still gets the full document via replay", async () => {
    const coalescer = createCoalescer();
    const tokens = ["a", "b", "c", "d", "e"];
    const provider = vi.fn(() => makeSseStream(tokens));

    const sub1 = await coalescer.stream("doc-1", provider);
    const result1Promise = drain(sub1);

    // A second widget mounts after the first has already started reading —
    // the underlying ReadableStream is still only read once.
    const sub2 = await coalescer.stream("doc-1", provider);
    const result2Promise = drain(sub2);

    expect(await result1Promise).toEqual(tokens);
    expect(await result2Promise).toEqual(tokens);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
