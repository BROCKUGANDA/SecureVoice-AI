/// <reference types="cypress" />

/**
 * The app's primary journey, driven through a real browser.
 *
 * Why these five specs and not a page-object per view: the product is a single
 * route (src/app/page.tsx) whose "navigation" is a client-side switch over the
 * zustand `view` field, gated by VIEW_ACCESS. So the three things that can
 * actually break in production and are invisible to unit tests are (1) the shell
 * boots at all, (2) the gate lets the right people through, (3) the one public
 * write path reaches the endpoint with the right body. Each spec below is one of
 * those, plus the two cross-layer effects (document lang, high-contrast
 * attribute) that only exist once a browser runs the code.
 *
 * Locators are role/label/visible text only — src/ has no data-testid attributes
 * and this task may not add any.
 *
 * The intake spec stubs POST /api/pilot. That is deliberate: a green e2e run must
 * not write lead rows into the database this deployment is pointed at. The stub is
 * asserted (the route must be hit with the right payload), so the request path is
 * still covered — only its destination is faked.
 */

const PRIMARY_NAV = 'nav[aria-label="Primary"]';
const LANG_GROUP = '[role="group"][aria-label="Language"]';

describe("SecureVoice AI — browser tier", () => {
  beforeEach(() => {
    cy.visitBooted();
  });

  it("boots past the splash into the fraud-intervention hero", () => {
    cy.get("main#main-content").should("exist");
    cy.get("h1").should("contain.text", "Fraud detected.").and("contain.text", "Call placed.");
    // The three entry paths a first-time visitor is offered.
    cy.contains("button", "Run the live simulation").should("be.visible");
    cy.contains("button", "Explore the dashboard").should("be.visible");
    cy.contains("button", "Sign in to run the platform").should("be.visible");
    // Keyboard users get the skip link before anything else in the tab order.
    cy.contains("a", "Skip to content").should("exist");
  });

  it("switches public views without a route change, because there is only one route", () => {
    // Nothing about this app is a URL: the address must not move while the view
    // changes under it.
    cy.location("pathname").should("eq", "/");

    cy.get(PRIMARY_NAV).contains("button", "Docs").click();
    cy.get("h1").should("contain.text", "Integrate SecureVoice in an afternoon");
    cy.location("pathname").should("eq", "/");

    cy.get(PRIMARY_NAV).contains("button", "Security").click();
    cy.get("h1").should("contain.text", "Built for the regulator, proven in the region");
    cy.location("pathname").should("eq", "/");

    cy.get(PRIMARY_NAV).contains("button", "Overview").click();
    cy.get("h1").should("contain.text", "Fraud detected.");
  });

  it("enforces the view gate in the browser: a signed-out click lands on auth, not the console", () => {
    // VIEW_ACCESS marks dashboard "user". src/app/page.tsx redirects an
    // unauthenticated switch to the auth view — this is the affordance half of
    // the gate, and the only way to see it is to click it as a visitor.
    cy.contains("button", "Explore the dashboard").click();

    cy.get("h1").should("contain.text", "Welcome to SecureVoice");
    cy.location("pathname").should("eq", "/");
    // The gated surface must not be reachable behind the redirect.
    cy.contains("button", "Simulate fraud alert").should("not.exist");
  });

  it("flips the document language and the copy from the labelled toggle", () => {
    // page.tsx writes document.documentElement.lang from the store; assistive
    // tech reads that attribute, not the class list, so it is the assertion.
    cy.get("html").should("have.attr", "lang", "en");

    cy.get(LANG_GROUP).contains("button", "عربي").click();

    cy.get("html").should("have.attr", "lang", "ar");
    cy.contains("button", "شغّل المحاكاة الحية").should("be.visible");
    cy.contains("button", "Run the live simulation").should("not.exist");

    cy.get(LANG_GROUP).contains("button", "EN").click();
    cy.get("html").should("have.attr", "lang", "en");
    cy.contains("button", "Run the live simulation").should("be.visible");
  });

  it("holds the pilot intake shut until the fields are valid, then posts them", () => {
    cy.intercept("POST", "/api/pilot", {
      statusCode: 200,
      body: { ok: true, ref: "SV-CY-0001" },
    }).as("pilot");

    cy.contains("button", "Book a pilot").click();
    cy.get('[role="dialog"]').should("contain.text", "Book a 30-day pilot");

    // Gating: the submit control is disabled while required fields are empty.
    cy.contains("button", "Request pilot").should("be.disabled");

    cy.get("#pilot-name").type("Cypress Operator");
    cy.get("#pilot-email").type("bad-email");
    cy.get("#pilot-bank").type("Test Bank");
    // A malformed address keeps the gate shut AND flags the field for AT.
    cy.contains("button", "Request pilot").should("be.disabled");
    cy.get("#pilot-email").should("have.attr", "aria-invalid", "true");

    cy.get("#pilot-email").clear().type("operator@cy.test");
    cy.contains("button", "Request pilot").should("not.be.disabled");
    cy.get("#pilot-email").should("have.attr", "aria-invalid", "false");

    cy.contains("button", "Request pilot").click();

    cy.wait("@pilot").its("request.body").should("deep.include", {
      name: "Cypress Operator",
      email: "operator@cy.test",
      institution: "Test Bank",
      source: "website",
      // The honeypot is hidden from humans; a scripted fill would show up here.
      company_url: "",
    });

    cy.get('[role="dialog"]').should("contain.text", "Request received");
    cy.get('[role="dialog"]').should("contain.text", "SV-CY-0001");
  });
});
