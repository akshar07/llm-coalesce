// This is the test that actually justifies this demo's dependency on the
// real `llm-coalesce` package instead of a hand-copied registry: it spins
// up the real server (src/server.js) as a child process and drives it
// using `createCoalescer` exactly as imported from node_modules — the
// same package the browser page uses via the vendor bundle, not a
// stand-in. `createSSEStream` is this demo's own helper (public/sse.js),
// not part of the package — llm-coalesce never sees SSE at all, only the
// plain AsyncIterable that helper produces.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCoalescer } from "llm-coalesce";
import { createSSEStream } from "../public/sse.js";

const coalescer = createCoalescer();

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

async function waitForServer(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not become ready in time");
}

async function drain(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out.join("");
}

let child;

test.before(async () => {
  child = spawn(process.execPath, ["src/server.js"], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await waitForServer();
});

test.after(() => {
  child?.kill();
});

test("naive: N independent createSSEStream() calls each hit the server", async () => {
  await fetch(`${BASE}/api/reset`, { method: "POST" });

  const urls = [0, 1, 2].map((i) => `${BASE}/api/stream?mode=naive&key=itest&widget=n${i}`);
  await Promise.all(urls.map((u) => drain(createSSEStream(u))));

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  assert.equal(stats.naiveCalls, 3);
});

test("coalesced: N coalescer.stream()+createSSEStream() calls hit the server exactly once", async () => {
  await fetch(`${BASE}/api/reset`, { method: "POST" });

  const urls = [0, 1, 2].map((i) => `${BASE}/api/stream?mode=coalesced&key=itest&widget=c${i}`);
  const iterators = await Promise.all(
    urls.map((u) => coalescer.stream("itest", () => createSSEStream(u))),
  );
  const texts = await Promise.all(iterators.map(drain));

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  assert.equal(stats.coalescedCalls, 1, "the server should have received exactly one request");
  assert.ok(
    texts.every((t) => t === texts[0]),
    "all subscribers should have received identical streamed text",
  );
});

test("a widget arriving after the stream settles gets a fresh call, on purpose", async () => {
  await fetch(`${BASE}/api/reset`, { method: "POST" });

  const firstUrl = `${BASE}/api/stream?mode=coalesced&key=itest2&widget=first`;
  await drain(await coalescer.stream("itest2", () => createSSEStream(firstUrl)));

  const lateUrl = `${BASE}/api/stream?mode=coalesced&key=itest2&widget=late`;
  await drain(await coalescer.stream("itest2", () => createSSEStream(lateUrl)));

  const stats = await fetch(`${BASE}/api/stats`).then((r) => r.json());
  assert.equal(stats.coalescedCalls, 2, "a settled entry must not be reused by a later, non-overlapping call");
});
