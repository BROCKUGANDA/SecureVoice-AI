/**
 * `/sign-in` for a signed-out visitor — the React #306 regression.
 *
 * Observed in production: the route returned 200, `src/app/error.tsx` then took
 * the page over with "Something interrupted this view", and the console carried
 * `Minified React error #306`, which decodes to "Element type is invalid.
 * Received a promise that resolves to: [object Module]. Lazy element type must
 * resolve to a class or function." The server was healthy — `/api/health` 200
 * and `/api/auth/get-session` 200 `null` — so the failure was entirely in the
 * client render of the shell that `src/app/sign-in/page.tsx` mounts.
 *
 * The mechanism: `src/app/page.tsx` lazy-loads each view through `next/dynamic`,
 * whose `convertModule` (node_modules/next/dist/shared/lib/dynamic.js) normalises
 * the loaded module as `{ default: mod?.default || mod }`, and react-loadable
 * resolves the element type with the same fallback. A view module without a
 * default export therefore hands React the MODULE NAMESPACE as a component type
 * — hence `[object Module]` in the message. The old `viewChunk` signature
 * (`() => Promise<unknown>` plus an `as` cast) asserted that mapping had already
 * happened instead of checking it, so the shell compiled green while it was
 * loading `@/views/Auth` for a component that module exported by name only.
 *
 * Why it fires for the signed-out path and looked like an outage there: `auth` is
 * `public` in `VIEW_ACCESS`, so the RBAC gate never bounces it, `/sign-in` maps to
 * it in `PATH_FOR_VIEW`, and the gate redirects any gated view a signed-out
 * visitor reaches straight to it. The sign-in form is the one screen this visitor
 * cannot avoid — and the one chunk that could not mount.
 *
 * The 401 on `/api/auth/organization/get-active-member` in the same console is
 * the better-auth organization plugin answering a signed-out browser, and
 * `useViewerSeat` treats it as "no seat yet"; it is noise here, not the throw.
 */
import { screen } from "@testing-library/react";
import AppRoot from "@/app/page";
import { useApp } from "@/lib/store";
import { boundaryError, renderCapturing } from "./capture-boundary";

// `mock`-prefixed so the hoisted jest.mock factory can close over it. The shape
// is the real signed-out one: `get-session` answers 200 with `null`, and the
// organization plugin's member query answers 401, which the client surfaces as
// `{ data: null, error }` on a settled (non-pending) query.
const mockSession = { current: null as unknown };

jest.mock("../src/lib/auth-client", () => ({
  useSession: () => ({ data: mockSession.current, isPending: false }),
  signIn: { email: jest.fn(), social: jest.fn() },
  signUp: { email: jest.fn() },
  signOut: jest.fn(async () => ({ data: null, error: null })),
  authClient: {
    useActiveMember: () => ({
      data: null,
      isPending: false,
      error: { status: 401, message: "Unauthorized" },
    }),
    setActive: jest.fn(),
  },
}));

beforeEach(() => {
  mockSession.current = null;
  // The store starts on `home` exactly as it does in a browser; the shell's own
  // mount effect reads the address bar and selects the view, so this spec drives
  // the same code path the visitor took rather than pre-setting the store.
  useApp.setState({ view: "home" });
  window.history.replaceState({}, "", "/sign-in");
});

describe("signed-out /sign-in", () => {
  it("renders the sign-in form instead of throwing while mounting the auth chunk", async () => {
    renderCapturing(<AppRoot />);

    // The chunk resolves after the first commit, so the wait is the test: the
    // defect was invisible on mount and only appeared when the lazy view resolved.
    await screen.findByRole("heading", { level: 2, name: "Sign in" });

    // Scoped to the auth panel's own copy, not `getByRole("heading", {level: 1})`:
    // `AnimatePresence` in src/app/page.tsx keeps the exiting view mounted while
    // its exit animation runs, and jsdom never advances one, so the Home hero's
    // h1 is still in the document. Asserting inside the view under test is both
    // honest and stable.
    expect(screen.getByText(/Welcome to SecureVoice/)).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
    expect(boundaryError()).toBeNull();
  });

  it("keeps the visitor on the sign-in view — no session, no bounce", async () => {
    renderCapturing(<AppRoot />);
    await screen.findByRole("heading", { level: 2, name: "Sign in" });

    // `auth` is a public view: a signed-out visitor must be able to sit on it and
    // type credentials. A bounce away from it is the gate reading "no seat" as
    // "go sign in", which is a loop when this IS the sign-in view.
    expect(useApp.getState().view).toBe("auth");
    expect(window.location.pathname).toBe("/sign-in");
    expect(boundaryError()).toBeNull();
  });

  it("offers the pilot intake beside the form, which is what a visitor without an account needs", async () => {
    renderCapturing(<AppRoot />);
    await screen.findByRole("heading", { level: 2, name: "Request a pilot" });

    expect(screen.getByPlaceholderText("Full name")).toBeTruthy();
    expect(screen.getByPlaceholderText("Work email")).toBeTruthy();
    expect(screen.getByPlaceholderText("Bank or insurer")).toBeTruthy();
    expect(boundaryError()).toBeNull();
  });
});
