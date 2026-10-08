/**
 * Demo.tsx — the live fraud-intervention simulation: the largest view in the e2e
 * tier (1482 lines) and the one `bun test` could never execute.
 *
 * What is mocked and why:
 *   · @/lib/voice-client — server TTS plus browser speech synthesis. Replaced
 *     with call-recording stubs (real exports kept for their data) so the
 *     playback clock is not entangled with audio promises, and so the specs can
 *     assert the component's OWN rule that speech is only requested while
 *     "Agent audio" is on.
 *   · global fetch — only for /api/agent, which ConversationPanel posts to. The
 *     harness records url/method/body instead of touching a network.
 * Everything else is the real component, the real scenario library and the real
 * zustand store.
 *
 * Timing note: playback is a 100ms setInterval, so elapsed-time assertions would
 * be races. The component exposes a deterministic fast-forward — Skip sets time
 * to SCENARIO_TOTAL in one act — so the specs drive state through that instead
 * of waiting on the clock. The one spec that must let the clock run says so and
 * derives its budget from the scenario grid.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SCENARIO_TOTAL } from "@/lib/scenario";
import { speakText, prefetchSpeech, stopVoice } from "@/lib/voice-client";
import { useApp } from "@/lib/store";
import { Demo } from "@/views/Demo";

// NOTE the relative specifier: `jest.mock()` resolves its path argument with the
// plain resolver, not through next/jest's tsconfig `paths` mapping, so an "@/…"
// mock target fails with "Cannot find module". Both specifiers resolve to the
// same real path, which is what the mock registry keys on, so this still
// intercepts the aliased import inside src/views/Demo.tsx.
jest.mock("../src/lib/voice-client", () => {
  const actual = jest.requireActual<Record<string, unknown>>("../src/lib/voice-client");
  return {
    ...actual,
    speakText: jest.fn(() => Promise.resolve(false)),
    streamSpeech: jest.fn(() => Promise.resolve({ streamed: false, bargeIn: false })),
    stopVoice: jest.fn(),
    prefetchSpeech: jest.fn(),
    blobToWavBase64: jest.fn(() => Promise.resolve("")),
  };
});

/** Recorded /api/agent calls; `respond` is set per spec. */
let agentCalls: { url: string; method: string; body: string }[] = [];
let respond: () => { ok: boolean; payload: Record<string, unknown> } = () => ({
  ok: true,
  payload: { reply: "Thank you. Freezing the card now." },
});

function mockCalls(fn: unknown): unknown[][] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls;
}

/** The mm:ss readout the stage header shows once the grid is exhausted. */
function endClock(): string {
  const elapsed = Math.floor(SCENARIO_TOTAL);
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
}

beforeEach(() => {
  agentCalls = [];
  respond = () => ({ ok: true, payload: { reply: "Thank you. Freezing the card now." } });
  global.fetch = (async (input: unknown, init?: unknown) => {
    const i = (init ?? {}) as { method?: string; body?: string };
    agentCalls.push({ url: String(input), method: i.method ?? "GET", body: i.body ?? "" });
    const { ok, payload } = respond();
    return { ok, status: ok ? 200 : 500, json: async () => payload };
  }) as unknown as typeof fetch;
});

describe("Demo", () => {
  it("renders the armed scenario and marks exactly one card as selected", () => {
    render(<Demo />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "One fraud alert. One minute. Watch the intervention.",
      }),
    ).toBeTruthy();

    const card = screen.getByRole("button", { name: /Card-not-present fraud/ });
    const atm = screen.getByRole("button", { name: /ATM cash-out/ });
    expect(card.getAttribute("aria-pressed")).toBe("true");
    expect(atm.getAttribute("aria-pressed")).toBe("false");

    // Nothing of the live case is on screen before the alert is fired: the ops
    // rail is skeleton, the stage is standing by, and the call is not recorded.
    expect(screen.queryByText("Risk score")).toBeNull();
    expect(screen.queryByText("REC")).toBeNull();
    expect(screen.getByText("Standing by for the next fraud signal")).toBeTruthy();
  });

  it("re-arms a different scenario through the picker", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    const atm = screen.getByRole("button", { name: /ATM cash-out/ });
    await user.click(atm);

    expect(atm.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: /Card-not-present fraud/ }).getAttribute("aria-pressed"),
    ).toBe("false");

    // The standby block now names the newly armed case, not the default one.
    const standby = screen.getByText("Standing by for the next fraud signal").parentElement;
    expect(within(standby as HTMLElement).getByText("ATM cash-out")).toBeTruthy();
    expect(within(standby as HTMLElement).queryByText("Card-not-present fraud")).toBeNull();
  });

  it("starts playback: the CTA swaps for transport controls and the case fills in", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));

    expect(screen.queryByRole("button", { name: "Simulate fraud alert" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" })).toBeTruthy();
    expect(screen.getByText("Risk score")).toBeTruthy();
    expect(screen.getByText("Fraud Alert")).toBeTruthy();
    expect(screen.queryByText("Standing by for the next fraud signal")).toBeNull();
    expect(screen.getByText("REC")).toBeTruthy();
  });

  it("pauses and resumes through one labelled control", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });

  it("fast-forwards to the outcome: the call closes and the banner states the loss prevented", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.getByText(endClock())).toBeTruthy();
    // Running to the end stops the clock, so the transport toggle re-labels to
    // "Play" — and both it and Skip are disabled because there is nothing left.
    expect(screen.getByRole("button", { name: "Play" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Skip" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByText("REC")).toBeNull();
    expect(screen.getByText("Outcome · تم الحل")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replay simulation" })).toBeTruthy();
    expect(screen.getByText(/vs 38 minutes today/)).toBeTruthy();
  });

  it("replays from the outcome banner back to a running call", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "Replay simulation" }));

    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Skip" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("REC")).toBeTruthy();
    // The banner is inside <AnimatePresence>, so it leaves on its exit animation
    // rather than on the click.
    await waitFor(() => expect(screen.queryByText("Outcome · تم الحل")).toBeNull(), {
      timeout: 4000,
    });
  });

  it("hands the first spoken line to synthesis once the call reaches it", async () => {
    render(<Demo />);

    expect(mockCalls(speakText)).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Simulate fraud alert" }));

    // The clock advances 0.1s of scenario time per 100ms of wall time at the
    // default 2x speed (src/views/Demo.tsx:110,145), and the first line whose
    // `speaker` is agent/customer sits at t=9 in every scenario — so speech is
    // due 4.5s of real time after the alert fires. This budget is derived from
    // the scenario grid, it is not flake tolerance.
    const SPEED = 2;
    const FIRST_SPOKEN_T = 9;
    const speechDueMs = (FIRST_SPOKEN_T / (0.1 * SPEED)) * 100;

    await waitFor(() => expect(mockCalls(speakText).length).toBeGreaterThan(0), {
      timeout: speechDueMs + 3000,
    });
    expect(mockCalls(prefetchSpeech).length).toBeGreaterThan(0);
  });

  it("keeps speech out of the pipeline while agent audio is off", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    const audio = screen.getByRole("button", { name: /Agent audio on/ });
    expect(audio.getAttribute("aria-pressed")).toBe("true");
    await user.click(audio);
    expect(
      screen.getByRole("button", { name: /Agent audio off/ }).getAttribute("aria-pressed"),
    ).toBe("false");

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    // Let any effect that would have spoken settle before asserting silence.
    await new Promise((r) => setTimeout(r, 250));
    expect(mockCalls(speakText)).toHaveLength(0);
  });

  it("switches the call language and re-labels the voice the stage will use", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    expect(screen.getByText(/CALL IN ENGLISH · MARCUS \(EN-UK\)/)).toBeTruthy();

    const arabic = screen.getByRole("button", { name: "عربي" });
    await user.click(arabic);

    expect(arabic.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/CALL IN العربية · FATIMA \(AR-GULF\)/)).toBeTruthy();
    // Changing language must drop whatever was queued to speak.
    expect(mockCalls(stopVoice).length).toBeGreaterThan(0);
  });

  it("routes a typed customer reply through /api/agent into the live transcript", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    const log = screen.getByRole("log", { name: "Live conversation transcript" });
    expect(log.textContent).toContain("No turns yet");

    const input = screen.getByRole("textbox", { name: "Type your answer" });
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.hasAttribute("disabled")).toBe(true); // empty composer, nothing to route

    await user.type(input, "that transaction is not mine");
    expect(send.hasAttribute("disabled")).toBe(false);

    await user.click(send);

    await waitFor(() => expect(log.textContent).toContain("Freezing the card now."), {
      timeout: 4000,
    });
    expect(log.textContent).toContain("that transaction is not mine");
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0].url).toBe("/api/agent");
    expect(agentCalls[0].method).toBe("POST");
    expect(JSON.parse(agentCalls[0].body)).toEqual({
      text: "that transaction is not mine",
      lang: "en",
    });
    // The composer is cleared for the next turn.
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("surfaces an agent outage instead of swallowing it", async () => {
    const user = userEvent.setup();
    respond = () => ({ ok: false, payload: { error: "Agent unavailable" } });
    render(<Demo />);

    await user.type(screen.getByRole("textbox", { name: "Type your answer" }), "no");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(
      () =>
        expect(
          screen.getByText("The agent did not respond — try again or type your answer."),
        ).toBeTruthy(),
      { timeout: 4000 },
    );
    expect(screen.getByRole("log", { name: "Live conversation transcript" }).textContent).toContain(
      "no",
    );
  });

  it("refuses the microphone path in a browser that has none, and says so", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Start recording" }));

    expect(screen.getByText("Microphone unsupported here — type your answer below.")).toBeTruthy();
    expect(agentCalls).toHaveLength(0);
  });

  it("shows where the call is in the seven-phase script and advances it", async () => {
    const user = userEvent.setup();
    render(<Demo />);

    // Idle: nothing revealed, so the stepper reports the first of seven phases.
    expect(screen.getByText(/01\/07 · Fraud Signal/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));

    expect(screen.getByText(/07\/07 · Human Handoff/)).toBeTruthy();
  });

  it("drives the shared view store so the shell can switch pages", async () => {
    const user = userEvent.setup();
    useApp.setState({ demoIntent: false });
    render(<Demo />);

    await user.click(screen.getByRole("button", { name: "Simulate fraud alert" }));
    await user.click(screen.getByRole("button", { name: "Skip" }));
    await user.click(screen.getByRole("button", { name: "See it in the dashboard" }));

    expect(useApp.getState().view).toBe("dashboard");
  });
});
