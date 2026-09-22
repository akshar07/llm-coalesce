import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetRegistryForTests, subscribe } from "../src/registry.js";
import { ControllableSource, drain } from "./test-utils.js";

afterEach(() => {
  __resetRegistryForTests();
});

describe("subscribe — the thundering-herd case this package exists for", () => {
  it("calls fetcher once for N subscribe() calls made back-to-back with the same key", async () => {
    const source = new ControllableSource<string>();
    const fetcher = vi.fn(() => source);

    // Simulates 5 components mounting in the same render pass — all call
    // subscribe() synchronously, one after another, before any of them
    // has actually received data yet.
    const subs = Array.from({ length: 5 }, () => subscribe("doc-1", fetcher));

    source.push("The ");
    source.push("answer.");
    source.finish();

    const results = await Promise.all(subs.map((s) => drain(s)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toEqual(["The ", "answer."]);
  });

  it("does not coalesce different keys", async () => {
    const sourceA = new ControllableSource<string>();
    const sourceB = new ControllableSource<string>();
    const fetcherA = vi.fn(() => sourceA);
    const fetcherB = vi.fn(() => sourceB);

    const subA = subscribe("doc-a", fetcherA);
    const subB = subscribe("doc-b", fetcherB);
    sourceA.finish();
    sourceB.finish();
    await Promise.all([drain(subA), drain(subB)]);

    expect(fetcherA).toHaveBeenCalledTimes(1);
    expect(fetcherB).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh request for the same key once the previous one has settled", async () => {
    const first = new ControllableSource<string>();
    const second = new ControllableSource<string>();
    const fetcher = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);

    const sub1 = subscribe("doc-1", fetcher);
    first.push("a");
    first.finish();
    await drain(sub1);

    const sub2 = subscribe("doc-1", fetcher);
    second.push("b");
    second.finish();
    expect(await drain(sub2)).toEqual(["b"]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
