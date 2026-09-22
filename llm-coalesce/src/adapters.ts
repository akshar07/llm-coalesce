import { PROTOCOL_VERSION } from "./protocol.js";

// ---------------------------------------------------------------------------
// run() adapters — coalescing plain Promise-returning calls
// ---------------------------------------------------------------------------

export interface RunAdapter {
  get(key: string): Promise<unknown> | undefined;
  set(key: string, promise: Promise<unknown>): void;
  delete(key: string): void;
}

/** In-process Promise registry. Default for `run()`; fine for Node/SSR and
 * for browser use within a single bundle. */
export function memoryRunAdapter(): RunAdapter {
  const map = new Map<string, Promise<unknown>>();
  return {
    get: (key) => map.get(key),
    set: (key, p) => {
      map.set(key, p);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// stream() adapters — coalescing streaming calls across possibly-separate
// module instances (the micro-frontend case)
// ---------------------------------------------------------------------------

export interface StreamRegistryEntry {
  protocolVersion: string;
  /** Attach a new subscriber to the in-flight (or just-finished) stream. */
  subscribe: () => AsyncIterableIterator<unknown>;
}

export interface StreamAdapter {
  acquire(key: string): StreamRegistryEntry | undefined;
  register(key: string, entry: StreamRegistryEntry): void;
  /** Remove only the entry owned by the caller; stale cleanup must be a no-op. */
  release(key: string, expectedEntry: StreamRegistryEntry): void;
}

/** In-process registry. Default for Node/SSR/tests, and for browser use
 * within a single bundle where a plain module-scope Map already works. */
export function memoryAdapter(): StreamAdapter {
  const map = new Map<string, StreamRegistryEntry>();
  return {
    acquire: (key) => map.get(key),
    register: (key, entry) => {
      map.set(key, entry);
    },
    release: (key, expectedEntry) => {
      if (map.get(key) === expectedEntry) map.delete(key);
    },
  };
}

const REGISTRY_KEY = "__LLM_COALESCE_REGISTRY__";

interface RegistryHost {
  [REGISTRY_KEY]?: Map<string, StreamRegistryEntry>;
}

/**
 * Coordinates across independently bundled widgets that share the same
 * `window` (or other global object) but each import their own copy of this
 * library. A plain module-scope Map can't do this — every bundle has its
 * own copy of the module. A well-known global object can, because multiple
 * bundles in the same JS realm already share `window` by reference.
 *
 * Registry entries are plain objects (a `subscribe` function), never class
 * instances — two bundles have two different copies of the MulticastStream
 * class, so an `instanceof` check across them would fail even for
 * functionally identical code. Duck-typed function bags sidestep that.
 *
 * Version safety: every entry is stamped with PROTOCOL_VERSION. If a widget
 * on an older or newer version of this library encounters an entry it
 * doesn't recognize, `acquire` returns `undefined` — the safe default is to
 * NOT coalesce (duplicate the call) rather than risk two incompatible
 * versions reading or writing shared state. See docs/adr/0001.
 *
 * Not a substitute for cross-tab or cross-iframe coordination — that needs
 * a `BroadcastChannel`-based adapter (planned for v0.3; see README roadmap).
 */
export function windowAdapter(
  target: RegistryHost = (typeof window !== "undefined"
    ? window
    : globalThis) as RegistryHost,
): StreamAdapter {
  if (!target[REGISTRY_KEY]) {
    target[REGISTRY_KEY] = new Map<string, StreamRegistryEntry>();
  }
  const map = target[REGISTRY_KEY];

  return {
    acquire: (key) => {
      const entry = map.get(key);
      if (!entry) return undefined;
      if (entry.protocolVersion !== PROTOCOL_VERSION) return undefined;
      return entry;
    },
    register: (key, entry) => {
      map.set(key, entry);
    },
    release: (key, expectedEntry) => {
      const entry = map.get(key);
      if (entry && entry === expectedEntry && entry.protocolVersion === PROTOCOL_VERSION) {
        map.delete(key);
      }
    },
  };
}
