/**
 * The shell must bind a lazy view to a COMPONENT, never to a module namespace.
 *
 * This is the /sign-in crash of React #306 ("Element type is invalid. Received a
 * promise that resolves to: [object Module]. Lazy element type must resolve to a
 * class or function."), pinned down to the one line that produced it.
 *
 * `next/dynamic` normalises the loaded module with `convertModule`
 * (node_modules/next/dist/shared/lib/dynamic.js):
 *
 *     return { default: mod?.default || mod };
 *
 * and react-loadable picks the element type with the same fallback
 * (`obj.default ? obj.default : obj`). A view module that has no default export
 * is therefore NOT an error at import time — the namespace object itself becomes
 * the React element type, and the reconciler throws when it mounts. `auth` is a
 * `public` view in `VIEW_ACCESS` and `/sign-in` maps to it, so a signed-out
 * visitor hit it every time: HTTP 200, then `src/app/error.tsx`.
 *
 * The mock below is the shipped shape of `src/views/Auth.tsx` — component as a
 * named export, no default — held in place of the real module so the shell's
 * binding is what is under test. `__esModule: true` is load-bearing: without it
 * the CommonJS interop helper synthesises a `default` pointing at the whole
 * module, which hides the defect instead of reproducing it.
 */
import { screen } from "@testing-library/react";
import AppRoot from "@/app/page";
import { useApp } from "@/lib/store";
import { boundaryError, renderCapturing } from "./capture-boundary";

const mockSession = { current: null as unknown };

jest.mock("../src/lib/auth-client", () => ({
  useSession: () => ({ data: mockSession.current, isPending: false }),
  signIn: { email: jest.fn(), social: jest.fn() },
  signUp: { email: jest.fn() },
  signOut: jest.fn(async () => ({ data: null, error: null })),
  authClient: {
    useActiveMember: () => ({ data: null, isPending: false, error: { status: 401 } }),
    setActive: jest.fn(),
  },
}));

/** Stands in for the real `Auth` view: a component, exported BY NAME only. */
function mockNamedOnlyAuth() {
  return <div data-testid="auth-chunk-mounted">auth view, bound through its named export</div>;
}

jest.mock("../src/views/Auth", () => ({
  __esModule: true,
  Auth: mockNamedOnlyAuth,
}));

beforeEach(() => {
  mockSession.current = null;
  useApp.setState({ view: "home" });
  window.history.replaceState({}, "", "/sign-in");
});

describe("the shell's lazy view binding", () => {
  it("mounts the auth view from a module that exports it by name only", async () => {
    renderCapturing(<AppRoot />);

    // Pre-fix this await never resolves and the boundary holds React's
    // "Element type is invalid" throw: the loader handed `dynamic` a bare
    // `import("@/views/Auth")` and the namespace fell through as the type.
    await screen.findByTestId("auth-chunk-mounted");
    expect(boundaryError()).toBeNull();
    expect(useApp.getState().view).toBe("auth");
  });
});
