/// <reference types="cypress" />

/**
 * Cypress support file for the browser tier.
 *
 * Uncaught exceptions are NOT blanket-suppressed. Swallowing them is how an e2e
 * suite goes green while the app is broken, so everything fails the spec except
 * the one class below, which is a known spurious signal rather than a defect —
 * and if a second is ever added here it has to be justified the same way.
 */
const SPURIOUS = [
  // Chrome and Edge fire this when layout work lands after the frame it belongs
  // to. It carries no user-visible failure and the app has no resize feedback
  // loop, so it is noise here; it is not the same as ignoring a thrown error.
  /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i,
];

Cypress.on("uncaught:exception", (error) => {
  const message = `${error.name}: ${error.message}`;
  if (SPURIOUS.some((pattern) => pattern.test(message))) return false;
  // Returning true is Cypress's "fail the test" verdict. Everything that is not
  // in SPURIOUS lands here.
  return true;
});

/**
 * Loads the app and waits for the first-boot splash to unmount.
 *
 * The splash is a `fixed inset-0 z-[100]` overlay (src/components/shell/
 * LoadingScreen.tsx) with no accessible name and no test hook, and `z-[100]`
 * occurs exactly once in the served document — verified against the rendered
 * HTML rather than assumed. Waiting on its removal is what makes the rest of a
 * spec's clicks meaningful: while it is mounted it swallows every pointer event,
 * so a spec that ignored it would be clicking an interface no user could.
 */
function visitBooted(): void {
  cy.visit("/");
  cy.get('div[class*="z-[100]"]').should("exist");
  cy.get('div[class*="z-[100]"]').should("not.exist");
}

Cypress.Commands.add("visitBooted", visitBooted);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Cypress documents this augmentation with a namespace
  namespace Cypress {
    interface Chainable {
      visitBooted(): Chainable<void>;
    }
  }
}

export {};
