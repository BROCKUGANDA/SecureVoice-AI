/**
 * Jest setup for the view tier (jest.config.cjs -> setupFilesAfterEnv).
 *
 * Two jobs, and only two:
 *   1. Fill the jsdom holes the views actually hit. Every entry below corresponds
 *      to a call site in src/, not to a generic wishlist: `scrollIntoView` and
 *      `scrollTo` are used by the Demo transcript autoscroll
 *      (src/views/Demo.tsx:218 and :1066), `matchMedia` by the high-contrast
 *      default in src/lib/store.ts:56, canvas `getContext` and `ResizeObserver`
 *      by src/components/fx/Waveform.tsx:35 and :51 (which already bail when
 *      `getContext` yields null), `IntersectionObserver` by framer-motion's
 *      `whileInView` in src/components/fx/core.tsx.
 *      Deliberately NOT stubbed: `navigator.mediaDevices`. src/views/Demo.tsx
 *      branches on exactly that absence, and a spec asserts the resulting
 *      "Microphone unsupported here" message — a real degradation path, not a
 *      harness artefact.
 *   2. Reset the zustand store between specs. useApp() is module-level state, so
 *      without this a setView() from one spec leaks into the next and failures
 *      become order-dependent.
 */
import { cleanup } from "@testing-library/react";
import { useApp } from "@/lib/store";

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    configurable: true,
  });
}

define(Element.prototype, "scrollIntoView", () => {});
define(Element.prototype, "scrollTo", () => {});
define(window, "scrollTo", () => {});
define(window, "scroll", () => {});

define(window, "matchMedia", (query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
define(globalThis, "ResizeObserver", FakeResizeObserver);

class FakeIntersectionObserver {
  root = null;
  rootMargin = "0px";
  thresholds: number[] = [];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
define(globalThis, "IntersectionObserver", FakeIntersectionObserver);

// jsdom's canvas getContext raises a "Not implemented" virtual-console error and
// yields null; Waveform guards on null, so make the null explicit and quiet.
define(HTMLCanvasElement.prototype, "getContext", () => null);

afterEach(() => {
  cleanup();
  useApp.setState({
    view: "home",
    lang: "en",
    booted: true,
    demoIntent: false,
    timedOut: false,
    highContrast: false,
  });
});
