/**
 * Normalizes the two shapes a streaming LLM call tends to return into a
 * plain AsyncIterable. llm-coalesce never talks to a provider itself — you
 * hand it a thunk that returns whatever your existing client already gives
 * you (an AsyncIterable, like the Vercel AI SDK's `textStream`, or a
 * ReadableStream, like a raw `fetch` SSE body reader).
 */
export function toAsyncIterable<T>(
  source: AsyncIterable<T> | ReadableStream<T>,
): AsyncIterable<T> {
  if (Symbol.asyncIterator in (source as object)) {
    return source as AsyncIterable<T>;
  }

  const stream = source as ReadableStream<T>;
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const reader = stream.getReader();
      return {
        async next(): Promise<IteratorResult<T>> {
          const { value, done } = await reader.read();
          if (done) {
            return { value: undefined, done: true };
          }
          return { value: value as T, done: false };
        },
        async return(value?: unknown): Promise<IteratorResult<T>> {
          await reader.cancel();
          return { value: value as T, done: true };
        },
      };
    },
  };
}
