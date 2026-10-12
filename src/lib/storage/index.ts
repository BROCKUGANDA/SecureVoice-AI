import "server-only";

/**
 * Object storage — one import for the platform.
 *
 * ── Storage is OPTIONAL, and every caller must be written that way ───────────
 *
 * `resolveStorageConfig()` returns `null` when the five environment variables
 * are not set, and that is a supported deployment, not a misconfiguration.
 * Records live in Postgres bytes, the console says "no recording retained", and
 * the fraud intervention proceeds.
 *
 * The reason this rule is stated at the FACADE rather than buried in the client
 * is that the failure mode it prevents is a production outage with a misleading
 * cause. A storage call that throws on an unconfigured environment surfaces as a
 * 500 on the page an investigator is looking at while a customer is calling
 * about a fraudulent transfer. A storage call that degrades surfaces as one
 * absent audio player in one row. The first breaks the product; the second is
 * the product working.
 *
 * So the shape of every degrading helper here is a RESULT OBJECT, never a
 * throw:
 *
 *   const res = await storeRecording({ orgId, conversationId, audio });
 *   if (!res.ok) {
 *     // res.error is "storage_not_configured", "org_id_required_or_invalid", …
 *     auditAppend({ intent: "recording_store_skipped", meta: { reason: res.error } });
 *     return;                       // ← the case transition continues regardless
 *   }
 *
 * Two functions DO throw on purpose, and the distinction matters:
 *
 *  - `recordingKey` throws on an unusable tenant, because a caller that cannot
 *    name a tenant has nothing to degrade to and would otherwise be about to
 *    address an arbitrary key. `tryRecordingKey` is the non-throwing form.
 *  - The raw `presignGet` / `putObject` / `getObject` wrappers throw when
 *    storage is off, because there is no honest URL or byte stream to return.
 *    Prefer `recordingDownloadUrl`, which refuses cleanly.
 *
 * ── Tenant scoping is a parameter, not an option ─────────────────────────────
 *
 * Every recording helper takes `orgId` as a REQUIRED argument and validates it
 * to a single path segment. This mirrors `indexTranscript` in
 * `src/lib/pinecone/transcript-index.ts`, and for the same reason: there is no
 * per-object ACL in the bucket, so the tenant prefix on the key is the entire
 * isolation mechanism, and making the tenant unrepresentable-as-absent is the
 * cheapest way to keep it that way.
 *
 * ── What callers must never do ───────────────────────────────────────────────
 *
 *  - Log a presigned URL. It is a bearer credential for a customer's voice.
 *  - Serve recording audio without `Cache-Control: no-store`
 *    (`RECORDING_CACHE_CONTROL`).
 *  - Take `orgId` from request input. It must be server-derived — see
 *    `src/lib/storage/recordings.ts`.
 */

export {
  // Configuration
  DEFAULT_EXPIRY_SECONDS,
  DEFAULT_TIMEOUT_MS,
  MAX_EXPIRY_SECONDS,
  STORAGE_ENV_VARS,
  createStorageClient,
  resolveStorageConfig,
  storageConfigured,
  // Key safety
  assertObjectKey,
  isValidObjectKey,
  // Errors
  StorageError,
  type StorageErrorCode,
  // Client surface
  canonicalQueryString,
  deleteObject,
  getObject,
  headObject,
  presignGet,
  presignPut,
  putObject,
  type PresignOptions,
  type PutOptions,
  type PutResult,
  type StorageClient,
  type StorageClientOptions,
  type StorageConfig,
} from "./s3";

export {
  DEFAULT_DOWNLOAD_TTL_SECONDS,
  MAX_DOWNLOAD_TTL_SECONDS,
  RECORDING_CACHE_CONTROL,
  RECORDING_CONTENT_TYPE,
  RECORDING_EXTENSION,
  hasRecording,
  recordRecording,
  recordingDownloadUrl,
  recordingKey,
  recordingPrefix,
  storeRecording,
  tryRecordingKey,
  type RecordingDownloadArgs,
  type RecordingDownloadResult,
  type RecordingStoreResult,
  type StoreRecordingArgs,
} from "./recordings";
