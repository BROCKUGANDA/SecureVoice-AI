import "server-only";

/**
 * Call recordings: the tenant-scoped key, the store, and the signed download.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 *
 * A fraud intervention produces a recording of a call between the bank's fraud
 * team and a customer who is, by definition, the victim of an attempted fraud.
 * That audio is the most sensitive artifact the platform holds — a bank customer
 * discussing their credentials, their balance and their fear, on a call the bank
 * placed. Under UAE PDPL it is personal data with a purpose limitation and a
 * retention deadline, and it is exactly the kind of thing that must never leak
 * sideways into another bank's tenant.
 *
 * ── The privilege model, stated plainly ──────────────────────────────────────
 *
 * **Possession of a presigned URL IS the authorization.** There is no session
 * check, no entitlement check and no token exchange between the browser and the
 * object store: the browser is handed a signed URL and `<audio src>` fetches it
 * directly. That is deliberate — it is what keeps multi-megabyte audio out of
 * the application process — but it means the URL is a bearer capability and
 * therefore:
 *
 *  - It is SHORT-LIVED. `DEFAULT_DOWNLOAD_TTL_SECONDS` is 300, and
 *    `MAX_DOWNLOAD_TTL_SECONDS` is 900. Five minutes is enough for an
 *    investigator to open a case and press play; it is not enough for a link
 *    pasted into a chat window to still work tomorrow. There is no "permanent
 *    download" option, because a permanent link to a customer's voice is the
 *    incident this module exists to prevent.
 *  - It must NEVER be logged. A signed URL in an access log, a Sentry breadcrumb
 *    or an analytics payload is a live recording credential. The console builds
 *    it on the server and hands it straight to the client; it does not round-trip
 *    through anywhere that logs.
 *  - It must NEVER be cached. See `RECORDING_CACHE_CONTROL` below.
 *
 * ── Tenant isolation: the tenant prefix is the WHOLE mechanism ──────────────
 *
 * `recordingKey()` produces `{orgId}/recordings/{conversationId}.mp3`. That
 * leading segment is the ONLY thing that makes the key tenant-safe. There is no
 * per-object ACL, no per-tenant bucket, and no server-side check that runs on
 * every read — R2 sees one flat namespace and a bearer URL.
 *
 * So the guarantee is made structural rather than checked, which is stronger:
 * `recordingKey` refuses any `orgId` that is not exactly one safe path segment.
 * An `orgId` of `"../org-b"`, `"/org-b"` or `"org-a/org-b"` is rejected before a
 * key exists, so it is not possible to construct a key that names another
 * tenant's prefix. The second guarantee is that callers must pass a SERVER-DERIVED
 * tenant: an `orgId` read from a query parameter, a form field or a webhook body
 * is attacker-controlled, and passing one here would move the authorization
 * decision from the session to the caller.
 *
 * Two orgs, one conversation id, produce two different keys — that is asserted
 * in `tests/unit/recording-download.test.ts` and it is the property everything
 * else rests on.
 *
 * ── Retention and caching ────────────────────────────────────────────────────
 *
 * Audio retention is 30 days by default, and 0 days for an org under a
 * no-recording agreement (`src/lib/privacy/retention.ts`, `DEFAULT_RETENTION_DAYS`
 * and `PILOT_AUDIO_DAYS`). This module does not enforce that clock — it is the
 * retention sweep's job, which reaches object storage through the `AudioStore`
 * seam registered there. What this module owns is making sure a recording that
 * HAS been stored is never quietly kept longer by something outside the sweep.
 * Hence:
 *
 *  - `RECORDING_CACHE_CONTROL` is `no-store`. It belongs on every response that
 *    touches audio: the presigned GET, any proxy in front of R2, and any route
 *    that proxies bytes. A recording left in a shared CDN cache outlives the
 *    URL's expiry and its retention window, and a browser disk cache is not
 *    something a deletion request can reach.
 *  - Presigned downloads are issued `inline` with `audio/mpeg` so the console
 *    player streams them, and the `response-content-disposition` /
 *    `response-content-type` overrides are inside the signed query string — an
 *    attacker cannot strip them and still have the URL verify.
 *
 * ── Degradation ──────────────────────────────────────────────────────────────
 *
 * With no object store configured, `storeRecording` returns
 * `{ ok: false, error: "storage_not_configured" }`, `hasRecording` returns
 * `false`, and `recordingDownloadUrl` returns an error result. None of them
 * throw. A fraud intervention must not fail because an object store is
 * unreachable or absent; the console already renders "no recording retained" as a
 * normal state (`RecordingPlayer` shows a `sealed` chip for `src === null`), so
 * degrading into it is a designed screen rather than an error page.
 */

import { z } from "zod";
import {
  assertObjectKey,
  createStorageClient,
  isValidObjectKey,
  MAX_EXPIRY_SECONDS,
  StorageError,
  type StorageClientOptions,
} from "./s3";

/** Extension every stored recording carries. ElevenLabs delivers MP3. */
export const RECORDING_EXTENSION = "mp3";

/** MIME type every stored recording is written and served as. */
export const RECORDING_CONTENT_TYPE = "audio/mpeg";

/**
 * Default presigned-download lifetime, in seconds.
 *
 * Short on purpose. See the privilege model in the module header: the URL is the
 * authorization, so its lifetime IS the window during which a leak is
 * exploitable. Five minutes covers open-case → press-play; nothing about a
 * recorded fraud call requires a link that survives a coffee break.
 */
export const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;

/**
 * Ceiling on a download link.
 *
 * Deliberately far below SigV4's own 7-day maximum. Anything longer than a
 * quarter of an hour turns a capability URL into a durable credential, and no
 * investigation workflow needs one. Callers asking for more get clamped, not
 * refused — a link that is slightly too short is a nuisance, a crash while
 * building a page is an outage.
 */
export const MAX_DOWNLOAD_TTL_SECONDS = 900;

/**
 * `Cache-Control` for anything touching recording audio. `no-store` covers both
 * the HTTP cache and the browser disk cache, which is the part a PDPL erasure
 * request cannot reach. See the module header.
 */
export const RECORDING_CACHE_CONTROL = "no-store";

// ── Results ──────────────────────────────────────────────────────────────────

export type RecordingStoreResult =
  { ok: true; key: string; etag?: string } | { ok: false; error: string };

export type RecordingDownloadResult =
  | { ok: true; url: string; key: string; expiresAt: Date; expiresInSeconds: number }
  | { ok: false; error: string };

// ── The key ──────────────────────────────────────────────────────────────────

/**
 * The tenant id, constrained to exactly one safe path segment.
 *
 * zod rather than a hand-rolled regex because the rule is a security rule, and a
 * security rule that is stated once in a schema is a rule a reviewer can see.
 * The `^...$` anchors matter: without them `"org-a/../org-b"` would be accepted
 * by a `includes`-style check somewhere else and this would not be the choke
 * point it is meant to be.
 *
 * Callers pass a SERVER-DERIVED org id (from the session / the case row), never
 * one read from request input. See the module header.
 */
const orgIdSchema = z
  .string()
  .trim()
  .min(1, "org id is required")
  .max(64, "org id exceeds 64 characters")
  .refine((v) => !v.includes("/"), "org id must be a single path segment")
  .refine((v) => !v.includes("\\"), "org id must not contain a backslash")
  .refine((v) => !v.includes(".."), "org id must not contain '..'")
  .refine((v) => !/^[/.]/.test(v), "org id must not start with '.' or '/'")
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "org id must not contain control characters");

/** The conversation id. Narrower than a general key because it becomes a filename. */
const conversationIdSchema = z
  .string()
  .trim()
  .min(1, "conversation id is required")
  .max(128, "conversation id exceeds 128 characters")
  .refine((v) => !v.includes("/"), "conversation id must be a single path segment")
  .refine((v) => !v.includes("\\"), "conversation id must not contain a backslash")
  .refine((v) => !v.includes(".."), "conversation id must not contain '..'")
  .refine((v) => !/^[/.]/.test(v), "conversation id must not start with '.' or '/'")
  .refine(
    (v) => !/[\u0000-\u001f\u007f]/.test(v),
    "conversation id must not contain control characters",
  );

function invalid(field: "org" | "conversation"): string {
  return field === "org" ? "org_id_required_or_invalid" : "conversation_id_required_or_invalid";
}

function requireSegment(schema: typeof orgIdSchema, raw: string): string {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new StorageError(
      "invalid_key",
      `refusing to build a recording key: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/**
 * The object key for one recording: `{orgId}/recordings/{conversationId}.mp3`.
 *
 * Deterministic — the same org and conversation always produce the same key — so
 * a re-delivered webhook overwrites rather than duplicating, and so a retention
 * sweep can find the object from the conversation alone without a database row.
 *
 * The `{orgId}` prefix is what makes the key tenant-safe; there is no per-object
 * ACL behind it. `orgId` must therefore be a server-derived tenant id, and it is
 * validated to be a single safe path segment so it cannot be crafted to reach
 * another tenant's prefix. See the module header.
 *
 * Throws `StorageError("invalid_key")` on a bad segment rather than returning a
 * null: this is the strict primitive every other helper in this file builds on,
 * and a caller that cannot name a tenant has nothing to degrade to.
 */
export function recordingKey(orgId: string, conversationId: string): string {
  const org = requireSegment(orgIdSchema, orgId);
  const conversation = requireSegment(conversationIdSchema, conversationId);
  // assertObjectKey re-runs the storage-layer key rules (empty segments, length,
  // control characters). Redundant for well-formed input and the point: a key
  // that leaves here is one the storage layer will also accept.
  return assertObjectKey(`${org}/recordings/${conversation}.${RECORDING_EXTENSION}`);
}

/** The recording prefix for one tenant, for a lifecycle sweep over a whole org. */
export function recordingPrefix(orgId: string): string {
  const org = requireSegment(orgIdSchema, orgId);
  return assertObjectKey(`${org}/recordings`);
}

/**
 * Which half of the pair is unusable, or `null` if both are fine.
 *
 * Split out so the degrading helpers can say `org_id_required_or_invalid` rather
 * than a generic failure: "the case row had no orgId" and "the conversation id
 * was a traversal attempt" are different bugs in different places, and collapsing
 * them into one string is how the second one hides behind the first.
 */
function recordingKeyError(orgId: string, conversationId: string): string | null {
  if (!orgIdSchema.safeParse(orgId).success) return invalid("org");
  if (!conversationIdSchema.safeParse(conversationId).success) return invalid("conversation");
  return null;
}

/** Non-throwing form of `recordingKey`, for call sites that must degrade. */
export function tryRecordingKey(orgId: string, conversationId: string): string | null {
  try {
    return recordingKey(orgId, conversationId);
  } catch {
    return null;
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

export type StoreRecordingArgs = {
  /**
   * SERVER-DERIVED tenant id. Never a query parameter, a form field, or a value
   * read out of a webhook body — see the module header.
   */
  orgId: string;
  conversationId: string;
  audio: Buffer;
  /** Defaults to `audio/mpeg`. */
  contentType?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * Write a recording.
 *
 * Returns a result object and never throws: a failed upload must not become a
 * failed case transition. The caller records the outcome in the audit chain
 * either way — the current `post_call_audio` handler
 * (`src/lib/elevenlabs/inbound.ts`) deliberately does NOT persist the base64 MP3
 * at all (I-10: the provider is the system of record), so this is the seam where
 * a deployment that opts into local retention stores the bytes instead.
 *
 * `cache-control: no-store` is set on the object itself. R2 stores it with the
 * object and serves it back on a direct GET, which is a path that never passes
 * through our code and would otherwise serve a cached-by-default recording.
 */
export async function storeRecording(args: StoreRecordingArgs): Promise<RecordingStoreResult> {
  const key = tryRecordingKey(args.orgId, args.conversationId);
  const keyError = recordingKeyError(args.orgId, args.conversationId);
  if (!key || keyError) return { ok: false, error: keyError ?? "invalid_key" };

  const client = createStorageClient({
    ...clientOverrides(args),
  });
  if (!client.config) return { ok: false, error: "storage_not_configured" };

  try {
    const { etag } = await client.putObject(key, args.audio, {
      contentType: args.contentType ?? RECORDING_CONTENT_TYPE,
      cacheControl: RECORDING_CACHE_CONTROL,
    });
    return { ok: true, key, ...(etag ? { etag } : {}) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof StorageError ? err.message : "recording_store_failed",
    };
  }
}

/**
 * Alias of `storeRecording`.
 *
 * Two names because two things are true at once and neither is wrong: the
 * function STORES bytes, and the product-level effect is that a recording now
 * EXISTS for this conversation. Code that reads about cases wants `record`;
 * code that reads about blobs wants `store`. Both point at one implementation so
 * the two vocabularies cannot drift into two behaviours.
 */
export const recordRecording = storeRecording;

/**
 * Does a recording exist for this key?
 *
 * Takes a KEY, not an org + conversation, because the retention and case-load
 * paths already hold one. The key must still come from `recordingKey()`; passing
 * an arbitrary string here is the one way to ask about another tenant's object,
 * which is why the module header says it out loud.
 *
 * Never throws. `false` covers all three honest answers: no recording, no
 * object store configured, and the store being unreachable. The console renders
 * all three identically (`src === null` → a `sealed` chip), so collapsing them
 * here is exactly what the UI already assumes.
 */
export async function hasRecording(key: string): Promise<boolean> {
  if (!isValidObjectKey(key)) return false;
  return createStorageClient().headObject(key);
}

export type RecordingDeleteResult =
  { ok: true; key: string } | { ok: false; error: string; key?: string };

/**
 * Delete one conversation's recording. The counterpart of `storeRecording`, and
 * the reason it exists: the moment we archive a customer's voice we own its
 * deletion, and an erasure request that shreds the database row while leaving the
 * object in a bucket has not erased anything.
 *
 * Never throws, returns a typed refusal — an erasure sweep must be able to keep
 * going over a prefix and report which objects it could not reach, rather than
 * dying on the first one.
 *
 * The store's DELETE is idempotent: a key that is already gone is the state the
 * caller asked for, so success here means "there is now no object under this key"
 * and NOT "an object was removed". For a retention or erasure report that is the
 * only distinction that matters, and `hasRecording()` is the way to ask the other
 * question.
 *
 * With storage unconfigured it reports `storage_not_configured` rather than ok —
 * an erasure that quietly "succeeded" because the deployment never stores
 * recordings should say so, not pretend it deleted something.
 */
export async function deleteRecording(args: {
  orgId: string;
  conversationId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<RecordingDeleteResult> {
  const key = tryRecordingKey(args.orgId, args.conversationId);
  const keyError = recordingKeyError(args.orgId, args.conversationId);
  if (!key || keyError) return { ok: false, error: keyError ?? "invalid_key" };

  const client = createStorageClient(clientOverrides(args));
  if (!client.config) return { ok: false, error: "storage_not_configured", key };

  try {
    await client.deleteObject(key);
    return { ok: true, key };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof StorageError ? err.message : "recording_delete_failed",
      key,
    };
  }
}

// ── Download ─────────────────────────────────────────────────────────────────

export type RecordingDownloadArgs = {
  /** SERVER-DERIVED tenant id. See the module header. */
  orgId: string;
  conversationId: string;
  /** Clamped to [1, MAX_DOWNLOAD_TTL_SECONDS]. Defaults to 300. */
  expiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * A signed download URL for one recording.
 *
 * This is the function the console calls when an operator presses play. It
 * derives the key from the tenant and the conversation — never from a
 * client-supplied path — and returns a URL whose lifetime is clamped to
 * `MAX_DOWNLOAD_TTL_SECONDS`.
 *
 * `inline` + `audio/mpeg` because the consumer is `<audio>` in
 * `RecordingPlayer`; `attachment` would download instead of play. Both overrides
 * ride inside the signed query string, so they cannot be edited by whoever ends
 * up holding the URL.
 *
 * The returned URL is a bearer credential. Do not log it, do not put it in an
 * analytics event, and make sure the response that carries it sets
 * `Cache-Control: no-store` (the constant above exists for that).
 */
export async function recordingDownloadUrl(
  args: RecordingDownloadArgs,
): Promise<RecordingDownloadResult> {
  const key = tryRecordingKey(args.orgId, args.conversationId);
  const keyError = recordingKeyError(args.orgId, args.conversationId);
  if (!key || keyError) return { ok: false, error: keyError ?? "invalid_key" };

  const overrides = clientOverrides(args);
  const client = createStorageClient(overrides);
  if (!client.config) return { ok: false, error: "storage_not_configured" };

  const requested = args.expiresInSeconds ?? DEFAULT_DOWNLOAD_TTL_SECONDS;
  const expiresInSeconds = Math.min(
    Math.max(1, Math.trunc(requested)),
    MAX_DOWNLOAD_TTL_SECONDS,
    MAX_EXPIRY_SECONDS,
  );

  const now = overrides.now ?? (() => new Date());
  try {
    const url = await client.presignGet(key, {
      expiresInSeconds,
      contentDisposition: `inline; filename="${args.conversationId}.${RECORDING_EXTENSION}"`,
      responseContentType: RECORDING_CONTENT_TYPE,
    });
    return {
      ok: true,
      url,
      key,
      expiresInSeconds,
      expiresAt: new Date(now().getTime() + expiresInSeconds * 1000),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof StorageError ? err.message : "recording_download_failed",
    };
  }
}

/**
 * Drop the injected test seams down to what `createStorageClient` accepts.
 *
 * `config` is deliberately NOT threaded through here: a caller cannot hand this
 * module a config object, only a `fetchImpl` and a `now`. That is a small
 * constraint with a real purpose — the tenant and the endpoint both come from
 * outside the caller (session and environment), so a bug in a route cannot be
 * masked by pointing it at a test bucket.
 */
function clientOverrides(args: {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): StorageClientOptions {
  return {
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.now ? { now: args.now } : {}),
  };
}
