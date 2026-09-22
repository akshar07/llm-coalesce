import { describe, expect, it, vi } from "vitest";
import { memoryAdapter, windowAdapter } from "../src/adapters.js";
import { createCoalescer } from "../src/coalescer.js";
import { ControllableSource, drain, sleep } from "./test-utils.js";

/** A thunk factory that counts how many times it was invoked and how many
 * times the AsyncIterable it returns was actually iterated — the two
 * differ if a caller creates a source but nothing ever consumes it. */
function makeThunk() {
  const sources: ControllableSource<string>[] = [];
  const thunk = vi.fn(() => {
    const source = new ControllableSource<string>();
    sources.push(source);
    return source;
  });
  return { thunk, sources };
}

describe("Coalescer.stream — the core scenario this package exists for", () => {
  it("three independently-triggered callers for the same completion share one upstream call", async () => {
    const coalescer = createCoalescer();
    const { thunk, sources } = makeThunk();
    const request = { model: "x", messages: ["explain clause 7"] };

    // Widget A subscribes first.
    const subA = await coalescer.stream(request, thunk);
    sources[0]!.push("The ");
    await sleep(0);

    // Widget B subscribes 40ms "later" — same request.
    const subB = await coalescer.stream(request, thunk);

    sources[0]!.push("liability ");
    sources[0]!.push("clause is uncapped.");
    sources[0]!.finish();

    // Widget C subscribes after the stream has already finished.
    const subC = await coalescer.stream(request, thunk);

    const [a, b, c] = await Promise.all([drain(subA), drain(subB), drain(subC)]);

    expect(thunk).toHaveBeenCalledTimes(1);
    const full = ["The ", "liability ", "clause is uncapped."];
    expect(a).toEqual(full);
    expect(b).toEqual(full); // late joiner: buffered replay then live
    expect(c).toEqual(full); // joined after completion: full replay
  });

  it("does not coalesce requests with different keys", async () => {
    const coalescer = createCoalescer();
    const { thunk, sources } = makeThunk();

    const subA = await coalescer.stream({ clauseId: 7 }, thunk);
    const subB = await coalescer.stream({ clauseId: 8 }, thunk);
    sources[0]!.finish();
    sources[1]!.finish();
    await Promise.all([drain(subA), drain(subB)]);

    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh upstream call for the same key once the previous stream has settled", async () => {
    const coalescer = createCoalescer();
    const { thunk, sources } = makeThunk();

    const first = await coalescer.stream("key-1", thunk);
    sources[0]!.push("a");
    sources[0]!.finish();
    await drain(first);

    const second = await coalescer.stream("key-1", thunk);
    sources[1]!.push("b");
    sources[1]!.finish();
    expect(await drain(second)).toEqual(["b"]);

    expect(thunk).toHaveBeenCalledTimes(2);
  });

  it("cancels the upstream source when every subscriber unsubscribes before completion", async () => {
    const coalescer = createCoalescer();
    const { thunk, sources } = makeThunk();

    const sub = await coalescer.stream("key-1", thunk);
    sources[0]!.push("a");
    await sub.next();
    await sub.return?.();

    expect(sources[0]!.wasCancelled()).toBe(true);

    // key was released on abort, so the next call re-invokes the thunk
    const again = await coalescer.stream("key-1", thunk);
    sources[1]!.push("fresh");
    sources[1]!.finish();
    expect(await drain(again)).toEqual(["fresh"]);
    expect(thunk).toHaveBeenCalledTimes(2);
  });
});


it("keeps previously colliding prompts on separate live streams", async () => {
  const coalescer = createCoalescer();
  const a = new ControllableSource<string>();
  const b = new ControllableSource<string>();
  const first = await coalescer.stream({ prompt: "Aa" }, () => a);
  const second = await coalescer.stream({ prompt: "B@" }, () => b);
  a.push("first");
  b.push("second");
  a.finish();
  b.finish();
  expect(await Promise.all([drain(first), drain(second)])).toEqual([["first"], ["second"]]);
});


describe.each(["memory", "window"] as const)("%s registry ownership", (kind) => {
  it.each(["completion", "error"] as const)("preserves a replacement after cancelled source's delayed %s", async (settlement) => {
    const host = {};
    const adapter = kind === "memory" ? memoryAdapter() : windowAdapter(host);
    const firstClient = createCoalescer({ streamAdapter: adapter });
    const nextClient = createCoalescer({
      streamAdapter: kind === "memory" ? adapter : windowAdapter(host),
    });
    const oldSource = new ControllableSource<string>();
    const first = await firstClient.stream("shared", () => oldSource);
    oldSource.push("old");
    await first.next();
    await first.return?.();

    const replacement = new ControllableSource<string>();
    const replacementFactory = vi.fn(() => replacement);
    const second = await nextClient.stream("shared", replacementFactory);

    // Cancellation requested return(), but the old pending next() settles later.
    if (settlement === "completion") oldSource.finish();
    else oldSource.fail(new Error("late failure"));
    await sleep(0);

    const unexpectedFactory = vi.fn(() => new ControllableSource<string>());
    const third = await firstClient.stream("shared", unexpectedFactory);
    expect(unexpectedFactory).not.toHaveBeenCalled();
    expect(replacementFactory).toHaveBeenCalledTimes(1);
    replacement.push("new");
    replacement.finish();
    expect(await Promise.all([drain(second), drain(third)])).toEqual([["new"], ["new"]]);

    // The replacement's own completion still releases the key.
    const freshSource = new ControllableSource<string>();
    const freshFactory = vi.fn(() => freshSource);
    const fresh = await nextClient.stream("shared", freshFactory);
    expect(freshFactory).toHaveBeenCalledTimes(1);
    freshSource.finish();
    await drain(fresh);
  });
});
