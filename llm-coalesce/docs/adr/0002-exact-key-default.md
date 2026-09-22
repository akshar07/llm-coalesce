# ADR 0002: Exact-key coalescing by default

## Status
Accepted (v0.1)

## Context
Two widgets can want "the same" completion while passing subtly different
parameters — one requests `maxTokens: 500`, another `maxTokens: 800` for
what a human would call the same underlying question. It's tempting to
normalize these into one cache key so they coalesce.

## Decision
The default key (`stableHash`, in `src/key.ts`) canonically serializes every field of the
request object, including generation parameters. Two requests coalesce only
if they are identical once key order is normalized. Silently merging
requests with different parameters — returning a 500-token answer to a
caller that asked for 800 — is a correctness bug, and a hard one to notice,
because it only shows up when two callers happen to race.

Looser, intent-based keying (e.g. keying only on `{documentId, clauseId}`
and ignoring `maxTokens`) is available by passing a custom `keyFn` to
`createCoalescer`, but it is opt-in and the caller's explicit choice, not
the library's default behavior.

## Consequences
Some genuinely-duplicate-in-intent requests won't coalesce out of the box
if their parameters differ even slightly. That's the right failure mode:
a missed coalesce is a cost regression, not a correctness one.
