import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AcceptInvite,
  MagicLinkRequest,
  MagicLinkVerify,
  ResetConfirm,
  ResetRequest,
} from "@/app/auth/auth-forms";

const mockRouter = { replace: jest.fn() };
let mockParams = new URLSearchParams();
jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockParams,
}));

const originalFetch = global.fetch;
const request = jest.fn();
const token = "synthetic+token/with&reserved";
const password = "Long synthetic password 42!";

function response(status: number, data: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockParams = new URLSearchParams();
  mockRouter.replace.mockReset();
  request.mockReset();
  request.mockRejectedValue(new Error("Unexpected request"));
  global.fetch = request;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  global.fetch = originalFetch;
});

const requestForms = [
  {
    name: "magic link",
    element: <MagicLinkRequest origin="https://staging.example.test" />,
    button: "Email me a sign-in link",
    endpoint: "/api/auth/magic-link",
    acknowledgement: "If that address belongs to an account, a sign-in link is on its way.",
  },
  {
    name: "password reset",
    element: <ResetRequest />,
    button: "Email me a reset link",
    endpoint: "/api/auth/reset",
    acknowledgement: "If that address belongs to an account, a password reset link is on its way.",
  },
];

for (const form of requestForms) {
  describe(`${form.name} request`, () => {
    test("validates locally, submits a trimmed address, and acknowledges neutrally", async () => {
      request.mockResolvedValue(response(202));
      render(form.element);
      fireEvent.click(screen.getByRole("button", { name: form.button }));
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(document.activeElement).toBe(screen.getByLabelText("Work email"));
      expect(request).not.toHaveBeenCalled();
      fill("Work email", "  operator@example.test  ");
      fireEvent.click(screen.getByRole("button", { name: form.button }));
      expect(await screen.findByText(form.acknowledgement)).toBeTruthy();
      expect(request).toHaveBeenCalledWith(form.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.test" }),
      });
      fireEvent.click(screen.getByRole("button", { name: "Use a different address" }));
      expect((screen.getByLabelText("Work email") as HTMLInputElement).value).toBe("");
    });

    test.each([
      [422, { error: "Check the address" }, "Check the address"],
      [500, { error: "Try later" }, "Try later"],
      [500, null, "Something went wrong. Please try again."],
      [500, { error: "  " }, "Something went wrong. Please try again."],
    ])("handles HTTP %s without claiming delivery", async (status, data, message) => {
      request.mockResolvedValue(response(status as number, data));
      render(form.element);
      fill("Work email", "operator@example.test");
      fireEvent.click(screen.getByRole("button", { name: form.button }));
      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(screen.queryByText(form.acknowledgement)).toBeNull();
      expect(
        (screen.getByRole("button", { name: form.button }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });

    test("allows retry after a network failure", async () => {
      render(form.element);
      fill("Work email", "operator@example.test");
      fireEvent.click(screen.getByRole("button", { name: form.button }));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Could not reach the server",
      );
      request.mockResolvedValue(response(202));
      fireEvent.click(screen.getByRole("button", { name: form.button }));
      expect(await screen.findByText(form.acknowledgement)).toBeTruthy();
    });
  });
}

test("magic-link provider outage with an unreadable body gets an honest fallback", async () => {
  request.mockResolvedValue({
    ...response(503),
    json: async () => {
      throw new Error("not JSON");
    },
  });
  render(<MagicLinkRequest origin="https://staging.example.test" />);
  fill("Work email", "operator@example.test");
  fireEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Sign-in email could not be sent",
  );
});

test("legacy magic-link URL forwards the encoded token without submitting an address", () => {
  mockParams.set("token", token);
  render(<MagicLinkRequest origin="https://staging.example.test" />);
  expect(mockRouter.replace).toHaveBeenCalledWith(
    `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  );
  expect(request).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain(token);
});

describe("magic-link redemption", () => {
  test("missing token offers a fresh link without making a request", () => {
    render(<MagicLinkVerify />);
    expect(
      screen.getByRole("link", { name: "Request a new sign-in link" }).getAttribute("href"),
    ).toBe("/auth/magic-link");
    expect(request).not.toHaveBeenCalled();
  });

  test("redeems once, hides the token, then redirects", async () => {
    mockParams.set("token", token);
    request.mockResolvedValue(response(200));
    const view = render(<MagicLinkVerify />);
    expect(await screen.findByRole("heading", { name: "You are signed in" })).toBeTruthy();
    view.rerender(<MagicLinkVerify />);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "/api/auth/magic-link/verify",
      expect.objectContaining({ body: JSON.stringify({ token }), method: "POST" }),
    );
    expect(document.body.textContent).not.toContain(token);
    act(() => jest.advanceTimersByTime(1200));
    expect(mockRouter.replace).toHaveBeenCalledWith("/");
  });

  test.each([401, 500])(
    "HTTP %s offers recovery without echoing the server body",
    async (status) => {
      mockParams.set("token", token);
      request.mockResolvedValue(response(status, { error: token }));
      render(<MagicLinkVerify />);
      expect(await screen.findByRole("link", { name: "Request a new sign-in link" })).toBeTruthy();
      expect(document.body.textContent).not.toContain(token);
      expect(mockRouter.replace).not.toHaveBeenCalled();
    },
  );
});

describe("invitation acceptance", () => {
  test("missing or unusable tokens never expose the account form", async () => {
    const view = render(<AcceptInvite />);
    expect(
      screen.getByRole("heading", { name: "This invitation link is incomplete" }),
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
    view.unmount();
    mockParams.set("token", token);
    request.mockResolvedValue(response(410));
    render(<AcceptInvite />);
    expect(
      await screen.findByRole("heading", { name: "This invitation is not valid" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  test("checks the invitation, validates fields, and submits credentials before redirecting", async () => {
    mockParams.set("token", token);
    request.mockResolvedValueOnce(response(204)).mockResolvedValueOnce(response(201));
    render(<AcceptInvite />);
    await screen.findByLabelText("Full name");
    expect(request).toHaveBeenCalledWith(`/api/auth/invites?token=${encodeURIComponent(token)}`, {
      method: "HEAD",
      cache: "no-store",
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Full name"));
    fill("Full name", "  Aisha  ");
    fill("Password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
    expect(request).toHaveBeenCalledTimes(1);
    fill("Password", password);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Welcome aboard" })).toBeTruthy();
    expect(request).toHaveBeenLastCalledWith(
      "/api/auth/invites/accept",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token, name: "Aisha", password }),
      }),
    );
    act(() => jest.advanceTimersByTime(1400));
    expect(mockRouter.replace).toHaveBeenCalledWith("/#auth");
  });

  test("an invitation consumed after preflight shows the rejection and permits retry", async () => {
    mockParams.set("token", token);
    request.mockResolvedValueOnce(response(204)).mockResolvedValueOnce(response(410));
    render(<AcceptInvite />);
    await screen.findByLabelText("Full name");
    fill("Full name", "Aisha");
    fill("Password", password);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "This invitation is no longer valid",
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe("password reset confirmation", () => {
  test("missing token offers a reset request without exposing a password form", () => {
    render(<ResetConfirm />);
    expect(screen.getByRole("link", { name: "Request a new link" }).getAttribute("href")).toBe(
      "/auth/reset-password",
    );
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test("validates locally, keeps the token out of the DOM, and redirects on success", async () => {
    mockParams.set("token", token);
    request.mockResolvedValue(response(200));
    render(<ResetConfirm />);
    fill("New password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(screen.getByRole("alert").textContent).toContain("at least 12");
    expect(request).not.toHaveBeenCalled();
    fill("New password", password);
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeTruthy();
    expect(request).toHaveBeenCalledWith(
      "/api/auth/reset/confirm",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ token, password }) }),
    );
    expect(document.body.textContent).not.toContain(token);
    act(() => jest.advanceTimersByTime(1400));
    expect(mockRouter.replace).toHaveBeenCalledWith("/");
  });

  test.each([
    [422, { error: "Choose a stronger password." }, "Choose a stronger password."],
    [401, { error: token }, "That reset link is no longer valid. Request a new one."],
    [500, "invalid response", "Something went wrong. Please try again."],
  ])("HTTP %s never reports success", async (status, data, message) => {
    mockParams.set("token", token);
    request.mockResolvedValue(response(status as number, data));
    render(<ResetConfirm />);
    fill("New password", password);
    fireEvent.click(screen.getByRole("button", { name: "Set new password" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(token);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Set new password" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
