/**
 * Console error copy — what a person reads when a panel fails.
 *
 * The server speaks in stable codes (`storage_not_configured`, `401`,
 * `ORGANIZATION_NOT_FOUND`) because a code is what a machine branches on and what
 * an incident search filters by. A console panel is not a machine: showing
 * `Failed to fetch` or `recording_not_found` to a fraud analyst replaces one
 * mystery with another.
 *
 * So each function here takes the code, and returns a sentence in the operator's
 * language that says what happened and what to do. Two rules, both tested in
 * `tests/unit/console-error-copy.test.ts`:
 *
 *   · NEVER return the caller's raw string. A transport error's `message` is
 *     "Load failed"; a vendor's is "Invalid origin". Both belong in
 *     `reportClientError`, not on screen.
 *   · NEVER return an unmapped code as if it were prose. An unknown code gets the
 *     generic sentence — the code still reaches the console, so a developer can
 *     add the mapping without a user ever reading a snake_case token.
 *
 * Arabic is not a translation appended to an English design: each string states
 * the same action, because the console is bilingual by requirement and an
 * untranslated fallback is how a bank's Arabic-speaking operator ends up reading
 * an English stack fragment.
 */
import type { Lang } from "@/lib/languages";

type Copy = { en: string; ar: string };

const pick = (c: Copy, lang: Lang): string => (lang === "ar" ? c.ar : c.en);

/** The sentence shown when nothing about the failure is actionable. */
const GENERIC: Copy = {
  en: "This did not load. Try again — if it keeps happening, the platform's status page may explain why.",
  ar: "لم يُحمَّل هذا المحتوى. حاول مرة أخرى — وإن تكرر الأمر فقد توضح صفحة الحالة السبب.",
};

const ANALYTICS: Record<string, Copy> = {
  authentication_required: {
    en: "Your session ended. Sign in again to see this workspace's numbers.",
    ar: "انتهت جلستك. سجّل الدخول مرة أخرى لعرض أرقام مساحة العمل.",
  },
  no_active_organization: {
    en: "Pick a workspace first — these numbers belong to an organisation, and none is selected.",
    ar: "اختر مساحة عمل أولاً — هذه الأرقام تخص مؤسسة ولم يتم اختيار أي منها.",
  },
  analytics_unavailable: {
    en: "Usage numbers are unavailable right now. Live calls are unaffected — this is the report, not the platform.",
    ar: "أرقام الاستخدام غير متاحة الآن. المكالمات المباشرة غير متأثرة — هذا التقرير وليس المنصة.",
  },
};

const RECORDING: Record<string, Copy> = {
  authentication_required: {
    en: "Your session ended. Sign in again to play this recording.",
    ar: "انتهت جلستك. سجّل الدخول مرة أخرى لتشغيل هذا التسجيل.",
  },
  no_active_organization: {
    en: "Pick a workspace first — recordings are scoped to one organisation.",
    ar: "اختر مساحة عمل أولاً — التسجيلات مرتبطة بمؤسسة واحدة.",
  },
  recording_not_found: {
    en: "This recording is no longer stored. Audio is kept for 30 days, then deleted.",
    ar: "لم يعد هذا التسجيل محفوظاً. يُحفظ الصوت لمدة ٣٠ يوماً ثم يُحذف.",
  },
  no_recording_for_case: {
    en: "This case has no recording — the call was never answered, or recording is off for this workspace.",
    ar: "لا يوجد تسجيل لهذه الحالة — لم يُجب على المكالمة، أو أن التسجيل معطّل في مساحة العمل هذه.",
  },
  storage_not_configured: {
    en: "Recording storage is not configured on this deployment, so no audio can be served.",
    ar: "لم يتم تكوين تخزين التسجيلات على هذا النشر، لذلك لا يمكن تقديم أي صوت.",
  },
};

const WORKSPACE: Record<string, Copy> = {
  ORGANIZATION_NOT_FOUND: {
    en: "That workspace no longer exists, or you are no longer a member of it.",
    ar: "لم تعد مساحة العمل هذه موجودة، أو لم تعد عضواً فيها.",
  },
  MEMBERSHIP_NOT_FOUND: {
    en: "You are no longer a member of that workspace. Ask its administrator to re-invite you.",
    ar: "لم تعد عضواً في مساحة العمل تلك. اطلب من مديرها إعادة دعوتك.",
  },
  USER_NOT_FOUND: {
    en: "Your account could not be matched to that workspace. Sign in again and try once more.",
    ar: "تعذّر ربط حسابك بمساحة العمل تلك. سجّل الدخول مرة أخرى وحاول مجدداً.",
  },
  authentication_required: {
    en: "Your session ended. Sign in again to switch workspace.",
    ar: "انتهت جلستك. سجّل الدخول مرة أخرى لتبديل مساحة العمل.",
  },
};

/**
 * Normalise whatever the server or vendor gave us into a lookup key.
 *
 * HTTP statuses arrive as `download_refused_401` from the fetch layer, codes as
 * `storage_not_configured`, and Better Auth's as `ORGANIZATION_NOT_FOUND`. The
 * status form is folded onto the same keys, because 401 on a recording endpoint
 * means the same thing to the operator as `authentication_required` does.
 */
function keyFor(code: string | undefined | null): string | null {
  if (!code) return null;
  const c = code.trim();
  if (c === "") return null;
  const status = /(?:^|_)(401|403|404|409|500|503)$/.exec(c);
  if (status) {
    const s = status[1];
    if (s === "401") return "authentication_required";
    if (s === "403") return "no_active_organization";
    if (s === "404") return "not_found";
    return "unavailable";
  }
  return c;
}

/** Analytics panel copy for a failed `/api/console/analytics` read. */
export function describeAnalyticsError(code: string | null | undefined, lang: Lang): string {
  const k = keyFor(code);
  if (k && ANALYTICS[k]) return pick(ANALYTICS[k], lang);
  return pick(GENERIC, lang);
}

/** Recording-player copy for a failed `/api/recordings/[id]` download. */
export function describeRecordingError(code: string | null | undefined, lang: Lang): string {
  const k = keyFor(code);
  if (k && RECORDING[k]) return pick(RECORDING[k], lang);
  if (k === "not_found") return pick(RECORDING.recording_not_found, lang);
  if (k === "forbidden") return pick(RECORDING.no_active_organization, lang);
  return pick(GENERIC, lang);
}

/** Workspace-switcher copy for a rejected `setActive`. */
export function describeWorkspaceSwitchError(code: string | null | undefined, lang: Lang): string {
  const k = keyFor(code);
  if (k && WORKSPACE[k]) return pick(WORKSPACE[k], lang);
  return pick(GENERIC, lang);
}
