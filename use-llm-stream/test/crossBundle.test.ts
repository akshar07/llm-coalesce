import { describe, expect, it, vi } from "vitest";
import { __resetRegistryForTests, subscribe } from "../src/registry.js";
import { ControllableSource, drain } from "./test-utils.js";

/**
 * `subscribe()` is backed by a `globalThis`-scoped registry unconditionally
 * — see registry.ts's doc comment. These tests simulate "two independently
 * bundled microfrontends" the way a real page actually produces them: two
 * genuinely separate module instances of the identical source file. Vite
 * (which vitest runs on) treats a distinct query string as a distinct
 * module — importing the same path with `?bundle=a` vs `?bundle=b`
 * re-evaluates the file twice, giving each its own top-level state, the
 * same isolation two separate webpack/esbuild builds would produce. Only
 * `globalThis` — not either module's own scope — can bridge that gap,
 * which is exactly the mechanism under test here.
 */

describe("cross-bundle coalescing via the shared default namespace", () => {
  it("two separately-bundled copies still coalesce, with no namespace argument at all", async () => {
    // @ts-expect-error -- Vite-only module-identity suffix; TS has no
    // notion of it, but the isolation it produces is real (see comment
    // above), not a simulation of a simulation.
    const copyA = await import("../src/registry.js?bundle=a");
    // @ts-expect-error -- see comment above
    const copyB = await import("../src/registry.js?bundle=b");

    const source = new ControllableSource<string>();
    const fetcher = vi.fn(() => source);

    const subA = copyA.subscribe("shared-key", fetcher);
    const subB = copyB.subscribe("shared-key", fetcher);
    source.push("x");
    source.finish();
    const [resultA, resultB] = await Promise.all([drain(subA), drain(subB)]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.iterationCount).toBe(1);
    expect(resultA).toEqual(["x"]);
    expect(resultB).toEqual(["x"]);

    copyA.__resetRegistryForTests();
  });

  it("an explicit namespace still isolates from the shared default", async () => {
    const sources: ControllableSource<string>[] = [];
    const fetcher = vi.fn(() => {
      const s = new ControllableSource<string>();
      s.finish();
      sources.push(s);
      return s;
    });

    await drain(subscribe("shared-key", fetcher)); // default namespace
    await drain(subscribe("shared-key", fetcher, { namespace: "acme-checkout" }));

    // Same key, but one call used the default namespace and the other an
    // explicit one — they must not have coalesced with each other.
    expect(fetcher).toHaveBeenCalledTimes(2);

    __resetRegistryForTests();
    __resetRegistryForTests("acme-checkout");
  });

  it("two different explicit namespaces never coalesce, even with the identical key", async () => {
    const makeFinishedSource = () => {
      const s = new ControllableSource<string>();
      s.finish();
      return s;
    };
    const fetcher1 = vi.fn(makeFinishedSource);
    const fetcher2 = vi.fn(makeFinishedSource);

    await drain(subscribe("same-key", fetcher1, { namespace: "app-one" }));
    await drain(subscribe("same-key", fetcher2, { namespace: "app-two" }));

    expect(fetcher1).toHaveBeenCalledTimes(1);
    expect(fetcher2).toHaveBeenCalledTimes(1);

    __resetRegistryForTests("app-one");
    __resetRegistryForTests("app-two");
  });

  it("rejects an explicit empty-string namespace rather than silently falling back", () => {
    expect(() => subscribe("k", () => new ControllableSource<string>(), { namespace: "" })).toThrow(/namespace/);
  });
});
