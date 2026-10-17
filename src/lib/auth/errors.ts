/**
 * Human-readable text for every error the sign-in surface can produce.
 *
 * The rule this module exists to enforce is the one `src/views/Auth.tsx` stated in
 * a comment and then broke in code: "we never render a raw vendor error". Its
 * fallback returned `message` verbatim whenever it was under 200 characters, which
 * is how a judge on the public demo was handed the two words `Invalid origin` —
 * Better Auth's internal config diagnosis, correct only from the server's point of
 * view, and useless to the person holding the phone.
 *
 * So the fallback is now a sentence a person can act on, and the raw vendor string
 * goes where diagnostics go: `console.warn`, and Sentry via the browser SDK.
 *
 * ## What the operator-facing copy deliberately does NOT contain
 *
 * Environment variable names. This panel is reachable without a session, and a
 * bank's public sign-in page should not be a tour of the deployment's config. The
 * server side carries the precise variable, the rejected origin, and the fix —
 * `src/app/api/auth/[...all]/route.ts` logs them — and the two halves meet at the
 * incident, not at the browser.
 */

import { reportClientError } from "@/lib/client-diagnostics";

export type AuthLang = "en" | "ar" | "hi" | "ur" | "fr" | "sw";

type Copy = { en: string; ar: string };

/** Friendly text per machine code, keyed on what Better Auth and our own guards emit. */
const BY_CODE: Record<string, Copy> = {
  // Deliberately identical text for both shapes: distinguishing "no such account"
  // from "wrong password" is an account-enumeration oracle, and the check costs a
  // credential-stuffing run nothing.
  INVALID_EMAIL_OR_PASSWORD: {
    en: "That email and password do not match an account.",
    ar: "لا يتطابق البريد الإلكتروني وكلمة المرور مع أي حساب.",
  },
  USER_NOT_FOUND: {
    en: "That email and password do not match an account.",
    ar: "لا يتطابق البريد الإلكتروني وكلمة المرور مع أي حساب.",
  },
  INVALID_PASSWORD: {
    en: "That email and password do not match an account.",
    ar: "لا يتطابق البريد الإلكتروني وكلمة المرور مع أي حساب.",
  },
  TOO_MANY_REQUESTS: {
    en: "Too many attempts from here. Wait a minute, then try again.",
    ar: "محاولات كثيرة من هنا. انتظر دقيقة ثم حاول مرة أخرى.",
  },
  // Our own bad-actor ladder (`src/lib/abuse/bad-actor.ts`), surfaced by
  // `src/app/api/auth/[...all]/route.ts`.
  too_many_failed_signins: {
    en: "This address has been paused after several failed sign-ins. Try again in a few minutes, or use a magic link.",
    ar: "تم إيقاف هذا العنوان بعد عدة محاولات فاشلة. حاول بعد دقائق، أو استخدم الرابط السري.",
  },
  // Turnstile refused the browser check. Coarse by design: the four sub-reasons are
  // server-side only, and naming them tells an attacker which check fired.
  bot_check_failed: {
    en: "The browser check did not complete. Solve the puzzle and try again — if it does not appear, disable any script blocker on this page.",
    ar: "لم يكتمل فحص المتصفح. حلّ اللغز ثم حاول مرة أخرى — إذا لم يظهر، عطّل مانع النصوص في هذه الصفحة.",
  },
  // Origin/CSRF refusals: the deployment is reachable at an address its auth
  // configuration does not include. The visitor cannot fix this, so say who can.
  INVALID_ORIGIN: {
    en: "This workspace is reachable at an address its sign-in service does not trust yet. Nothing is wrong with your credentials — an operator needs to add this address to the deployment's allowed origins.",
    ar: "يمكن الوصول إلى مساحة العمل هذه من عنوان لا يثق به خدمة تسجيل الدخول بعد. بيانات اعتمادك سليمة — يحتاج المشغّل إلى إضافة هذا العنوان إلى العناوين المسموحة.",
  },
  CSRF_ERROR: {
    en: "The sign-in request could not be verified as coming from this page. Reload the page and try again.",
    ar: "تعذّر التحقق من أن طلب تسجيل الدخول صادر عن هذه الصفحة. أعد تحميل الصفحة وحاول مرة أخرى.",
  },
  SESSION_EXPIRED: {
    en: "Your session has ended. Sign in again to continue.",
    ar: "انتهت جلستك. سجّل الدخول مرة أخرى للمتابعة.",
  },
  FAIL_TO_GET_SESSION: {
    en: "We could not read your session. Reload the page, and sign in again if it persists.",
    ar: "تعذّر قراءة جلستك. أعد تحميل الصفحة وسجّل الدخول مرة أخرى إذا استمرت المشكلة.",
  },
  EMAIL_NOT_VERIFIED: {
    en: "Confirm the email address first — the verification link was sent to your inbox.",
    ar: "يجب تأكيد البريد الإلكتروني أولاً — لقد أُرسل رابط التحقق إلى بريدك.",
  },
  WEAK_PASSWORD: {
    en: "That password is too short or too common for a banking workspace. Use at least 12 characters.",
    ar: "كلمة المرور قصيرة أو شائعة جداً لمساحة عمل مصرفية. استخدم ١٢ حرفاً على الأقل.",
  },
  BANNED: {
    en: "This account has been suspended. Ask your workspace administrator to restore it.",
    ar: "تم تعليق هذا الحساب. اطلب من مدير مساحة العمل إعادته.",
  },
  // Two-factor challenges are their own screens; this is the text for a refusal
  // that arrives on the sign-in panel.
  INVALID_TWO_FACTOR_CODE: {
    en: "That code is not valid for this device. Check your authenticator app and try again.",
    ar: "هذا الرمز غير صالح لهذا الجهاز. تحقق من تطبيق المصادقة وحاول مرة أخرى.",
  },
  TWO_FACTOR_PENDING: {
    en: "Finish the second-factor step to reach the console.",
    ar: "أكمل خطوة العامل الثاني للوصول إلى الوحدة.",
  },
};

/**
 * Vendor messages that arrive with no usable `code`.
 *
 * Better Auth's origin guard throws with a message and no stable code on every
 * path, so matching the text is the only way to recognise the one failure that is
 * a deployment misconfiguration rather than a user mistake. Lower-cased and
 * substring-matched, because the exact wording has already moved between versions.
 */
const BY_MESSAGE: { match: string; code: keyof typeof BY_CODE }[] = [
  { match: "invalid origin", code: "INVALID_ORIGIN" },
  { match: "mismatched origin", code: "INVALID_ORIGIN" },
  { match: "unauthorized origin", code: "INVALID_ORIGIN" },
  { match: "csrf", code: "CSRF_ERROR" },
];

const GENERIC: Copy = {
  en: "Sign-in did not complete. Check the details and try again — if it keeps happening, use a magic link or contact your workspace administrator.",
  ar: "لم يكتمل تسجيل الدخول. تحقق من البيانات وحاول مرة أخرى — إذا تكرر الأمر استخدم الرابط السري أو تواصل مع مدير مساحة العمل.",
};

/**
 * The text to show, given whatever the client was handed.
 *
 * Never returns the vendor string. The raw value is returned separately by
 * `authErrorDetail` for logging, so the developer path and the human path cannot
 * be confused for each other.
 */
export function describeAuthError(e: unknown, lang: AuthLang): string {
  const code = authErrorCode(e);
  if (code && BY_CODE[code]) return BY_CODE[code][lang];

  const message = authErrorDetail(e).toLowerCase();
  for (const entry of BY_MESSAGE) {
    // `entry.code` is a general `string` (the keyof of an index-signature
    // `Record`), and this read has no preceding truthiness check on the entry —
    // so under `noUncheckedIndexedAccess` it is `Copy | undefined`. Name the
    // fallback rather than indexing a possibly-missing table.
    // (The `if` above needs no such handling: TypeScript narrows the two
    // `BY_CODE[code]` reads as one expression, const index and all.)
    if (message.includes(entry.match)) return (BY_CODE[entry.code] ?? GENERIC)[lang];
  }
  return GENERIC[lang];
}

/** The machine code, when there is one — for `console.warn`, Sentry, and triage. */
export function authErrorCode(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const err = e as { code?: unknown; body?: { code?: unknown } };
  const direct = typeof err.code === "string" ? err.code : undefined;
  const fromBody =
    err.body && typeof err.body.code === "string" ? (err.body.code as string) : undefined;
  return direct ?? fromBody;
}

/** The vendor's own text — for logs ONLY. Never render this. */
export function authErrorDetail(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (typeof e !== "object") return String(e);
  const err = e as { message?: unknown; error?: { message?: unknown } };
  if (typeof err.message === "string") return err.message;
  const inner = err.error;
  if (inner && typeof inner.message === "string") return inner.message;
  return "";
}

/**
 * Send the raw error where raw errors belong: the console, and Sentry if this
 * deployment configured it. See `src/lib/client-diagnostics.ts` for why both sinks
 * are optional and neither may throw.
 *
 * Making the UI kind must not make the platform blind. Before this, a sign-in
 * refused for a deployment reason produced a polite sentence in the browser and
 * nothing anywhere else.
 */
export function reportAuthError(e: unknown): void {
  const code = authErrorCode(e);
  reportClientError("sign-in", e, {
    ...(code ? { auth_code: code } : {}),
    ...(authErrorDetail(e) ? { vendor_message: authErrorDetail(e) } : {}),
  });
}
