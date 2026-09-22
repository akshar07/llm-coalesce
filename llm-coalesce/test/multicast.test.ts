import { describe, expect, it, vi } from "vitest";
import { MulticastStream } from "../src/multicast.js";
import { ControllableSource, drain, sleep } from "./test-utils.js";

describe("MulticastStream", () => {
  it("does not start the source until the first subscribe()", () => {
    const source = new ControllableSource<number>();
    new MulticastStream(source);
    expect(source.iterationCount).toBe(0);
  });

  it("starts the source exactly once even with multiple subscribers", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);

    const subA = mc.subscribe();
    const subB = mc.subscribe();
    void subA.next();
    void subB.next();
    await sleep(0);

    expect(source.iterationCount).toBe(1);
  });

  it("delivers all chunks in order to a subscriber that joins from the start", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);
    const sub = mc.subscribe();

    source.push(1);
    source.push(2);
    source.push(3);
    source.finish();

    expect(await drain(sub)).toEqual([1, 2, 3]);
  });

  it("replays buffered chunks to a late joiner, then continues live", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);

    const early = mc.subscribe();
    source.push(1);
    source.push(2);
    await sleep(0); // let the pump buffer both chunks

    // late joiner arrives after 2 chunks are already buffered
    const late = mc.subscribe();

    source.push(3);
    source.finish();

    expect(await drain(early)).toEqual([1, 2, 3]);
    expect(await drain(late)).toEqual([1, 2, 3]);
  });

  it("gives each subscriber its own cursor (a slow reader doesn't skip chunks)", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);

    const fast = mc.subscribe();
    const slow = mc.subscribe();

    source.push(1);
    source.push(2);
    source.finish();

    // fast reader drains immediately
    expect(await drain(fast)).toEqual([1, 2]);
    // slow reader starts only now, but must still see everything
    expect(await drain(slow)).toEqual([1, 2]);
  });

  it("propagates a source error to every subscriber", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);
    const subA = mc.subscribe();
    const subB = mc.subscribe();

    const err = new Error("upstream boom");
    source.push(1);
    source.fail(err);

    await expect(drain(subA)).rejects.toThrow("upstream boom");
    await expect(drain(subB)).rejects.toThrow("upstream boom");
  });

  it("calls onAbort when the last subscriber unsubscribes early, and cancels the source", async () => {
    const source = new ControllableSource<number>();
    const onAbort = vi.fn();
    const mc = new MulticastStream(source, { onAbort });

    const sub = mc.subscribe();
    source.push(1);
    await sub.next(); // consume the one chunk, source still open

    await sub.return?.();

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(source.wasCancelled()).toBe(true);
  });

  it("does NOT call onAbort if the source already finished naturally", async () => {
    const source = new ControllableSource<number>();
    const onAbort = vi.fn();
    const onSettle = vi.fn();
    const mc = new MulticastStream(source, { onAbort, onSettle });

    const sub = mc.subscribe();
    source.push(1);
    source.finish();
    await drain(sub);

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it("does not abort while other subscribers are still attached", async () => {
    const source = new ControllableSource<number>();
    const onAbort = vi.fn();
    const mc = new MulticastStream(source, { onAbort });

    const subA = mc.subscribe();
    const subB = mc.subscribe();
    source.push(1);
    await subA.next();
    await subA.return?.(); // A leaves early, B is still attached

    expect(onAbort).not.toHaveBeenCalled();
    expect(source.wasCancelled()).toBe(false);

    source.push(2);
    source.finish();
    expect(await drain(subB)).toEqual([1, 2]);
  });

  it("exposes bufferedCount, subscriberCount, and isDone", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);
    expect(mc.subscriberCount).toBe(0);

    const sub = mc.subscribe();
    expect(mc.subscriberCount).toBe(1);

    source.push(1);
    await sub.next();
    expect(mc.bufferedCount).toBe(1);
    expect(mc.isDone).toBe(false);

    source.finish();
    await drain(sub);
    expect(mc.isDone).toBe(true);
  });
});
