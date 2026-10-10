import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useApp } from "@/lib/store";
import { TwoFactorPrompt } from "@/components/security/TwoFactorPrompt";

/**
 * TwoFactorPrompt — when the second-factor nudge is allowed to speak.
 *
 * The conditions are the contract, so they are what is tested: signed in, the
 * SERVER flag says no second factor, and the operator has not already said
 * "not now" in this browser. A prompt that appears for a signed-out visitor,
 * or keeps nagging an account that already has 2FA, is not a cosmetic bug —
 * it trains the operator to dismiss security warnings.
 */

// `mock`-prefixed so the hoisted jest.mock factory can close over it.
const mockSession = {
  current: null as null | { user: Record<string, unknown> },
};

// NOTE the relative specifier: `jest.mock()` resolves its path argument with the
// plain resolver, not through next/jest's tsconfig `paths` mapping, so an "@/…"
// mock target fails with "Cannot find module". Both specifiers resolve to the
// same real path, which is what the mock registry keys on, so this still
// intercepts the aliased import inside the component.
jest.mock("../src/lib/auth-client", () => ({
  // `useSession()` really returns `{ data, isPending, ... }`, so the mock must
  // too — returning the bare session would leave `data` undefined and the
  // prompt would read a signed-out visitor.
  useSession: () => ({ data: mockSession.current, isPending: false }),
  authClient: {
    getSession: jest.fn(() => Promise.resolve({ data: null })),
  },
}));

const DISMISS_KEY = "sv:2fa-prompt-dismissed:v1";

function signIn(twoFactorEnabled: boolean) {
  mockSession.current = { user: { id: "u_1", email: "a@bank.ae", twoFactorEnabled } };
}

beforeEach(() => {
  window.localStorage.clear();
  mockSession.current = null;
});

afterEach(() => {
  window.localStorage.clear();
});

describe("TwoFactorPrompt", () => {
  it("stays silent for a signed-out visitor — there is no session to protect yet", () => {
    mockSession.current = null;
    render(<TwoFactorPrompt />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("speaks once for a signed-in account with no second factor", async () => {
    signIn(false);
    render(<TwoFactorPrompt />);
    expect(await screen.findByRole("heading", { name: /second sign-in step/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn on two-factor/i })).toBeTruthy();
  });

  it("says nothing at all when the account already has two-factor on", async () => {
    signIn(true);
    render(<TwoFactorPrompt />);
    // Give the post-mount dismissal read a chance to settle before asserting.
    await waitFor(() => {
      expect(screen.queryByRole("heading")).toBeNull();
    });
  });

  it("remembers 'not now' so the operator is not nagged on the next view", async () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    signIn(false);
    render(<TwoFactorPrompt />);
    await waitFor(() => {
      expect(screen.queryByRole("heading")).toBeNull();
    });
  });

  it("persists the dismissal when the operator clicks 'Not now'", async () => {
    const user = userEvent.setup();
    signIn(false);
    render(<TwoFactorPrompt />);
    await user.click(await screen.findByRole("button", { name: /not now/i }));
    expect(window.localStorage.getItem(DISMISS_KEY)).toBe("1");
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("lands the operator on the Settings security tab, not the default tab", async () => {
    const user = userEvent.setup();
    signIn(false);
    render(<TwoFactorPrompt />);
    await user.click(await screen.findByRole("button", { name: /turn on two-factor/i }));
    expect(useApp.getState().view).toBe("settings");
    expect(useApp.getState().settingsTab).toBe("security");
  });
});
