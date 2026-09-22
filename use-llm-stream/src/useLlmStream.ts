import { useEffect, useRef, useState } from "react";
import { subscribe, type Fetcher, type SubscribeOptions } from "./registry.js";

export type { Fetcher, SubscribeOptions };

export type StreamStatus = "loading" | "streaming" | "done" | "error";

export interface UseLlmStreamResult {
  /** Text accumulated so far. Grows as chunks arrive; final once status is "done". */
  text: string;
  status: StreamStatus;
  error: unknown;
}

/**
 * Subscribes to the shared completion for `key`. Any number of components
 * calling this hook with the same key, mounted at the same time or a
 * moment apart, cause the provider to be called exactly once — every one
 * of them re-renders with the same accumulated text as chunks arrive.
 *
 * `fetcher` is intentionally NOT a dependency of the underlying effect.
 * It's only ever called for the *first* component to mount with a given
 * key, so a fresh (but not referentially-equal) fetcher closure passed in
 * by a re-render must not re-trigger the request — that's the same
 * "identity churn" gotcha that causes duplicate calls in a naive
 * `useEffect(() => { fetchThing() }, [someObjectThatsNewEveryRender])`.
 * Keep `fetcher` itself cheap to create (it isn't called unless it wins
 * the race to register) and keyed correctly by `key`, and this is safe.
 *
 * `subscribe()` underneath this hook coalesces across independently
 * bundled microfrontends automatically, not just components in one
 * bundle — pass `options.namespace` if this app shares a page with a
 * different product also using this package; see `SubscribeOptions`.
 */
export function useLlmStream(
  key: string,
  fetcher: Fetcher,
  options?: SubscribeOptions,
): UseLlmStreamResult {
  const [state, setState] = useState<UseLlmStreamResult>({
    text: "",
    status: "loading",
    error: undefined,
  });

  // Always call through to the latest fetcher/options without putting
  // either in the effect's dependency array (see doc comment above) — a
  // fresh-but-equivalent `options` object on every render must not
  // retrigger the subscription any more than a fresh fetcher closure does.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let cancelled = false;
    setState({ text: "", status: "loading", error: undefined });

    const sub = subscribe(key, () => fetcherRef.current(), optionsRef.current);
    let text = "";

    (async () => {
      try {
        for await (const chunk of sub) {
          if (cancelled) break;
          text += chunk;
          setState({ text, status: "streaming", error: undefined });
        }
        if (!cancelled) {
          setState((prev) => ({ ...prev, status: "done" }));
        }
      } catch (err) {
        if (!cancelled) {
          setState({ text, status: "error", error: err });
        }
      }
    })();

    return () => {
      cancelled = true;
      // If we're the last subscriber still attached, this cancels the
      // underlying request (see MulticastStream's refcounted abort). If
      // others are still reading, it's a no-op for them.
      void sub.return?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetcher is read via fetcherRef, see doc comment
  }, [key]);

  return state;
}
