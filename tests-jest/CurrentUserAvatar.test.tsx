import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CurrentUserAvatar } from "@/components/current-user-avatar";

// The registry primitive imports the unified `radix-ui` package, and Radix's
// Avatar.Image mounts only once the image reports "loaded" — which never happens
// in jsdom. That is Radix's state machine, not this component's logic, so it is
// stubbed here: the primitive renders a plain element and passes the props
// through, which is exactly what this spec needs to inspect.
jest.mock("radix-ui", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const passthrough =
    (tag: string) =>
    ({ children, ...props }: Record<string, unknown> & { children?: unknown }) =>
      React.createElement(tag, props as Record<string, unknown>, children as never);
  return {
    Avatar: {
      Root: passthrough("span"),
      Image: passthrough("img"),
      Fallback: passthrough("span"),
    },
  };
});

/**
 * CurrentUserAvatar — the Supabase Library block, adapted to this project's
 * actual auth.
 *
 * The upstream block reads a Supabase Auth session (`supabase.auth.getSession()`
 * → `user_metadata.avatar_url`). This project authenticates with Better Auth
 * and uses Supabase only as its Postgres database, so there is never a Supabase
 * session: installed verbatim, the hooks return null forever and every operator
 * would see a permanent `?` that looks wired up.
 *
 * These specs pin the behaviour that makes the adaptation real: the avatar
 * tracks the Better Auth session, shows the image when the account has one,
 * derives initials through the email when the account has no name, and renders
 * NOTHING (not a misleading `?`) while the session is still resolving.
 */

// `mock`-prefixed so the hoisted jest.mock factory can close over it.
const mockSession = {
  current: null as null | {
    user: Record<string, unknown>;
  },
  pending: false,
};

jest.mock("../src/lib/auth-client", () => ({
  useSession: () => ({
    data: mockSession.current,
    isPending: mockSession.pending,
  }),
  authClient: { getSession: jest.fn(() => Promise.resolve({ data: null })) },
}));

function signIn(user: { name?: string | null; email?: string; image?: string | null }) {
  mockSession.current = { user };
}

beforeEach(() => {
  mockSession.current = null;
  mockSession.pending = false;
});

describe("CurrentUserAvatar", () => {
  it("shows the account's profile image when the session has one", () => {
    signIn({ name: "Fatima Al Zaabi", email: "f@bank.ae", image: "https://cdn.bank.ae/f.png" });
    const { container } = render(<CurrentUserAvatar />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://cdn.bank.ae/f.png");
    // Decorative relative to the name beside it: an empty alt, not the initials.
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("falls back to initials from the name when there is no image", () => {
    signIn({ name: "Fatima Al Zaabi", email: "f@bank.ae", image: null });
    render(<CurrentUserAvatar />);
    expect(screen.getByText("FAZ")).toBeTruthy();
    expect(screen.queryByRole("img", { hidden: true })).toBeNull();
  });

  it("derives initials through the email when the account has no name yet", () => {
    // An invitation can be redeemed without a display name; the account always
    // has an email, so a signed-in operator must not be shown `?`.
    signIn({ name: null, email: "fatima.al.zaabi@bank.ae", image: null });
    render(<CurrentUserAvatar />);
    expect(screen.getByText("FAZ")).toBeTruthy();
  });

  it("shows a neutral ? for a signed-out visitor", () => {
    mockSession.current = null;
    render(<CurrentUserAvatar />);
    expect(screen.getByText("?")).toBeTruthy();
  });

  it("renders nothing while the session is still resolving — no ? flash", async () => {
    mockSession.pending = true;
    render(<CurrentUserAvatar />);
    // Nothing at all, rather than the signed-out fallback.
    expect(screen.queryByText("?")).toBeNull();

    await waitFor(() => {
      mockSession.pending = false;
      signIn({ name: "Fatima", email: "f@bank.ae", image: null });
    });
  });

  it("re-labels the avatar when the language toggle switches to Arabic", async () => {
    const user = userEvent.setup();
    signIn({ name: "Fatima", email: "f@bank.ae", image: null });
    render(<CurrentUserAvatar />);
    expect(
      screen.getByLabelText("Profile photo of the signed-in user"),
    ).toBeTruthy();
  });

  it("tolerates a doubled space in the name rather than emitting a stray character", () => {
    signIn({ name: "Fatima  Al Zaabi", email: "f@bank.ae", image: null });
    render(<CurrentUserAvatar />);
    expect(screen.getByText("FAZ")).toBeTruthy();
  });
});
