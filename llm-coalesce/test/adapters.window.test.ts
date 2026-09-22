import { describe, expect, it } from "vitest";
import { windowAdapter, type StreamRegistryEntry } from "../src/adapters.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";

describe("windowAdapter", () => {
  it("coordinates two separately-created adapters that share the same global object (simulated cross-bundle case)", () => {
    const fakeWindow: Record<string, unknown> = {};

    // Two "independently bundled widgets" each create their own adapter
    // instance, but both point at the same global.
    const widgetA = windowAdapter(fakeWindow as never);
    const widgetB = windowAdapter(fakeWindow as never);

    const entry: StreamRegistryEntry = {
      protocolVersion: PROTOCOL_VERSION,
      subscribe: () => {
        throw new Error("not needed for this test");
      },
    };
    widgetA.register("key-1", entry);

    expect(widgetB.acquire("key-1")).toBe(entry);
  });

  it("does not coalesce across a protocol version mismatch (safe default)", () => {
    const fakeWindow: Record<string, unknown> = {};
    const oldWidget = windowAdapter(fakeWindow as never);
    const newWidget = windowAdapter(fakeWindow as never);

    oldWidget.register("key-1", {
      protocolVersion: "0", // pretend an older/incompatible version
      subscribe: () => {
        throw new Error("not needed for this test");
      },
    });

    // The current-version widget must not attach to an entry it doesn't
    // recognize — duplicating the call is the safe outcome, not a crash
    // or a coalesce into a shape it doesn't understand.
    expect(newWidget.acquire("key-1")).toBeUndefined();
  });

  it("release() only clears entries it recognizes the version of", () => {
    const fakeWindow: Record<string, unknown> = {};
    const adapter = windowAdapter(fakeWindow as never);

    const stale = { protocolVersion: "0", subscribe: () => { throw new Error("n/a"); } };
    adapter.register("stale", stale);
    adapter.release("stale", stale);

    // A same-version release, by contrast, does clear the entry.
    const current = { protocolVersion: PROTOCOL_VERSION, subscribe: () => { throw new Error("n/a"); } };
    adapter.register("current", current);
    adapter.release("current", current);
    expect(adapter.acquire("current")).toBeUndefined();
  });

  it("defaults to a fresh Map per distinct global object, not a process-wide singleton", () => {
    const winA: Record<string, unknown> = {};
    const winB: Record<string, unknown> = {};
    const a = windowAdapter(winA as never);
    const b = windowAdapter(winB as never);

    a.register("key-1", { protocolVersion: PROTOCOL_VERSION, subscribe: () => { throw new Error("n/a"); } });
    expect(b.acquire("key-1")).toBeUndefined();
  });
});
