import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TwoFactorCard } from "@/components/security/TwoFactorCard";

/**
 * TwoFactorCard — the enrollment flow in Settings → Security.
 *
 * The behaviour worth protecting is the password step-up. Better Auth's
 * `/two-factor/enable` demands a password only for accounts that HAVE one, and
 * this product's primary operator path is magic-link-only, where there is no
 * password to ask for. So the card starts without one and surfaces the field
 * only when the server answers INVALID_PASSWORD. A regression that hardcodes
 * the password prompt locks magic-link operators out of their own second
 * factor; one that never prompts silently waits for an error the operator
 * cannot act on.
 *
 * `fetch` is stubbed rather than the auth client: every call here is a plain
 * route call the component makes itself, and the stub lets the specs decide
 * which error the server answers with.
 */

const mockSession = {
  current: null as null | { user: Record<string, unknown> },
};

jest.mock("../src/lib/auth-client", () => ({
  useSession: () => ({ data: mockSession.current, isPending: false }),
  authClient: {
    getSession: jest.fn(() => Promise.resolve({ data: mockSession.current })),
  },
}));

/** Stubbed Better Auth calls, recorded so the specs can assert the shape. */
let calls: { url: string; body: Record<string, unknown> }[] = [];
let respond: (url: string) => { ok: boolean; payload: Record<string, unknown> } = () => ({
  ok: true,
  payload: {
    totpURI: "otpauth://totp/SecureVoice AI:a@bank.ae?secret=JBSWY3DPEHPK3PXP",
    backupCodes: ["AAAA-1111", "BBBB-2222"],
  },
});

function signIn(twoFactorEnabled: boolean) {
  mockSession.current = { user: { id: "u_1", email: "a@bank.ae", twoFactorEnabled } };
}

beforeEach(() => {
  calls = [];
  // Reset the responder too: several specs reassign it, and without this the
  // reassignment leaks into the next spec as a phantom server error.
  respond = () => ({
    ok: true,
    payload: {
      totpURI: "otpauth://totp/SecureVoice AI:a@bank.ae?secret=JBSWY3DPEHPK3PXP",
      backupCodes: ["AAAA-1111", "BBBB-2222"],
    },
  });
  global.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    const i = (init ?? {}) as { body?: string };
    calls.push({ url, body: i.body ? JSON.parse(i.body) : {} });
    const { ok, payload } = respond(url);
    return { ok, status: ok ? 200 : 400, json: async () => payload };
  }) as unknown as typeof fetch;
});

describe("TwoFactorCard", () => {
  it("reports 'Off' and invites enrollment when the account has no second factor", () => {
    signIn(false);
    render(<TwoFactorCard />);
    expect(screen.getByText("Off")).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn on two-factor authentication/i })).toBeTruthy();
  });

  it("reports 'On' and offers maintenance, not enrollment, when it is already on", () => {
    signIn(true);
    render(<TwoFactorCard />);
    expect(screen.getByText("On")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn on two-factor authentication/i })).toBeNull();
    expect(screen.getByRole("button", { name: /replace recovery codes/i })).toBeTruthy();
  });

  it("hands over the TOTP secret and the recovery codes, shown once", async () => {
    const user = userEvent.setup();
    signIn(false);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));

    // The secret is presented as a link plus its literal URI, never as a QR
    // fetched from a third party.
    expect(await screen.findByText(/otpauth:\/\/totp\//)).toBeTruthy();
    expect(screen.getByRole("link", { name: /open in authenticator app/i })).toBeTruthy();
    // Both backup codes the server returned are on screen, with the warning.
    expect(screen.getByText("AAAA-1111")).toBeTruthy();
    expect(screen.getByText("BBBB-2222")).toBeTruthy();
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    expect(calls[0].body).toEqual({ method: "totp", issuer: "SecureVoice AI" });
  });

  it("asks for the password only after the server says one is required", async () => {
    const user = userEvent.setup();
    respond = () => ({
      ok: false,
      payload: { code: "INVALID_PASSWORD", message: "Invalid password" },
    });
    signIn(false);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));

    // The first attempt went out WITHOUT a password: a password-less operator
    // must not be asked for a credential they do not have.
    expect(await screen.findByLabelText(/confirm your password/i)).toBeTruthy();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).not.toHaveProperty("password");
  });

  it("surfaces the password field when this deployment's schema requires one", async () => {
    const user = userEvent.setup();
    // The shape production ACTUALLY returns: the two-factor plugin runs without
    // `allowPasswordless`, so `password` is a required field and the first
    // attempt is rejected by validation before any of it runs.
    respond = () => ({
      ok: false,
      payload: {
        code: "VALIDATION_ERROR",
        message: "[body.password] Invalid input: expected string, received undefined",
      },
    });
    signIn(false);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));

    // Recognised as "a password is needed", NOT as a mysterious failure —
    // otherwise every operator on this deployment is stuck at an error.
    expect(await screen.findByLabelText(/confirm your password/i)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();

    // Typing it and continuing retries WITH the credential.
    await user.type(screen.getByLabelText(/confirm your password/i), "hunter2hunter2");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toMatchObject({ password: "hunter2hunter2" });
  });

  it("does not claim success until the server accepts the six-digit code", async () => {
    const user = userEvent.setup();
    signIn(false);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));
    await user.type(await screen.findByLabelText(/six-digit code/i), "123456");
    await user.click(screen.getByRole("button", { name: /verify and turn on/i }));

    await waitFor(() => expect(screen.getByText(/is on\./i)).toBeTruthy());
    expect(calls[1].url).toBe("/api/auth/two-factor/verify-totp");
    expect(calls[1].body).toEqual({ code: "123456" });
  });

  it("keeps the form open and explains the retry when the code is rejected", async () => {
    const user = userEvent.setup();
    respond = (url) =>
      url.endsWith("verify-totp")
        ? { ok: false, payload: { message: "Invalid code" } }
        : {
            ok: true,
            payload: { totpURI: "otpauth://totp/x?secret=S", backupCodes: ["AAAA-1111"] },
          };
    signIn(false);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));
    await user.type(await screen.findByLabelText(/six-digit code/i), "999999");
    await user.click(screen.getByRole("button", { name: /verify and turn on/i }));

    // Still on the setup step — a rejected code is not a silent success.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/codes change every 30 seconds/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /verify and turn on/i })).toBeTruthy();
    expect(screen.queryByText(/is on\./i)).toBeNull();
  });

  it("sends the password when turning two-factor off", async () => {
    const user = userEvent.setup();
    signIn(true);
    render(<TwoFactorCard />);

    await user.click(screen.getByRole("button", { name: /turn off two-factor/i }));
    await user.type(screen.getByLabelText(/^password$/i), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: /^turn off$/i }));

    await waitFor(() => expect(screen.getByText(/is off\./i)).toBeTruthy());
    expect(calls[0].url).toBe("/api/auth/two-factor/disable");
    expect(calls[0].body).toEqual({ password: "correct-horse-battery" });
  });

  it("refuses to let a non-numeric keystroke into the code field", async () => {
    const user = userEvent.setup();
    signIn(false);
    render(<TwoFactorCard />);
    await user.click(screen.getByRole("button", { name: /turn on two-factor authentication/i }));

    const field = (await screen.findByLabelText(/six-digit code/i)) as HTMLInputElement;
    await user.type(field, "12ab34");
    expect(field.value).toBe("1234");
  });
});
