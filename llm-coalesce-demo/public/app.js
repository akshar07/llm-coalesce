// The demo's orchestration + UI layer. The one thing to notice: this file
// decides, on its own, whether a widget's request goes straight to
// createSSEStream() or through coalescer.stream() first. The server
// (src/server.js) never sees that decision — it only sees however many
// HTTP requests actually show up.
//
// The coalescing engine itself — MulticastStream, the adapter-backed
// registry, and the protocol-versioned cross-bundle handshake — is not
// duplicated here and isn't even bundled in. "llm-coalesce" is a bare
// specifier resolved by the import map in index.html, pointing at the
// package this project actually `npm install`ed (see package.json's
// "llm-coalesce": "file:./vendor-packages/llm-coalesce-0.1.0.tgz" — a
// real, packed tarball, not a live link to the package's source tree).
// This demo is a consumer of that package, full stop.
//
// SSE parsing is deliberately NOT part of that package — llm-coalesce is
// provider-agnostic and only ever sees a thunk returning an AsyncIterable
// or ReadableStream. createSSEStream() below is this demo's OWN local
// helper (public/sse.js), not an export of llm-coalesce; see that file's
// header comment and TUTORIAL-provider-agnostic-core.md for why.

import { createCoalescer } from "llm-coalesce";
import { createSSEStream } from "./sse.js";

const coalescer = createCoalescer();
const KEY = "clause-7";

function buildUrl(mode, widget) {
  const params = new URLSearchParams({ mode, key: KEY, widget });
  return "/api/stream?" + params.toString();
}

// ---- Logging / cards (unchanged from the original in-browser demo) -----
let t0 = performance.now();

function log(system, text, isCall) {
  const el = document.getElementById(system + "Log");
  if (el.querySelector(".log-empty")) el.innerHTML = "";
  const line = document.createElement("div");
  line.className = "log-line" + (isCall ? " call" : "");
  const ts = document.createElement("span");
  ts.className = "t";
  ts.textContent = "+" + Math.round(performance.now() - t0) + "ms";
  line.appendChild(ts);
  line.appendChild(document.createTextNode(text));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function createWidgetCard(system, name, isLate) {
  const container = document.getElementById(system + "Widgets");
  const card = document.createElement("div");
  card.className = "widget-card" + (isLate ? " late" : "");
  card.innerHTML =
    '<div class="widget-top"><span class="widget-name">' + escapeHtml(name) + "</span>" +
    '<span class="pill loading">loading</span></div>' +
    '<div class="widget-text"><span class="cursor"></span></div>' +
    '<div class="widget-latency"></div>' +
    (isLate ? '<div class="widget-note">mounted after completion — fresh call, see note below</div>' : "");
  container.appendChild(card);
  return {
    status: card.querySelector(".pill"),
    text: card.querySelector(".widget-text"),
    latency: card.querySelector(".widget-latency"),
  };
}

// ---- Per-run call counters, kept entirely client-side -------------------
// These exist purely for the log lines ("provider call #2 started"). They
// are NOT how the stat tiles get their numbers — those come from polling
// /api/stats, i.e. from the server's own count of requests it received.
// The two should always agree; if they ever didn't, that would mean the
// coalescing logic has a bug.
let naiveCallSeq = 0;
let coalescedCallSeq = 0;
const activeIterators = new Set();

function runWidget(system, mode, name, mountDelay, isLate) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const card = createWidgetCard(system, name, isLate);
      const mountedAt = performance.now();
      let text = "";
      let gotFirst = false;

      const url = buildUrl(mode, name);

      card.status.textContent = "streaming";
      card.status.className = "pill streaming";

      (async () => {
        let iterator;
        try {
          if (mode === "coalesced") {
            // coalescer.stream() is llm-coalesce's own export. It's async
            // (unlike the old subscribe(), which returned an iterator
            // synchronously) because the package has to stay agnostic
            // about what `fn` returns — an AsyncIterable, a ReadableStream,
            // or a Promise of either. That `await` doesn't weaken the
            // coalescing guarantee: registration happens synchronously
            // *inside* stream(), before the thunk below is ever invoked
            // (see llm-coalesce's coalescer.ts / lazySource), so widgets
            // whose setTimeout callbacks fire in the same tick still
            // collapse into one real call — only the caller-facing return
            // value is a promise now.
            iterator = await coalescer.stream(KEY, () => {
              coalescedCallSeq += 1;
              log("coalesced", "provider call #" + coalescedCallSeq + " started (shared)", true);
              return createSSEStream(url);
            });
          } else {
            naiveCallSeq += 1;
            log("naive", "provider call #" + naiveCallSeq + " started", true);
            // createSSEStream() returns a plain AsyncIterable, not a
            // self-iterator — get its iterator explicitly for the manual
            // next()/return() loop below.
            iterator = createSSEStream(url)[Symbol.asyncIterator]();
          }
          activeIterators.add(iterator);

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
          log(system, name + ": stream complete");
        } catch (err) {
          card.status.textContent = "error";
          card.text.textContent = String(err.message || err);
          log(system, name + ": error — " + (err.message || err));
        } finally {
          if (iterator) activeIterators.delete(iterator);
          resolve();
        }
      })();
    }, mountDelay);
  });
}

// ---- Stats polling -------------------------------------------------
// The stat tiles show what the *server* actually saw. That's the whole
// proof: the coalesced side's request count is low not because the UI
// says so, but because the server independently counted fewer requests.
let statsTimer = null;

async function pollStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    document.getElementById("naiveCalls").textContent = data.naiveCalls;
    document.getElementById("naiveTokens").textContent = data.naiveTokens;
    document.getElementById("coalescedCalls").textContent = data.coalescedCalls;
    document.getElementById("coalescedTokens").textContent = data.coalescedTokens;
  } catch (err) {
    // Server unreachable this tick — next poll retries.
  }
}

function startStatsPolling() {
  stopStatsPolling();
  statsTimer = setInterval(pollStats, 200);
}
function stopStatsPolling() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
}

// ---- Orchestration -------------------------------------------------
let widgetCount = 3;
let stagger = false;
let plannedCount = 0;
let naiveDone = 0;
let coalescedDone = 0;
let mountedIndex = 0;
let running = false;

const NAMES = ["Widget A", "Widget B", "Widget C", "Widget D", "Widget E", "Widget F"];

function noteDone(system) {
  if (system === "naive") naiveDone++;
  else coalescedDone++;
  if (running && naiveDone >= plannedCount && coalescedDone >= plannedCount) {
    document.getElementById("lateRow").style.display = "flex";
    stopStatsPolling();
    pollStats();
  }
}

async function reset() {
  running = false;
  stopStatsPolling();
  // No explicit registry reset call needed (the package doesn't expose
  // one as public API) — calling .return() on every still-open iterator
  // drives each entry's refcount to 0 synchronously, which is exactly
  // what makes coalescer.stream()'s internal registry release the entry
  // on its own (see llm-coalesce's MulticastStream onAbort/onSettle
  // hooks). A widget mounted by the *next* run for the same key starts
  // fresh, not joined to a stream we just abandoned.
  activeIterators.forEach((it) => it.return?.());
  activeIterators.clear();
  naiveCallSeq = 0;
  coalescedCallSeq = 0;
  plannedCount = 0;
  naiveDone = 0;
  coalescedDone = 0;
  mountedIndex = 0;
  t0 = performance.now();
  document.getElementById("naiveCalls").textContent = "0";
  document.getElementById("naiveTokens").textContent = "0";
  document.getElementById("coalescedCalls").textContent = "0";
  document.getElementById("coalescedTokens").textContent = "0";
  document.getElementById("naiveWidgets").innerHTML = "";
  document.getElementById("coalescedWidgets").innerHTML = "";
  document.getElementById("naiveLog").innerHTML = '<div class="log-empty">Press "Run demo" to start.</div>';
  document.getElementById("coalescedLog").innerHTML = '<div class="log-empty">Press "Run demo" to start.</div>';
  document.getElementById("lateRow").style.display = "none";
  try {
    await fetch("/api/reset", { method: "POST" });
  } catch (err) {
    // Not fatal for a demo — the next run just starts from whatever
    // counters the server still has.
  }
}

async function run() {
  await reset();
  running = true;
  plannedCount = widgetCount;
  startStatsPolling();
  const offsets = stagger ? [0, 600, 1300, 1900, 2500, 3100] : [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < widgetCount; i++) {
    const name = NAMES[i] + (stagger ? " (mounts +" + offsets[i] + "ms)" : "");
    mountedIndex++;
    runWidget("naive", "naive", name, offsets[i], false).then(() => noteDone("naive"));
    runWidget("coalesced", "coalesced", name, offsets[i], false).then(() => noteDone("coalesced"));
  }
}

function mountLateWidget() {
  document.getElementById("lateRow").style.display = "none";
  plannedCount += 1;
  mountedIndex++;
  startStatsPolling();
  const name = "Widget " + String.fromCharCode(64 + mountedIndex) + " (late)";
  runWidget("naive", "naive", name, 0, true).then(() => noteDone("naive"));
  runWidget("coalesced", "coalesced", name, 0, true).then(() => noteDone("coalesced"));
}

// ---- Provider badge --------------------------------------------------
fetch("/healthz")
  .then((r) => r.json())
  .then((data) => {
    const badge = document.getElementById("providerBadge");
    badge.textContent = data.usingRealProvider ? "provider: Anthropic (live)" : "provider: mock";
  })
  .catch(() => {
    document.getElementById("providerBadge").textContent = "provider: unknown (server unreachable)";
  });

// ---- Wire up controls --------------------------------------------------
document.getElementById("widgetCountControl").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-count]");
  if (!btn) return;
  widgetCount = parseInt(btn.dataset.count, 10);
  document.querySelectorAll("#widgetCountControl button").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
});
document.getElementById("staggerToggle").addEventListener("change", (e) => {
  stagger = e.target.checked;
});
document.getElementById("runBtn").addEventListener("click", run);
document.getElementById("resetBtn").addEventListener("click", reset);
document.getElementById("lateBtn").addEventListener("click", mountLateWidget);
