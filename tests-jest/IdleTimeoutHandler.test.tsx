import { act, render } from "@testing-library/react";
import { IdleTimeoutHandler } from "@/components/shell/IdleTimeoutHandler";

/**
 * IdleTimeoutHandler — the timeout must lock the screen, and must fire once.
 *
 * Both halves of this exist because of a shipped defect, not as coverage. Until
 * 2026-10-23 the effect declared its callback `const onTimeout`, shadowing the
 * `onTimeout` prop in the same scope, so the last statement of the body called
 * itself. Every frame issued a logout POST before recursing, and the stack only
 * gave up after thousands of them — measured on production as 751
 * `POST /api/auth/logout` inside one minute, which drained the edge rate-limit
 * bucket and 429'd unrelated routes for other visitors.
 *
 * The storm was the loud half. The quiet half is that the prop was never reached,
 * so `setTimedOut(true)` and `setView("auth")` never ran and the idle lockout
 * never locked anything. A security control whose only observable effect was a
 * request flood.
 *
 * Test 1 is the one that would have caught the silent half. Test 2 is the one that
 * catches the loud half. Neither is a proxy for the other: a fix that restored the
 * prop call but not the once-only guard would pass test 1 and still DoS the box.
 */

// `mock`-prefixed so the hoisted jest.mock factory can close over it.
const mockSession = { current: null as null | { user: Record<string, unknown> } };
const mockSignOut = jest.fn(() => Promise.resolve({ data: null }));
const mockFetch = jest.fn(() => Promise.resolve({ ok: true } as unknown as Response));

// Relative specifier: jest.mock() resolves its path argument with the plain
// resolver, not through next/jest's tsconfig `paths` mapping (see the note in
// TwoFactorPrompt.test.tsx). The component imports both names from here.
jest.mock("../src/lib/auth-client", () => ({
  useSession: () => ({ data: mockSession.current, isPending: false }),
  signOut: () => mockSignOut(),
}));

// The component's own default, read at module scope from
// NEXT_PUBLIC_IDLE_TIMEOUT_MS. Nothing in .env sets it, so the fallback is what
// ships — and if that ever changes, this constant is the thing to update.
const IDLE_MS = 900_000;

beforeEach(() => {
  jest.useFakeTimers();
  mockSession.current = { user: { id: "u_1", email: "a@bank.ae" } };
  mockSignOut.mockClear();
  mockFetch.mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

function fireIdle() {
  act(() => {
    jest.advanceTimersByTime(IDLE_MS + 1);
  });
}

describe("IdleTimeoutHandler", () => {
  it("hands control to the onTimeout prop, so the screen actually locks", () => {
    const onTimeout = jest.fn();
    render(<IdleTimeoutHandler onTimeout={onTimeout} />);

    expect(() => fireIdle()).not.toThrow();

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("revokes both session systems exactly once — no request storm", () => {
    render(<IdleTimeoutHandler onTimeout={jest.fn()} />);
    fireIdle();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("posts the first-party logout, not only Better Auth's signOut", () => {
    render(<IdleTimeoutHandler onTimeout={jest.fn()} />);
    fireIdle();

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
    // Magic link mints only `sv_session`, which `signOut()` cannot revoke, and
    // requireAuth reads this one. Dropping it re-opens the "signed out but still
    // authorised" hole the backstop exists to close.
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("does not fire while the operator is active", () => {
    const onTimeout = jest.fn();
    render(<IdleTimeoutHandler onTimeout={onTimeout} />);

    act(() => {
      jest.advanceTimersByTime(IDLE_MS - 1000);
      window.dispatchEvent(new Event("mousemove"));
    });
    act(() => {
      jest.advanceTimersByTime(IDLE_MS - 1000);
    });

    expect(onTimeout).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stays disarmed for a signed-out visitor — there is no session to expire", () => {
    mockSession.current = null;
    const onTimeout = jest.fn();
    render(<IdleTimeoutHandler onTimeout={onTimeout} />);

    fireIdle();

    expect(onTimeout).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
