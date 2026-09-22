import { describe, expect, it, vi } from "vitest";
import { createCoalescer } from "../src/coalescer.js";
import { sleep } from "./test-utils.js";

describe("Coalescer.run", () => {
  it("invokes fn once for concurrent calls with the same key", async () => {
    const coalescer = createCoalescer();
    const fn = vi.fn(async () => {
      await sleep(5);
      return "result";
    });

    const [a, b, c] = await Promise.all([
      coalescer.run("key-1", fn),
      coalescer.run("key-1", fn),
      coalescer.run("key-1", fn),
    ]);

    expect(fn).toHaveBeenCalledTimes(1);
    expect([a, b, c]).toEqual(["result", "result", "result"]);
  });

  it("does not coalesce calls with different keys", async () => {
    const coalescer = createCoalescer();
    const fn = vi.fn(async () => "result");

    await Promise.all([coalescer.run("a", fn), coalescer.run("b", fn)]);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("hashes object requests, so same fields (any order) coalesce and different params don't", async () => {
    const coalescer = createCoalescer();
    const fn = vi.fn(async () => "result");

    await Promise.all([
      coalescer.run({ model: "x", maxTokens: 500 }, fn),
      coalescer.run({ maxTokens: 500, model: "x" }, fn),
    ]);
    expect(fn).toHaveBeenCalledTimes(1);

    await coalescer.run({ model: "x", maxTokens: 800 }, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("invokes fn again after the previous call settles (in-flight dedup, not a result cache)", async () => {
    const coalescer = createCoalescer();
    const fn = vi.fn(async () => "result");

    await coalescer.run("key-1", fn);
    await coalescer.run("key-1", fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates a rejection to every attached caller, then clears the key", async () => {
    const coalescer = createCoalescer();
    const err = new Error("boom");
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw err;
      return "ok";
    });

    const results = await Promise.allSettled([
      coalescer.run("key-1", fn),
      coalescer.run("key-1", fn),
    ]);
    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!.status).toBe("rejected");
    expect(fn).toHaveBeenCalledTimes(1);

    // key was cleared on settle, even though it failed — next call retries
    const ok = await coalescer.run("key-1", fn);
    expect(ok).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});


it("does not merge colliding prompts or literal string keys with object keys", async () => {
  const coalescer = createCoalescer();
  const requests = [{ prompt: "Aa" }, { prompt: "B@" }, '{"prompt":"Aa"}'];
  const results = await Promise.all(requests.map((request, i) =>
    coalescer.run(request, async () => i),
  ));
  expect(results).toEqual([0, 1, 2]);
});
