/**
 * Illustrative — not run as part of the test suite. Shows the other shape
 * `fn` can return: a ReadableStream (what a raw `fetch` SSE body gives
 * you), instead of an AsyncIterable. llm-coalesce normalizes either.
 */
import { createCoalescer } from "llm-coalesce";

const coalescer = createCoalescer();

interface SummarizeRequest {
  documentId: string;
}

/** Parses an SSE `data: ...` body into a ReadableStream<string> of token
 * deltas. A minimal stand-in for whatever your provider's raw HTTP
 * streaming response actually looks like. */
function sseTokenStream(res: Response): ReadableStream<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return new ReadableStream<string>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice("data: ".length);
        if (payload === "[DONE]") continue;
        const { token } = JSON.parse(payload) as { token: string };
        controller.enqueue(token);
      }
    },
  });
}

async function summarizeDocument(req: SummarizeRequest) {
  const sub = await coalescer.stream(req, async () => {
    const res = await fetch(`/api/summarize?documentId=${req.documentId}`, {
      method: "POST",
    });
    return sseTokenStream(res);
  });

  let text = "";
  for await (const token of sub) {
    text += token;
  }
  return text;
}
