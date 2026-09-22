/**
 * Illustrative — not run as part of the test suite. Requires `ai` and a
 * model provider package (e.g. `@ai-sdk/anthropic`) to actually execute:
 *   npm install ai @ai-sdk/anthropic
 *
 * llm-coalesce never talks to a provider itself: you hand it a thunk that
 * returns the call you already make. Here that's the Vercel AI SDK's
 * `streamText`, whose `.textStream` is already an AsyncIterable<string> —
 * no adapter needed on top of it.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { createCoalescer, windowAdapter } from "llm-coalesce";

// `windowAdapter()` coordinates across independently bundled widgets that
// share the same page — swap in the default (in-process) adapter if every
// caller lives in one bundle, e.g. on the server.
const coalescer = createCoalescer({ streamAdapter: windowAdapter() });

interface ExplainClauseRequest {
  documentId: string;
  clauseId: string;
}

/** Called independently by any panel that needs this clause explained —
 * the "Why was this flagged" panel and the "explain this clause" panel
 * can both call this for the same clause without either knowing about
 * the other, and the model only gets asked once. */
async function explainClause(req: ExplainClauseRequest) {
  const sub = await coalescer.stream(req, () =>
    streamText({
      model: anthropic("claude-opus-4-5"),
      prompt: `Explain clause ${req.clauseId} of document ${req.documentId} in plain language.`,
    }).then((result) => result.textStream),
  );

  let text = "";
  for await (const delta of sub) {
    text += delta;
    // render(text) — every caller for this (documentId, clauseId) pair
    // receives the same deltas, in the same order, from one upstream call.
  }
  return text;
}
