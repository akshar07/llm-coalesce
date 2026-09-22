// The "LLM" the server calls. Two implementations:
//
//   - mockStream(): a canned response streamed at a realistic per-token
//     pace. Zero setup, zero cost, deterministic — the default so the demo
//     works out of the box.
//   - anthropicStream(prompt): a real streaming call to the Anthropic API,
//     used only when ANTHROPIC_API_KEY is set. @anthropic-ai/sdk is an
//     optionalDependency, loaded via dynamic import() so the server still
//     runs (falling back to the mock) even if that package isn't installed.
//
// Neither of these knows or cares whether the request it's serving is
// "the only one" or "one of several" — that decision was already made by
// the browser before this endpoint was ever hit. See src/server.js.

const MOCK_RESPONSE =
  "The liability clause has no cap, which means either party could be on the hook for damages well beyond the value of this agreement.".split(
    " ",
  );

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenDelay() {
  return 70 + Math.random() * 70;
}

export function mockStream() {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (i >= MOCK_RESPONSE.length) return { done: true, value: undefined };
      await delay(tokenDelay());
      const value = (i === 0 ? "" : " ") + MOCK_RESPONSE[i];
      i++;
      return { done: false, value };
    },
  };
}

let anthropicModulePromise = null;
function loadAnthropic() {
  if (!anthropicModulePromise) {
    anthropicModulePromise = import("@anthropic-ai/sdk").then((m) => m.default ?? m);
  }
  return anthropicModulePromise;
}

export async function anthropicStream(prompt) {
  const Anthropic = await loadAnthropic();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";

  const stream = await client.messages.stream({
    model,
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          return { done: false, value: event.delta.text };
        }
      }
      return { done: true, value: undefined };
    },
  };
}

export function getProviderStream(prompt) {
  if (process.env.ANTHROPIC_API_KEY) {
    return anthropicStream(prompt);
  }
  return mockStream();
}

export function isUsingRealProvider() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
