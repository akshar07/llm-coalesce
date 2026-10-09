"use client";

import { useEffect, useRef, useState } from "react";
import type { Coalescer } from "./coalescer.js";

export type StreamStatus = "loading" | "streaming" | "done" | "error";
export type StreamFetcher = () =>
  | AsyncIterable<string>
  | ReadableStream<string>
  | Promise<AsyncIterable<string> | ReadableStream<string>>;

export interface UseLlmStreamOptions {
  /** Reuse the same instance across components that should share requests. */
  coalescer: Coalescer;
}

export interface UseLlmStreamResult {
  text: string;
  status: StreamStatus;
  error: unknown;
}

/** Stream text into React state. Changing the key or coalescer resubscribes;
 * changing only the fetcher does not. Include all response-affecting inputs in key. */
export function useLlmStream(
  key: string,
  fetcher: StreamFetcher,
  { coalescer }: UseLlmStreamOptions,
): UseLlmStreamResult {
  const [state, setState] = useState<UseLlmStreamResult>({
    text: "", status: "loading", error: undefined,
  });
  const fetcherRef = useRef(fetcher);
  // Commit the factory before subscribing, without restarting for inline closures.
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  useEffect(() => {
    let cancelled = false;
    let subscription: AsyncIterableIterator<string> | undefined;
    let returned = false;
    let text = "";
    const factory = fetcherRef.current;
    setState({ text, status: "loading", error: undefined });

    const close = async () => {
      if (!subscription || returned) return;
      returned = true;
      try {
        await subscription.return?.();
      } catch {
        // Cleanup must not create an unhandled rejection after unmount.
      }
    };

    void (async () => {
      try {
        subscription = await coalescer.stream(key, factory);
        if (cancelled) return;
        while (!cancelled) {
          const chunk = await subscription.next();
          if (cancelled) return;
          if (chunk.done) {
            setState({ text, status: "done", error: undefined });
            return;
          }
          text += chunk.value;
          setState({ text, status: "streaming", error: undefined });
        }
      } catch (error) {
        if (!cancelled) setState({ text, status: "error", error });
      } finally {
        await close();
      }
    })();

    return () => {
      cancelled = true;
      void close();
    };
  }, [key, coalescer]);

  return state;
}
