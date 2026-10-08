/**
 * Home.tsx — the marketing/entry view (1063 lines) that a first-time visitor
 * actually lands on, and the owner of the app's only outbound lead funnel.
 *
 * Two things are under test here beyond "it rendered":
 *   · the CTA wiring. Home has no router: every button mutates the shared
 *     zustand view store that src/app/page.tsx renders from, so the assertions
 *     read the store rather than a URL. `launchDemo` is a two-field write
 *     (view + demoIntent) and Demo consumes `demoIntent` exactly once, which is
 *     the contract a click on "Run the live simulation" has to honour.
 *   · the pilot dialog's validation gate and its POST body. The submit button is
 *     disabled by a predicate over three fields, and a malformed email must keep
 *     it disabled while flipping aria-invalid on the field — that is the only
 *     thing standing between the endpoint and junk intake.
 *
 * global fetch is replaced by a recorder; no network is touched. Radix Dialog
 * portals into document.body, which is what `screen` queries.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useApp } from "@/lib/store";
import { SUPPORT_EMAIL } from "@/lib/public-config";
import { Home } from "@/views/Home";

let calls: { url: string; method: string; body: string }[] = [];
let respond: () => { ok: boolean; payload: Record<string, unknown> } = () => ({
  ok: true,
  payload: { ok: true, ref: "SV-PILOT-42" },
});

beforeEach(() => {
  calls = [];
  respond = () => ({ ok: true, payload: { ok: true, ref: "SV-PILOT-42" } });
  global.fetch = (async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: string };
    calls.push({ url: String(input), method: i.method ?? "GET", body: i.body ?? "" });
    const { ok, payload } = respond();
    return { ok, status: ok ? 200 : 400, json: async () => payload };
  }) as unknown as typeof fetch;
});

/** Opens the intake dialog and returns its role="dialog" container. */
async function openPilot(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Book a pilot" }));
  return screen.findByRole("dialog", { name: /Book a 30-day pilot/ });
}

describe("Home", () => {
  it("renders the hero claim and the three primary CTAs", () => {
    render(<Home />);

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("Fraud detected.");
    expect(h1.textContent).toContain("Call placed.");
    expect(h1.textContent).toContain("Frozen.");

    expect(screen.getByRole("button", { name: "Run the live simulation" })).toBeTruthy();
    // The sign-in and dashboard CTAs are repeated across sections (hero, dark
    // closing band), so the contract is "every instance is a button that works",
    // not "there is exactly one".
    expect(screen.getAllByRole("button", { name: "Explore the dashboard" }).length).toBeGreaterThan(
      1,
    );
    expect(screen.getAllByRole("button", { name: "Sign in to run the platform" }).length).toBeGreaterThan(
      1,
    );
    expect(screen.getByRole("heading", { level: 2, name: "The call, in five steps" })).toBeTruthy();
  });

  it("sends the demo CTA to the store as a one-shot intent, not just a view change", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "Run the live simulation" }));

    const s = useApp.getState();
    expect(s.view).toBe("demo");
    expect(s.demoIntent).toBe(true); // Demo auto-starts playback from this flag
  });

  it("routes every sign-in CTA to the auth view", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const ctas = screen.getAllByRole("button", { name: "Sign in to run the platform" });
    expect(ctas.length).toBeGreaterThan(1);
    for (const cta of ctas) {
      useApp.setState({ view: "home" });
      await user.click(cta);
      expect(useApp.getState().view).toBe("auth");
    }
  });

  it("localises the CTA labels when the store language is Arabic", async () => {
    const user = userEvent.setup();
    useApp.setState({ lang: "ar" });
    render(<Home />);

    expect(screen.queryByRole("button", { name: "Run the live simulation" })).toBeNull();
    expect(screen.getByRole("button", { name: "شغّل المحاكاة الحية" })).toBeTruthy();

    // The wiring survives translation: same button, same store write.
    await user.click(screen.getByRole("button", { name: "شغّل المحاكاة الحية" }));
    expect(useApp.getState().view).toBe("demo");
  });

  it("keeps the pilot request locked until every required field is valid", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const dialog = await openPilot(user);
    const submit = within(dialog).getByRole("button", { name: "Request pilot" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    // Two of three fields: still locked.
    await user.type(within(dialog).getByLabelText("Full name"), "Fatima Al-Rashid");
    await user.type(within(dialog).getByLabelText("Institution"), "Emirates NBD");
    expect(
      within(screen.getByRole("dialog", { name: /Book a 30-day pilot/ })).getByRole("button", {
        name: "Request pilot",
      }).hasAttribute("disabled"),
    ).toBe(true);

    // A malformed address must keep it locked AND flag the field to assistive tech.
    const email = within(dialog).getByLabelText("Work email") as HTMLInputElement;
    await user.type(email, "fatima@bank");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(calls).toHaveLength(0);

    await user.clear(email);
    await user.type(email, "fatima@bank.ae");
    expect(email.getAttribute("aria-invalid")).toBe("false");
    expect(submit.hasAttribute("disabled")).toBe(false);
  });

  it("posts the intake payload and shows the reference the server returned", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const dialog = await openPilot(user);
    await user.type(within(dialog).getByLabelText("Full name"), "Fatima Al-Rashid");
    await user.type(within(dialog).getByLabelText("Work email"), "fatima@bank.ae");
    await user.type(within(dialog).getByLabelText("Institution"), "Emirates NBD");
    await user.selectOptions(within(dialog).getByLabelText("Monthly card volume"), "100k – 1M");
    await user.type(
      within(dialog).getByLabelText(/Anything specific to scope/),
      "CNP fraud on the debit portfolio",
    );

    await user.click(within(dialog).getByRole("button", { name: "Request pilot" }));

    await waitFor(() => expect(calls).toHaveLength(1), { timeout: 4000 });
    expect(calls[0].url).toBe("/api/pilot");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body)).toEqual({
      name: "Fatima Al-Rashid",
      email: "fatima@bank.ae",
      institution: "Emirates NBD",
      role: undefined,
      volume: "100k – 1M",
      message: "CNP fraud on the debit portfolio",
      company_url: "",
      source: "website",
    });

    const done = await screen.findByRole("dialog", { name: /Request received/ }, { timeout: 4000 });
    expect(within(done).getByText("SV-PILOT-42")).toBeTruthy();
    // Only the first name is echoed back, not the whole field.
    expect(within(done).getByText(/Thank you, Fatima\./)).toBeTruthy();
    expect(within(done).queryByRole("button", { name: "Request pilot" })).toBeNull();
  });

  it("reports a rejected request inline instead of failing silently", async () => {
    const user = userEvent.setup();
    respond = () => ({ ok: false, payload: { ok: false, error: "Intake is closed this quarter" } });
    render(<Home />);

    const dialog = await openPilot(user);
    await user.type(within(dialog).getByLabelText("Full name"), "Omar");
    await user.type(within(dialog).getByLabelText("Work email"), "omar@bank.ae");
    await user.type(within(dialog).getByLabelText("Institution"), "AXA Gulf");
    await user.click(within(dialog).getByRole("button", { name: "Request pilot" }));

    const alert = await within(
      await screen.findByRole("dialog", { name: /Book a 30-day pilot/ }, { timeout: 4000 }),
    ).findByRole("alert", {}, { timeout: 4000 });
    expect(alert.textContent).toBe("Intake is closed this quarter");

    // The form is still there to correct and retry — no dead end.
    expect(
      within(screen.getByRole("dialog", { name: /Book a 30-day pilot/ })).getByRole("button", {
        name: "Request pilot",
      }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("carries the support address from public config into the footer of the form", async () => {
    render(<Home />);

    const dialog = await openPilot(userEvent.setup());
    expect(within(dialog).getByText(`Or email ${SUPPORT_EMAIL} — we reply personally`)).toBeTruthy();
  });

  it("routes the deep-dive and use-case teasers through the view store", async () => {
    const user = userEvent.setup();
    render(<Home />);

    // Repeated across sections by design; every instance must land on product.
    for (const cta of screen.getAllByRole("button", { name: "Open the deep dive" })) {
      useApp.setState({ view: "home" });
      await user.click(cta);
      expect(useApp.getState().view).toBe("product");
    }

    useApp.setState({ view: "home" });
    const useCases = screen.getAllByRole("button", { name: "Explore the use cases" });
    for (const cta of useCases) {
      useApp.setState({ view: "home" });
      await user.click(cta);
      expect(useApp.getState().view).toBe("usecases");
    }
  });

  it("jumps from the privacy link inside the dialog to the privacy view", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const dialog = await openPilot(user);
    await user.click(within(dialog).getByRole("button", { name: "Privacy Policy" }));

    expect(useApp.getState().view).toBe("privacy");
  });
});
