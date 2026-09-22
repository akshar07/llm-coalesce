/**
 * Deterministic JSON stringification: object keys are sorted, so two
 * requests with the same fields in a different order hash identically.
 * Not a general-purpose serializer — functions, symbols, and cycles are
 * out of scope for a cache key.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Fast, deterministic, non-cryptographic hash (djb2 variant) of a request
 * object into a cache key. This is a dedup key, not a security boundary —
 * collisions are astronomically unlikely for request-shaped objects but
 * are not adversarially hardened against.
 *
 * By default the key includes every field you pass in — two requests that
 * differ only in `maxTokens` will NOT coalesce. That's deliberate: silently
 * merging requests with different parameters is a correctness bug waiting
 * to happen. Pass a custom `keyFn` to `createCoalescer` if you want a
 * looser, intent-based key instead.
 */
export function stableHash(value: unknown): string {
  const str = stableStringify(value);
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
