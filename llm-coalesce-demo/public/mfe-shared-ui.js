// Tiny DOM helpers shared by the three microfrontend widget files on
// microfrontends.html (mfe-a.js, mfe-b.js, mfe-c.js) and by the page's own
// orchestrator (microfrontends.js).
//
// Sharing UI plumbing like this across independently bundled widgets is
// realistic — a host shell's design system, say — and has zero bearing on
// the coalescing proof this page exists to run. What has to be genuinely
// separate per microfrontend is the llm-coalesce import itself, not
// incidental helpers like "how do I make a card div." See mfe-a.js's own
// header comment for where the real separation lives.

export function createCard(containerId, name) {
  const container = document.getElementById(containerId);
  const card = document.createElement("div");
  card.className = "widget-card";
  card.innerHTML =
    '<div class="widget-top"><span class="widget-name">' + escapeHtml(name) + "</span>" +
    '<span class="pill loading">loading</span></div>' +
    '<div class="widget-text"><span class="cursor"></span></div>' +
    '<div class="widget-latency"></div>';
  container.appendChild(card);
  return {
    status: card.querySelector(".pill"),
    text: card.querySelector(".widget-text"),
    latency: card.querySelector(".widget-latency"),
  };
}

export function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

let t0 = performance.now();

export function resetClock() {
  t0 = performance.now();
}

export function log(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (el.querySelector(".log-empty")) el.innerHTML = "";
  const line = document.createElement("div");
  line.className = "log-line call";
  const ts = document.createElement("span");
  ts.className = "t";
  ts.textContent = "+" + Math.round(performance.now() - t0) + "ms";
  line.appendChild(ts);
  line.appendChild(document.createTextNode(text));
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
