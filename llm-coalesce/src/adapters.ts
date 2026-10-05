import { PROTOCOL_VERSION } from "./protocol.js";

export interface RunAdapter {
  get(key: string): Promise<unknown> | undefined;
  set(key: string, promise: Promise<unknown>): void;
  delete(key: string): void;
}

/** Create an isolated in-process registry for run() calls. */
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

/** Create an isolated in-process stream registry. Share this adapter to share streams. */
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
 * Share streams across bundles using the same global object. Entries use plain
 * objects so consumers do not depend on cross-bundle class identity.
 * Incompatible protocol versions do not coalesce. Cross-tab sharing is unsupported.
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
