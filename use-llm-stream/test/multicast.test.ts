import { describe, expect, it, vi } from "vitest";
import { MulticastStream } from "../src/multicast.js";
import { ControllableSource, drain } from "./test-utils.js";

describe("MulticastStream", () => {
  it("starts the source exactly once even with multiple subscribers", async () => {
    const source = new ControllableSource<string>();
    const mc = new MulticastStream(source);

    const a = mc.subscribe();
    const b = mc.subscribe();
    void a.next();
    void b.next();
    await Promise.resolve();

    expect(source.iterationCount).toBe(1);
  });

  it("replays buffered chunks to a late joiner, then continues live", async () => {
    const source = new ControllableSource<string>();
    const mc = new MulticastStream(source);

    const early = mc.subscribe();
    source.push("Hello ");
    source.push("world");
    await Promise.resolve();
    await Promise.resolve();

    const late = mc.subscribe();
    source.push("!");
    source.finish();

    expect(await drain(early)).toEqual(["Hello ", "world", "!"]);
    expect(await drain(late)).toEqual(["Hello ", "world", "!"]);
  });

  it("propagates a source error to every subscriber", async () => {
    const source = new ControllableSource<string>();
    const mc = new MulticastStream(source);
    const a = mc.subscribe();
    const b = mc.subscribe();

    source.fail(new Error("upstream boom"));

    await expect(drain(a)).rejects.toThrow("upstream boom");
    await expect(drain(b)).rejects.toThrow("upstream boom");
  });

  it("cancels the source when the last subscriber leaves early, but not before", async () => {
    const source = new ControllableSource<string>();
    const onAbort = vi.fn();
    const mc = new MulticastStream(source, { onAbort });

    const a = mc.subscribe();
    const b = mc.subscribe();
    source.push("chunk");
    await a.next();
    await a.return?.();

    expect(onAbort).not.toHaveBeenCalled();
    expect(source.wasCancelled()).toBe(false);

    await b.return?.();
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(source.wasCancelled()).toBe(true);
  });
});
