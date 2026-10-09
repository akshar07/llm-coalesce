// @vitest-environment jsdom
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoalescer, type Coalescer } from "../src/coalescer.js";
import { useLlmStream } from "../src/react.js";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function controlled() {
  let pending = deferred<IteratorResult<string>>();
  const iterator: AsyncIterableIterator<string> = {
    [Symbol.asyncIterator]() { return this; },
    next: vi.fn(() => pending.promise),
    return: vi.fn(async (): Promise<IteratorResult<string>> => { pending.resolve({ done: true, value: undefined }); return { done: true, value: undefined }; }),
  };
  return {
    iterator,
    async send(value: string) {
      await act(async () => {
        const previous = pending;
        pending = deferred();
        previous.resolve({ done: false, value });
      });
    },
    async end() { await act(async () => { pending.resolve({ done: true, value: undefined }); }); },
  };
}

describe("useLlmStream", () => {
  it("does not subscribe during server rendering", () => {
    const coalescer = createCoalescer();
    const fetcher = vi.fn(async function* () { yield "hello"; });
    function Component() {
      return createElement("p", null, useLlmStream("key", fetcher, { coalescer }).status);
    }
    expect(renderToString(createElement(Component))).toBe("<p>loading</p>");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts a promised ReadableStream and completes an empty stream", async () => {
    const coalescer = createCoalescer();
    const fetcher = async () => new ReadableStream<string>({ start(controller) {
      controller.enqueue("hello"); controller.close();
    } });
    const first = renderHook(() => useLlmStream("readable", fetcher, { coalescer }));
    await waitFor(() => expect(first.result.current).toMatchObject({ text: "hello", status: "done" }));
    const second = renderHook(() => useLlmStream("empty", async function* () {}, { coalescer }));
    await waitFor(() => expect(second.result.current).toMatchObject({ text: "", status: "done" }));
  });

  it("shares a live source, accumulates text and replays to a late component", async () => {
    const coalescer = createCoalescer();
    const source = controlled();
    const fetcher = vi.fn(() => source.iterator);
    const first = renderHook(() => useLlmStream("key", fetcher, { coalescer }));
    expect(first.result.current.status).toBe("loading");
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await source.send("Hello");
    await waitFor(() => expect(first.result.current).toMatchObject({ text: "Hello", status: "streaming" }));
    const second = renderHook(() => useLlmStream("key", fetcher, { coalescer }));
    await waitFor(() => expect(second.result.current.text).toBe("Hello"));
    first.unmount();
    expect(source.iterator.return).not.toHaveBeenCalled();
    await source.send(" world");
    await source.end();
    await waitFor(() => expect(second.result.current).toEqual({ text: "Hello world", status: "done", error: undefined }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("releases the source when the last component unmounts", async () => {
    const coalescer = createCoalescer();
    const source = controlled();
    const hook = renderHook(() => useLlmStream("key", () => source.iterator, { coalescer }));
    await waitFor(() => expect(source.iterator.next).toHaveBeenCalled());
    hook.unmount();
    await waitFor(() => expect(source.iterator.return).toHaveBeenCalledTimes(1));
  });

  it("does not restart on inline fetcher/options churn; uses the latest factory for a new key", async () => {
    const coalescer = createCoalescer();
    const a = controlled();
    const b = controlled();
    const fa = vi.fn(() => a.iterator);
    const fb = vi.fn(() => b.iterator);
    const hook = renderHook(({ key, fetcher }) => useLlmStream(key, () => fetcher(), { coalescer }), { initialProps: { key: "a", fetcher: fa } });
    await waitFor(() => expect(fa).toHaveBeenCalledTimes(1));
    await a.send("old");
    hook.rerender({ key: "a", fetcher: fb });
    expect(fb).not.toHaveBeenCalled();
    hook.rerender({ key: "b", fetcher: fb });
    expect(hook.result.current.text).toBe("");
    await waitFor(() => expect(fb).toHaveBeenCalledTimes(1));
    await b.send("new");
    expect(hook.result.current.text).toBe("new");
    expect(a.iterator.return).toHaveBeenCalledTimes(1);
  });

  it("resubscribes when the coalescer changes", async () => {
    const a = controlled();
    const b = controlled();
    const fetcher = vi.fn().mockReturnValueOnce(a.iterator).mockReturnValueOnce(b.iterator);
    const hook = renderHook(({ coalescer }) => useLlmStream("same", fetcher, { coalescer }), { initialProps: { coalescer: createCoalescer() } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    hook.rerender({ coalescer: createCoalescer() });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(a.iterator.return).toHaveBeenCalledTimes(1);
    await b.send("replacement");
    expect(hook.result.current.text).toBe("replacement");
  });

  it("retains partial text when the source fails", async () => {
    const error = new Error("provider failed");
    const coalescer = createCoalescer();
    async function* source() { yield "partial"; throw error; }
    const hook = renderHook(() => useLlmStream("key", source, { coalescer }));
    await waitFor(() => expect(hook.result.current).toEqual({ text: "partial", status: "error", error }));
  });

  it("handles a rejected subscription", async () => {
    const error = new Error("subscribe failed");
    const coalescer: Coalescer = { ...createCoalescer(), stream: vi.fn().mockRejectedValue(error) };
    const hook = renderHook(() => useLlmStream("key", async function* () {}, { coalescer }));
    await waitFor(() => expect(hook.result.current).toEqual({ text: "", status: "error", error }));
  });

  it("closes a subscription that resolves after unmount without reading it", async () => {
    const pending = deferred<AsyncIterableIterator<string>>();
    const source = controlled();
    const coalescer: Coalescer = { ...createCoalescer(), stream: vi.fn().mockReturnValue(pending.promise) };
    const hook = renderHook(() => useLlmStream("key", () => source.iterator, { coalescer }));
    hook.unmount();
    await act(async () => { pending.resolve(source.iterator); });
    expect(source.iterator.return).toHaveBeenCalledTimes(1);
    expect(source.iterator.next).not.toHaveBeenCalled();
  });

  it("ignores a stale pending read after the key changes, even if return rejects", async () => {
    const stale = deferred<IteratorResult<string>>();
    const old: AsyncIterableIterator<string> = {
      [Symbol.asyncIterator]() { return this; },
      next: vi.fn(() => stale.promise),
      return: vi.fn().mockRejectedValue(new Error("cleanup failed")),
    };
    const fresh = controlled();
    const coalescer: Coalescer = { ...createCoalescer(), stream: vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(fresh.iterator) };
    const hook = renderHook(({ key }) => useLlmStream(key, () => fresh.iterator, { coalescer }), { initialProps: { key: "old" } });
    await waitFor(() => expect(old.next).toHaveBeenCalled());
    hook.rerender({ key: "new" });
    await waitFor(() => expect(fresh.iterator.next).toHaveBeenCalled());
    await fresh.send("fresh");
    await act(async () => { stale.resolve({ done: false, value: "stale" }); });
    expect(hook.result.current.text).toBe("fresh");
    expect(old.return).toHaveBeenCalledTimes(1);
  });

  it("balances subscriptions under Strict Mode effect replay", async () => {
    const sources: ReturnType<typeof controlled>[] = [];
    const coalescer: Coalescer = { ...createCoalescer(), stream: vi.fn(() => {
      const source = controlled(); sources.push(source); return Promise.resolve(source.iterator);
    }) as Coalescer["stream"] };
    const hook = renderHook(() => useLlmStream("key", async function* () {}, { coalescer }), {
      reactStrictMode: true,
    });
    await waitFor(() => expect(sources).toHaveLength(2));
    expect(sources[0]!.iterator.return).toHaveBeenCalledTimes(1);
    expect(sources[0]!.iterator.next).not.toHaveBeenCalled();
    await sources[1]!.send("active");
    expect(hook.result.current.text).toBe("active");
    hook.unmount();
    expect(sources[1]!.iterator.return).toHaveBeenCalledTimes(1);
  });
});
