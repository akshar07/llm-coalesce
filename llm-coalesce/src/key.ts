/**
 * Canonical serialization for JSON-shaped request keys. Object field order
 * does not matter; array order does. Unsupported values are rejected rather
 * than silently collapsing distinct requests onto the same key.
 */
export function stableStringify(value: unknown): string {
  const ancestors = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      return Object.is(item, -0) ? "-0" : JSON.stringify(item);
    }
    if (typeof item !== "object") {
      throw new TypeError("Request keys require JSON-shaped values (finite numbers, strings, booleans, null, arrays, and plain objects)");
    }
    if (ancestors.has(item)) throw new TypeError("Request keys cannot contain cycles");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("Request keys require plain objects; convert dates and other instances explicitly");
    }
    if (Object.getOwnPropertySymbols(item).length) {
      throw new TypeError("Request keys cannot contain symbol properties");
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length) {
          throw new TypeError("Request keys cannot contain sparse arrays or extra array properties");
        }
        return `[${Array.from(item, encode).join(",")}]`;
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
}

/**
 * Historical API name retained for compatibility. Returns the full canonical
 * serialization, not a fixed-width hash: distinct supported requests must
 * never share a key merely because their hashes collide. Output is not a
 * digest and must not be used to hide sensitive request contents.
 */
export function stableHash(value: unknown): string {
  return stableStringify(value);
}
