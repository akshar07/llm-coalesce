// Orchestrates microfrontends.html. This file itself is NOT one of the
// "independently bundled" pieces under test — it's the host page, playing
// the same role a shell app would in a real microfrontend architecture:
// it decides when each microfrontend mounts, but never touches
// llm-coalesce directly. Each mfe-*.js file owns its own import of the
// library (from its own /vendor/mfe-*/llm-coalesce/ mount — see
// src/server.js and each mfe file's header comment) and its own pair of
// coalescer instances; this file just calls the functions they export.

import * as mfeA from "./mfe-a.js";
import * as mfeB from "./mfe-b.js";
import * as mfeC from "./mfe-c.js";
import { createCard, escapeHtml, log, resetClock } from "./mfe-shared-ui.js";

const MFES = [mfeA, mfeB, mfeC];
const KEY = "mfe-summary";

function buildUrl(serverMode, widget) {
  const params = new URLSearchParams({ mode: serverMode, key: KEY, widget });
  return "/api/stream?" + params.toString();
}

// `mode` here is this page's own vocabulary ("isolated" vs "shared"); the
// server only knows "naive" vs "coalesced" (see src/server.js) — those are
// just labels it echoes back for the stats/log display, so any two-value
// mapping works. Isolated -> naive, shared -> coalesced, so this page's
// two counters land on the same /api/stats fields the main demo uses.
function toServerMode(mode) {
  return mode === "shared" ? "coalesced" : "naive";
}

async function runOne(mode, mfe, containerId, logId) {
  const card = createCard(containerId, mfe.MFE_NAME);
  const coalescer = mfe.getCoalescer(mode);
  const url = buildUrl(toServerMode(mode), mfe.MFE_NAME);
  card.status.textContent = "streaming";
  card.status.className = "pill streaming";

  let text = "";
  let gotFirst = false;
  const mountedAt = performance.now();

  try {
    // Every microfrontend calls coalescer.stream() with the identical key.
    // Whether that collapses into one real fetch() or fires three depends
    // entirely on which coalescer mfe.getCoalescer(mode) handed back —
    // nothing in this function branches on "isolated" vs "shared" beyond
    // that one lookup.
    const iterator = await coalescer.stream(KEY, () => {
      log(logId, mfe.MFE_NAME + ": its own createSSEStream() thunk just fired — a real fetch() is about to go out");
      return mfe.createSSEStream(url);
    });

    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (!gotFirst) {
        card.latency.textContent = Math.round(performance.now() - mountedAt) + "ms to first token";
        gotFirst = true;
      }
      text += value;
      card.text.innerHTML = escapeHtml(text) + '<span class="cursor"></span>';
    }
    card.status.textContent = "done";
    card.status.className = "pill done";
    card.text.textContent = text;
    log(logId, mfe.MFE_NAME + ": stream complete");
  } catch (err) {
    card.status.textContent = "error";
    card.text.textContent = String(err.message || err);
    log(logId, mfe.MFE_NAME + ": error — " + (err.message || err));
  }
}

async function runSet(mode) {
  const containerId = mode === "shared" ? "sharedWidgets" : "isolatedWidgets";
  const logId = mode === "shared" ? "sharedLog" : "isolatedLog";
  document.getElementById(containerId).innerHTML = "";
  document.getElementById(logId).innerHTML = "";
  await Promise.all(MFES.map((mfe) => runOne(mode, mfe, containerId, logId)));
}

async function pollStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    document.getElementById("isolatedCalls").textContent = data.naiveCalls;
    document.getElementById("sharedCalls").textContent = data.coalescedCalls;
  } catch {
    // server unreachable this tick — next poll retries
  }
}

async function reset() {
  await fetch("/api/reset", { method: "POST" }).catch(() => {});
  resetClock();
  document.getElementById("isolatedCalls").textContent = "0";
  document.getElementById("sharedCalls").textContent = "0";
  document.getElementById("isolatedWidgets").innerHTML = "";
  document.getElementById("sharedWidgets").innerHTML = "";
  document.getElementById("isolatedLog").innerHTML = '<div class="log-empty">Press "Run demo" to start.</div>';
  document.getElementById("sharedLog").innerHTML = '<div class="log-empty">Press "Run demo" to start.</div>';
}

async function run() {
  await reset();
  // Both sets mount "at the same time" — the exact scenario that breaks a
  // module-scoped registry across independently bundled code: three
  // separate module graphs, all asking for the same key in the same tick.
  await Promise.all([runSet("isolated"), runSet("shared")]);
  await pollStats();
}

document.getElementById("runBtn").addEventListener("click", run);
document.getElementById("resetBtn").addEventListener("click", reset);
