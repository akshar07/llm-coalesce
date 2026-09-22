// React 18's `act()` needs this flag set in non-browser test environments
// (jsdom via Vitest) or it warns that updates aren't wrapped in `act(...)`
// even when they are.
export {};

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
