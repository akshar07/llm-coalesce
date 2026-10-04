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


describe.each(["return", "throw"] as const)("subscriber %s()", (method) => {
  async function close(sub: AsyncIterableIterator<number>) {
    if (method === "return") await sub.return!();
    else await expect(sub.throw!(new Error("subscriber closed"))).rejects.toThrow("subscriber closed");
  }

  it("discards unread buffered chunks without affecting another subscriber", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);
    const closed = mc.subscribe();
    const remaining = mc.subscribe();
    source.push(1);
    source.push(2);
    expect(await remaining.next()).toEqual({ value: 1, done: false });
    expect(await remaining.next()).toEqual({ value: 2, done: false });
    await close(closed);
    expect(await closed.next()).toEqual({ value: undefined, done: true });
    source.push(3);
    source.finish();
    expect(await drain(remaining)).toEqual([3]);
    expect(await closed.next()).toEqual({ value: undefined, done: true });
    expect(mc.subscriberCount).toBe(0);
  });

  it.each([false, true])("settles pending reads even when the source stays silent (other subscriber: %s)", async (withOther) => {
    const source = new ControllableSource<number>();
    const onAbort = vi.fn();
    const mc = new MulticastStream(source, { onAbort });
    const closed = mc.subscribe();
    const remaining = withOther ? mc.subscribe() : undefined;
    const pending = [closed.next(), closed.next()];
    await close(closed);
    // No source events occur before these pending reads must settle.
    expect(await Promise.all(pending)).toEqual([
      { value: undefined, done: true }, { value: undefined, done: true },
    ]);
    await close(closed);
    expect(mc.subscriberCount).toBe(withOther ? 1 : 0);
    expect(onAbort).toHaveBeenCalledTimes(withOther ? 0 : 1);
    source.push(7);
    source.finish();
    if (remaining) expect(await drain(remaining)).toEqual([7]);
    expect(await closed.next()).toEqual({ value: undefined, done: true });
  }, 1000);

  it("does not deliver a later upstream error to a closed subscriber", async () => {
    const source = new ControllableSource<number>();
    const mc = new MulticastStream(source);
    const closed = mc.subscribe();
    const remaining = mc.subscribe();
    await close(closed);
    source.fail(new Error("upstream failed"));
    await expect(remaining.next()).rejects.toThrow("upstream failed");
    expect(await closed.next()).toEqual({ value: undefined, done: true });
    expect(await remaining.next()).toEqual({ value: undefined, done: true });
  });
});
