# ADR 0001: Cross-bundle coordination via a versioned global registry

## Status
Accepted (v0.1)

## Context
Independently deployed widgets (the micro-frontend case this library targets)
each bundle their own copy of llm-coalesce. A plain module-scope `Map` can't
coordinate them — every bundle has its own copy of the module, and therefore
its own copy of the Map. But multiple bundles in the same page *do* share one
JS realm, so they already share `window` by reference.

## Decision
`windowAdapter()` stores the registry as a `Map` attached to a well-known key
on `window` (or another provided global object). Every entry is stamped with
`PROTOCOL_VERSION`. On `acquire`, an entry whose version doesn't match the
caller's own is treated as absent.

Two consequences follow directly from this:

1. **Entries are plain objects, not class instances.** Two bundles have two
   separate copies of the `MulticastStream` class — even identical source
   code produces two different class identities in two module instances, so
   `instanceof` checks across the registry boundary are unreliable. Registry
   entries are duck-typed (`{ protocolVersion, subscribe }`), never checked
   with `instanceof`.

2. **A version mismatch means "don't coalesce," not "crash" or "coalesce
   anyway."** If widget A ships `llm-coalesce@1.x` and widget B ships `2.x`
   on the same page, B's `acquire` call for a key A registered returns
   `undefined`. B ends up making its own duplicate request rather than
   attaching to state written by a version it doesn't recognize.

## Alternatives considered
- **`BroadcastChannel`.** Necessary for cross-tab/cross-iframe coordination,
  but overkill (and asynchronous, which reintroduces the exact race this
  library exists to avoid — see ADR 0002 style ordering concerns) for the
  common case of "multiple widgets in the same document." Planned as an
  additional adapter for that case in v0.3, not a replacement for this one.
- **A single global class instance shared via a script the host page loads
  once.** Would work, but forces every consuming team to coordinate on
  loading exactly one copy of the library — the opposite of what makes
  independent widget deployment possible in the first place.

## Consequences
Safe by construction across version skew, at the cost of not coalescing
across a skew when it happens. That's the correct trade for a cache: a
missed coalesce costs one duplicate request; a wrong one risks corrupted
shared state.

## Ownership-checked cleanup (protocol 2)

`StreamAdapter.release(key, expectedEntry)` must delete only when the stored
entry is the same object as `expectedEntry`. The comparison and deletion must
happen synchronously inside the adapter. Cancellation can release a key before
the source's pending read finishes; its later settlement must not remove a
replacement stream registered under that key.

The coalescer passes its entry to both abort and settlement cleanup. Both
built-in adapters enforce object identity. Custom adapters must implement this
contract as well. Protocol 2 prevents protocol 1's version-checked but
ownership-unaware cleanup from deleting a protocol 2 entry. Mixed versions do
not coalesce; upgrade cooperating bundles together.
