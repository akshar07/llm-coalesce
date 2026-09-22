import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getProviderStream, isUsingRealProvider } from "./provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PROMPT =
  "Explain this clause in plain English: 'Either party's liability under this agreement is uncapped.'";

// --- This server is deliberately coalescing-UNAWARE ---------------------
// It has no registry, no notion of "reuse", no idea that two requests
// might be "the same question". Every hit to /api/stream starts a brand
// new provider stream, full stop. That's the point: request coalescing is
// a client-side concern, living entirely in the installed `llm-coalesce`
// package (see public/app.js and the import map in public/index.html) —
// the decision about whether to make 1 network call or N is made in the
// browser, before any request reaches this file. This server's only job
// is to honestly report how many times it was actually asked. SSE framing
// (the `event:`/`data:` lines below) is this demo's own wire format, not
// anything `llm-coalesce` knows about — see public/sse.js.

const stats = {
  naiveCalls: 0,
  naiveTokens: 0,
  coalescedCalls: 0,
  coalescedTokens: 0,
};

let nextRequestId = 0;

function resetState() {
  stats.naiveCalls = 0;
  stats.naiveTokens = 0;
  stats.coalescedCalls = 0;
  stats.coalescedTokens = 0;
  nextRequestId = 0;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Serves the *actual installed* llm-coalesce package straight from
// node_modules — the same compiled output `npm pack` would ship, not a
// bundled/transformed copy. The browser resolves the bare "llm-coalesce"
// specifier via the import map in public/index.html, which points here;
// the package's own internal imports (e.g. "./multicast.js") are plain
// relative URLs and resolve on their own once served from one directory,
// no bundler involved. public/sse.js is served the normal way (it's
// already under public/, no special route needed) since it's this demo's
// own file, not part of the installed package.
app.use(
  "/vendor/llm-coalesce",
  express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")),
);

// --- Simulating three independently bundled microfrontends ---------------
// Same trick as above, mounted three times under three different path
// prefixes, all pointing at the identical dist/ directory on disk. Nothing
// about the files themselves differs between mfe-a/mfe-b/mfe-c — what
// differs is the URL the browser fetches them from. ES module identity is
// keyed on the resolved URL, not file content or inode, so
// /vendor/mfe-a/llm-coalesce/index.js and /vendor/mfe-b/llm-coalesce/index.js
// are evaluated as two wholly separate module graphs — separate
// MulticastStream class, separate windowAdapter() closure, separate
// PROTOCOL_VERSION binding, the works — a faithful stand-in for three
// genuinely separate webpack/esbuild builds, without needing three actual
// builds. See public/mfe-a.js / mfe-b.js / mfe-c.js and
// TUTORIAL-microfrontends-live-demo.md.
for (const mfe of ["mfe-a", "mfe-b", "mfe-c"]) {
  app.use(
    `/vendor/${mfe}/llm-coalesce`,
    express.static(path.join(__dirname, "..", "node_modules", "llm-coalesce", "dist")),
  );
}

app.get("/microfrontends", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "microfrontends.html"));
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, usingRealProvider: isUsingRealProvider() });
});

app.get("/api/stats", (_req, res) => {
  res.json(stats);
});

app.post("/api/reset", (_req, res) => {
  resetState();
  res.json({ ok: true });
});

app.get("/api/stream", async (req, res) => {
  // `mode` and `key` are labels the client sends for its own bookkeeping
  // (which UI column to attribute this call to, what it was asking about).
  // They have zero effect on server behavior — there is nothing here that
  // branches on them to decide whether to reuse a stream.
  const mode = req.query.mode === "coalesced" ? "coalesced" : "naive";
  const widget = String(req.query.widget || "");
  const prompt =
    typeof req.query.prompt === "string" && req.query.prompt.length > 0
      ? req.query.prompt
      : DEFAULT_PROMPT;

  const requestId = ++nextRequestId;
  if (mode === "coalesced") stats.coalescedCalls += 1;
  else stats.naiveCalls += 1;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Every request gets its own fresh provider stream. No sharing, no
  // lookup, no registry — this line is the entire "business logic" of
  // this endpoint. getProviderStream() returns a sync iterable for the
  // mock and a Promise<iterable> for the real Anthropic path, so it's
  // called exactly once and normalized afterward.
  const streamOrPromise = getProviderStream(prompt);
  const iterable = typeof streamOrPromise.then === "function" ? await streamOrPromise : streamOrPromise;
  const iterator = iterable[Symbol.asyncIterator]();

  send("meta", { requestId, mode, widget });

  req.on("close", () => {
    closed = true;
    iterator.return?.();
  });

  try {
    while (!closed) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (mode === "coalesced") stats.coalescedTokens += 1;
      else stats.naiveTokens += 1;
      send(undefined, { token: value });
    }
    if (!closed) send("done", { widget });
  } catch (err) {
    if (!closed) send("error", { message: err?.message || String(err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`llm-coalesce demo server listening on http://localhost:${port}`);
  console.log(`provider: ${isUsingRealProvider() ? "Anthropic (real)" : "mock"}`);
  console.log("this server does not coalesce anything — see the installed llm-coalesce package (public/app.js) for that");
});
