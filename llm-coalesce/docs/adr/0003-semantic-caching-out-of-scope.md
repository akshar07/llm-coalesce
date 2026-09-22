# ADR 0003: Semantic (fuzzy) caching is out of core scope

## Status
Accepted (v0.1)

## Context
Semantic caches (e.g. embedding-similarity matching over past prompts) are
a well-covered, well-funded space already — and a different problem than
the one this library targets. This library exists to coordinate *concurrent*
callers asking for the *same* completion at roughly the same time; semantic
caching is about matching a new request against *past, already-finished*
ones based on meaning rather than exact equality.

## Decision
v0.1 ships exact-key coalescing only (see ADR 0002) and does not attempt
fuzzy/semantic matching. This keeps the core small, dependency-free, and
correct-by-construction, and avoids competing with tools that already do
semantic caching well.

A pluggable semantic-key matcher is an explicit, later, opt-in extension
(tracked for v1.0 in README's roadmap) — not something the core has to get
right on day one, and never the default even once it exists.

## Consequences
llm-coalesce will not dedupe two differently-worded requests that "mean"
the same thing. Teams that want that should pair this library with a
semantic cache (e.g. at the provider-gateway layer) rather than expect it
here.
