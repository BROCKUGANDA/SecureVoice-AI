/**
 * Side-effect import for `FxCounterReducedMotion`-style specs: makes
 * `prefers-reduced-motion` answer `true` BEFORE the component graph loads.
 *
 * framer-motion's reduced-motion reader is resolved when the module is first
 * used, so a stub installed in a test body is too late — it would describe the
 * preference for the *next* mount, not this one. Installing it here, at the top
 * of the import list, is what makes the assertion mean what it says.
 *
 * Kept out of `setup.ts` deliberately: the global default there is `false`
 * because every other suite exercises the animated path, and a file that flips
 * the world default would change what those specs prove.
 */
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

export {};
