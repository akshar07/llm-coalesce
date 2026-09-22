import type { MulticastStream } from "./multicast.js";
import { createSubscribe, type Fetcher } from "./coalesce.js";

export type { Fetcher } from "./coalesce.js";

/**
 * THE ONE REGISTRY. Earlier revisions of this package had two of these: a
 * plain module-scoped `Map` here, and a separate `globalThis`-backed one
 * behind a second entry point (`use-llm-stream/window`) for consumers who
 * knew in advance they'd be split across independently bundled
 * microfrontends. That split put a burden on the consumer that the
 * consumer shouldn't have to carry: it required *predicting*, at the time
 * you write `import { subscribe } from "use-llm-stream"`, whether your app
 * would ever be split into separately built pieces sharing a page — and
 * silently regressing (no error, just quietly-worse coalescing) if you
 * guessed wrong or that answer changed later, since nothing prompts you to
 * go switch entry points when a monolith grows into microfrontends.
 *
 * So this registry is unconditionally backed by `globalThis` instead of
 * module scope, all the time, for everyone. It costs the common
 * single-bundle case nothing — `globalThis` is just as available there,
 * it's simply *also* reachable from other bundles, which is exactly the
 * property that used to be missing. Two components in one bundle sharing
 * this Map, and two independently built microfrontends sharing it, are now
 * the *same* mechanism, not two — there's nothing to opt into and nothing
 * to get wrong by not opting in.
 *
 * WHY `Symbol.for()`, NOT A STRING PROPERTY NAME. `globalThis.foo = ...`
 * risks colliding with anything else on the page that happens to pick the
 * same name. `Symbol.for(key)` reads from the JS engine's own global
 * symbol registry: every call with the same string returns the identical
 * Symbol, from any script in the realm, and — because it isn't enumerable
 * through `Object.keys`/`for...in` — nothing that isn't deliberately
 * calling `Symbol.for()` with this exact string can stumble into it by
 * accident. The version segment (`v1`) means a future breaking change to
 * this module's internal contract just becomes a new key: mismatched
 * versions on the same page fail to find each other and each fall back to
 * coalescing only within their own bundle — worse coalescing, never a
 * corrupted shared Map.
 *
 * WHY `namespace` IS OPTIONAL, WITH A SHARED DEFAULT, RATHER THAN
 * REQUIRED. `globalThis` is shared by *everything* on the page, not just
 * your own app's microfrontends — in principle, some unrelated widget on
 * the same page that also happens to use `use-llm-stream`, with a `key`
 * that happens to match yours, could coalesce with you by coincidence.
 * Requiring an explicit namespace on every call would close that off
 * completely, but it also means every consumer — even the overwhelming
 * majority who are just one app, one bundle, no microfrontends in sight —
 * has to think about a problem that mostly doesn't apply to them. The
 * default namespace optimizes for that majority: it assumes you're not
 * sharing a page with a *different product* that also depends on this
 * exact package, which is true almost all of the time. If you are — a
 * host page embedding independently vendored widgets, say — pass an
 * explicit, product-specific `namespace` to opt back into isolation:
 *
 *   subscribe(key, fetcher, { namespace: "acme-checkout" })
 *
 * Two different namespaces never share state, even for an identical key.
 */

const REGISTRY_VERSION = "v1";

/** Every call to `subscribe()` that doesn't pass an explicit `namespace`
 * shares this one — see the "WHY namespace IS OPTIONAL" note above. */
export const DEFAULT_NAMESPACE = "use-llm-stream/default";

export interface SubscribeOptions {
  /** Scopes coalescing to callers using the same namespace. Defaults to a
   * shared value — see `DEFAULT_NAMESPACE`'s doc comment. Set this
   * explicitly when your page might also run someone else's, unrelated
   * use of this package. */
  namespace?: string;
}

type GlobalRegistries = Record<symbol, Map<string, MulticastStream<string>> | undefined>;

function getRegistry(namespace: string): Map<string, MulticastStream<string>> {
  if (namespace === "") {
    throw new Error(
      "subscribe(): namespace must be a non-empty string if provided at all — " +
        "omit the option entirely to use the shared default namespace.",
    );
  }

  const key = Symbol.for(`use-llm-stream/registry/${REGISTRY_VERSION}/${namespace}`);
  const target = globalThis as unknown as GlobalRegistries;

  let registry = target[key];
  if (!registry) {
    registry = new Map<string, MulticastStream<string>>();
    target[key] = registry;
  }
  return registry;
}

/**
 * Subscribe to the shared stream for `key`. If no request for this key is
 * currently in flight (within `options.namespace`, or the shared default
 * namespace), `fetcher` is invoked and its result becomes the shared
 * stream; if one is already in flight, this just attaches to it —
 * `fetcher` is never called a second time while the first is still going.
 *
 * This coalesces across every caller sharing the same namespace, whether
 * they're in the same bundle or independently built and bundled
 * separately — both are just "callers," to this registry.
 */
export function subscribe(
  key: string,
  fetcher: Fetcher,
  options: SubscribeOptions = {},
): AsyncIterableIterator<string> {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;
  return createSubscribe(() => getRegistry(namespace))(key, fetcher);
}

/** Exposed for tests only — clears one namespace's in-flight entries
 * (the default namespace, unless another is given). */
export function __resetRegistryForTests(namespace: string = DEFAULT_NAMESPACE): void {
  getRegistry(namespace).clear();
}
