/**
 * Registry entries written to a shared adapter (e.g. `window`) carry this
 * version. Independently bundled widgets each ship their own copy of this
 * library, so two entries can disagree about what shape they expect.
 *
 * On a mismatch the safe default is "don't coalesce" — duplicate the call
 * rather than let two incompatible versions read or write shared state.
 * See docs/adr/0001-registry-adapter.md.
 *
 * Bump this only when the RegistryEntry shape changes in a breaking way.
 */
// Version 2 requires ownership-checked release. Version 1 cleanup must not
// recognize and delete entries created under the new lifecycle contract.
export const PROTOCOL_VERSION = "2";
