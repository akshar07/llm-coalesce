import { describe, expect, it } from "vitest";
import { stableHash } from "../src/key.js";

describe("stableHash", () => {
  it("is order-independent for object keys", () => {
    const a = stableHash({ model: "x", messages: [1, 2], maxTokens: 500 });
    const b = stableHash({ maxTokens: 500, messages: [1, 2], model: "x" });
    expect(a).toBe(b);
  });

  it("distinguishes requests that differ only in params", () => {
    const a = stableHash({ model: "x", maxTokens: 500 });
    const b = stableHash({ model: "x", maxTokens: 800 });
    expect(a).not.toBe(b);
  });

  it("distinguishes different message content", () => {
    const a = stableHash({ messages: ["explain clause 7"] });
    const b = stableHash({ messages: ["explain clause 8"] });
    expect(a).not.toBe(b);
  });

  it("is stable across repeated calls", () => {
    const req = { model: "x", messages: ["a", "b"], nested: { c: 1, d: 2 } };
    expect(stableHash(req)).toBe(stableHash(req));
  });

  it("distinguishes nested key order the same way as top level", () => {
    const a = stableHash({ opts: { a: 1, b: 2 } });
    const b = stableHash({ opts: { b: 2, a: 1 } });
    expect(a).toBe(b);
  });
});


describe("collision-safe keys", () => {
  it("distinguishes requests that collided under the old 32-bit hash", () => {
    expect(stableHash({ prompt: "Aa" })).not.toBe(stableHash({ prompt: "B@" }));
  });

  it.each([undefined, NaN, Infinity, 1n, () => 1, Symbol("key"), new Date(), new Map(), [, 1]])(
    "rejects unsupported request values: %s", (value) => {
      expect(() => stableHash({ value })).toThrow(TypeError);
    },
  );

  it("rejects cycles but accepts repeated references", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => stableHash(cycle)).toThrow(/cycles/);
    const shared = { a: 1 };
    expect(stableHash({ x: shared, y: shared })).toBe(stableHash({ x: { a: 1 }, y: { a: 1 } }));
  });
});
