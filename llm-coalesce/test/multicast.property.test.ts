import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MulticastStream } from "../src/multicast.js";
import { ControllableSource, drain } from "./test-utils.js";

/** Flush pending microtasks (the pump loop hops through a couple of them
 * between a push() and the buffer actually growing) without the overhead
 * of a real timer — matters here since fast-check runs this many times. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe("MulticastStream — property: every subscriber sees every chunk, in order", () => {
  it("holds for subscribers joining at arbitrary offsets into an arbitrary stream", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer(), { minLength: 0, maxLength: 25 }),
        fc.array(fc.nat({ max: 25 }), { minLength: 1, maxLength: 6 }),
        async (chunks, rawOffsets) => {
          const source = new ControllableSource<number>();
          const mc = new MulticastStream(source);

          // Clamp each subscriber's join offset into [0, chunks.length] and
          // group subscribers by the offset they join at.
          const offsets = rawOffsets.map((o) => Math.min(o, chunks.length));
          const byOffset = new Map<number, ReturnType<typeof mc.subscribe>[]>();
          for (const offset of offsets) {
            const subs = byOffset.get(offset) ?? [];
            subs.push(mc.subscribe());
            byOffset.set(offset, subs);
          }

          const allSubs: ReturnType<typeof mc.subscribe>[] = [...(byOffset.get(0) ?? [])];

          for (let i = 0; i < chunks.length; i++) {
            source.push(chunks[i] as number);
            await tick();
            const joiners = byOffset.get(i + 1);
            if (joiners) allSubs.push(...joiners);
          }
          source.finish();

          const results = await Promise.all(allSubs.map((s) => drain(s)));
          for (const result of results) {
            expect(result).toEqual(chunks);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
