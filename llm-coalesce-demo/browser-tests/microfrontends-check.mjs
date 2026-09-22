// A real-browser check, not a node:test unit test — it drives an actual
// headless Chromium instance against the actual running server, because
// the claim this file exists to check ("three independently bundled
// microfrontends coordinate through windowAdapter()") is fundamentally a
// claim about how a real browser's ES module loader resolves imports.
// Vitest/node:test can fake a lot, but not that; see
// TUTORIAL-microfrontends-live-demo.md for the full reasoning.
//
// Deliberately kept OUTSIDE test/ and named without ".test." — Node's
// `--test` runner auto-discovers any .js/.mjs file inside a directory
// literally named "test" (or matching *.test.mjs elsewhere), and this
// file needs `playwright` + a real Chromium binary, neither of which
// `npm test`'s plain node:test suite should require to run.
//
// Run directly with `npm run test:browser` (separate from `npm test`,
// which only needs Node — this one needs a Chromium binary; see the
// README's "Run the tests" section for setup notes).

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = 3998;
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

// This sandbox ships a pre-installed Chromium at a fixed path rather than
// one downloaded by `npx playwright install`; fall back to Playwright's
// own default resolution (an installed browser, or PLAYWRIGHT_BROWSERS_PATH)
// wherever that fixed path doesn't exist.
function launchOptions() {
  const candidate = process.env.PLAYWRIGHT_CHROMIUM_PATH || "/opt/pw-browsers/chromium";
  try {
    if (existsSync(candidate)) return { executablePath: candidate };
  } catch {
    // fall through to Playwright's own default
  }
  return {};
}

const child = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: "inherit",
});

let exitCode = 1;
try {
  await waitForServer();
  await fetch(`${BASE}/api/reset`, { method: "POST" });

  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage();

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  const failedRequests = [];
  page.on("requestfailed", (req) => failedRequests.push(req.url()));
  page.on("response", (res) => {
    if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
  });

  await page.goto(`${BASE}/microfrontends`, { waitUntil: "networkidle" });

  // Part 1: the three microfrontends are genuinely separate module graphs,
  // not the same module loaded three times under different labels — the
  // load-bearing claim this whole page rests on.
  const classIdentity = await page.evaluate(async () => {
    const a = await import("/vendor/mfe-a/llm-coalesce/multicast.js");
    const b = await import("/vendor/mfe-b/llm-coalesce/multicast.js");
    const c = await import("/vendor/mfe-c/llm-coalesce/multicast.js");
    return {
      abSameClass: a.MulticastStream === b.MulticastStream,
      acSameClass: a.MulticastStream === c.MulticastStream,
    };
  });

  // Part 2: run the actual page — isolated (default adapter) vs shared
  // (windowAdapter()) — and read the server's own request counters back.
  await page.click("#runBtn");
  await page.waitForFunction(() => {
    const isolatedDone = document.querySelectorAll("#isolatedWidgets .pill.done").length;
    const sharedDone = document.querySelectorAll("#sharedWidgets .pill.done").length;
    return isolatedDone === 3 && sharedDone === 3;
  }, { timeout: 15000 });

  const stats = await page.evaluate(() => ({
    isolatedCalls: document.getElementById("isolatedCalls").textContent,
    sharedCalls: document.getElementById("sharedCalls").textContent,
  }));
  const sharedTexts = await page.$$eval("#sharedWidgets .widget-text", (els) => els.map((e) => e.textContent));

  await browser.close();

  const relevantFailures = failedRequests.filter(
    (u) => !u.includes("fonts.googleapis") && !u.includes("fonts.gstatic"),
  );

  console.log("class identity (both must be false — three separate module graphs):", classIdentity);
  console.log("stats (isolated must be 3, shared must be 1):", stats);
  console.log("shared texts identical:", sharedTexts.every((t) => t === sharedTexts[0]));
  console.log("page errors:", pageErrors);
  console.log("relevant failed requests:", relevantFailures);

  const ok =
    classIdentity.abSameClass === false &&
    classIdentity.acSameClass === false &&
    stats.isolatedCalls === "3" &&
    stats.sharedCalls === "1" &&
    sharedTexts.every((t) => t === sharedTexts[0]) &&
    pageErrors.length === 0 &&
    relevantFailures.length === 0;

  console.log(ok ? "PASS" : "FAIL");
  exitCode = ok ? 0 : 1;
} finally {
  child.kill();
}

process.exit(exitCode);
