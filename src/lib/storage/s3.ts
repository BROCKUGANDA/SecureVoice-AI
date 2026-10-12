import "server-only";

/**
 * A minimal SigV4 client for S3-compatible object storage — Cloudflare R2 today,
 * any S3-compatible gateway tomorrow.
 *
 * ── Why this file exists at all ───────────────────────────────────────────────
 *
 * Recordings and uploaded knowledge-base PDFs are multi-megabyte blobs of bank
 * customer PII. They are not rows: putting an MP3 in a Postgres `Bytes` column
 * (which is what `src/lib/knowledge/documents.ts` does today) means every byte of
 * a customer recording rides through the app process's heap, the app's egress
 * bandwidth, and the database's buffer cache — for a file whose only readers are
 * a handful of fraud investigators. Worse, the DB is the one dependency in this
 * system that must never go down. An object store is allowed to be down; a
 * Postgres holding the audit chain is not.
 *
 * So the shape is: the app SIGNS, the browser and the server MOVE the bytes.
 * `presignGet` / `presignPut` hand out a capability URL and the transfer runs
 * bank-browser → R2 directly. That is the whole reason presigning is the core
 * primitive here rather than a convenience: proxying audio through Next.js
 * would keep the app in the data path and re-create the problem.
 *
 * ── Why there is no `@aws-sdk/client-s3` ──────────────────────────────────────
 *
 * Checked: the package is NOT in `node_modules` and NOT in `package.json`. We
 * chose not to add it anyway. The full surface we need is PUT, GET, HEAD,
 * DELETE, and a query-string presign — five requests whose signing is ~90 lines
 * of `node:crypto`. The SDK would add roughly 30 MB of transitive dependencies
 * (Smithy, retry, endpoint resolution, credential providers) to a repo that
 * pins a deliberately small set, and it would bring its own retry/timeout
 * opinions that would have to be configured back off. For signing four headers
 * and making four calls, that is disproportionate. This client is honest about
 * being small: it does not do multipart, does not do range GETs, does not do
 * conditional requests, and does not do credential rotation.
 *
 * ── The failure this file is written to prevent ───────────────────────────────
 *
 * Two, and both are severe:
 *
 *  1. **A signed URL that carries the secret.** SigV4 is easy to get subtly
 *     wrong, and the classic wrong answer is to sign with the secret itself or
 *     to put credentials in the query string. Either turns a short-lived,
 *     bearer-token download link into a permanent credential leak. So the
 *     secret is only ever an input to HMAC, never a substring of anything we
 *     return, and `scrub()` is a backstop applied to every error message.
 *  2. **A key that addresses another tenant's object.** There is no per-object
 *     ACL in front of this client. The ONLY thing that makes a key tenant-safe
 *     is that its first path segment is the tenant, so `assertObjectKey()`
 *     refuses `..`, a leading `/`, backslashes, empty segments and control
 *     characters outright rather than normalising them away. Normalising is the
 *     trap: `<orgA>/../<orgB>/x` normalises to `<orgB>/x` at the server, which is
 *     exactly the escape we are refusing to make reachable.
 *
 * ── Degradation is a hard rule, not a nicety ─────────────────────────────────
 *
 * `resolveStorageConfig()` returns `null` when storage is unconfigured. It does
 * NOT throw. A misconfigured environment must not turn into a crashed fraud
 * intervention: the caller falls back to Postgres bytes or reports "no
 * recording", which is a degraded product; a thrown import-time error is a dead
 * product. Every caller of this module must branch on `null`.
 */

import { createHash, createHmac } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { logError } from "@/lib/validation/safe-log";

// ── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
/**
 * What a presigned URL signs as its payload.
 *
 * A presigned URL has to work for a browser sending bytes we have never seen
 * (a 6 MB MP3 the operator is about to upload), so there is no payload to hash.
 * `UNSIGNED-PAYLOAD` is the only correct value here, and signing the real hash
 * instead produces a URL that fails verification at the far end.
 */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** AWS caps `X-Amz-Expires` at 7 days; beyond that the signature is rejected. */
export const MAX_EXPIRY_SECONDS = 604_800;

/**
 * Default presign lifetime. Long enough that an investigator can open a case,
 * click play and have the audio load; short enough that a URL pasted into a chat
 * window is dead before it becomes a breach. Callers with a stricter duty
 * (recordings) pass their own — see `src/lib/storage/recordings.ts`.
 */
export const DEFAULT_EXPIRY_SECONDS = 900;

/**
 * Bound on every outbound request.
 *
 * Without it a hung R2 connection holds the Next.js request open indefinitely,
 * and an operator waiting on a "sealed / no recording" answer is worse than one
 * waiting on an error they can retry.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Longest error body we read back before truncating. An S3 error is XML, not a novel. */
const MAX_ERROR_BODY_CHARS = 512;

// ── Types ────────────────────────────────────────────────────────────────────

export type StorageConfig = {
  /** Absolute http(s) origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  /** Credential-scope region. R2 uses `auto`; real S3 uses `ap-south-1` and friends. */
  region: string;
  accessKeyId: string;
  /** Never logged, never returned, never embedded in a URL. */
  secretAccessKey: string;
  bucket: string;
  /**
   * Path style (`https://host/bucket/key`) rather than virtual-host style
   * (`https://bucket.host/key`). Defaults to TRUE and should stay there: R2 only
   * resolves path-style URLs, and `*.r2.cloudflarestorage.com` does not exist as
   * a wildcard TLS certificate the way `*.s3.amazonaws.com` does.
   */
  forcePathStyle?: boolean;
};

export type PresignOptions = {
  /** Lifetime in seconds. Clamped to [1, MAX_EXPIRY_SECONDS]. */
  expiresInSeconds?: number;
  /**
   * Becomes `response-content-disposition`, i.e. how the browser names the file.
   * Set to `inline` for `<audio>` playback and `attachment` for an export.
   */
  contentDisposition?: string;
  /** Becomes `response-content-type`, so R2 labels the bytes without us re-uploading. */
  responseContentType?: string;
  /** PUT only: signed as a request header, so R2 rejects a wrong content type. */
  contentType?: string;
};

export type PutOptions = {
  contentType?: string;
  /**
   * Passed through to S3's `Cache-Control`. Recordings pass `no-store`; see the
   * retention notes in `src/lib/storage/recordings.ts` for why that is not
   * optional for personal data.
   */
  cacheControl?: string;
};

export type PutResult = { etag?: string };

export type StorageClientOptions = {
  /**
   * Omit to resolve from the environment. Pass `null` explicitly to represent
   * "known unconfigured" without a second env read.
   */
  config?: StorageConfig | null;
  /** Injectable so every function is testable with zero network. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Injectable clock, so expiry assertions are exact rather than approximate. */
  now?: () => Date;
};

export type StorageClient = {
  readonly config: StorageConfig | null;
  presignGet(key: string, opts?: PresignOptions): Promise<string>;
  presignPut(key: string, opts?: PresignOptions): Promise<string>;
  putObject(key: string, body: Buffer, opts?: PutOptions): Promise<PutResult>;
  getObject(key: string): Promise<Buffer>;
  headObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
};

// ── Errors ───────────────────────────────────────────────────────────────────

export type StorageErrorCode =
  | "not_configured"
  | "invalid_key"
  | "invalid_options"
  | "request_failed"
  | "timeout"
  | "unexpected_status";

/**
 * Every failure this module raises. A distinct class (not a bare `Error`) so a
 * caller can tell "storage is not turned on" from "storage is on and refused",
 * and therefore knows whether to degrade or to surface.
 *
 * The message is scrubbed by `storageError()` before it is ever stored, so a
 * secret that leaks into a downstream error string cannot reach a log sink or an
 * API response through here.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly status?: number;
  readonly key?: string;

  constructor(
    code: StorageErrorCode,
    message: string,
    opts: { status?: number; key?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = "StorageError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.key !== undefined) this.key = opts.key;
  }
}

/**
 * Remove any known secret from a string before it becomes an error message.
 *
 * This is a BACKSTOP, not the control. The control is that the secret never
 * enters a message in the first place — it is only ever an HMAC key. But error
 * text can come from a `fetch` rejection, an underlying URL, or a future edit,
 * and a leak into a log line is exactly the incident this whole module is
 * written to avoid. Anything shorter than 8 characters is not treated as a
 * secret, because scrubbing short strings would mangle unrelated text.
 */
function scrub(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

function storageError(
  code: StorageErrorCode,
  message: string,
  opts: {
    config?: StorageConfig | null;
    status?: number;
    key?: string;
    cause?: unknown;
  } = {},
): StorageError {
  const causeText =
    opts.cause instanceof Error ? opts.cause.message : opts.cause ? String(opts.cause) : "";
  const full = causeText ? `${message}: ${causeText}` : message;
  const secrets = [opts.config?.secretAccessKey, opts.config?.accessKeyId];
  return new StorageError(code, scrub(full, ...secrets), {
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    // The cause is scrubbed too, not just the message. A `fetch` rejection
    // carries the request URL, and a caller that logs `err.cause` — which is
    // the first thing anyone does when a storage call fails from a route — would
    // otherwise put the credential in the log line the scrub exists to prevent.
    // The cause's own non-secret fields (name, stack) are preserved so the
    // failure is still diagnosable.
    ...(opts.cause !== undefined ? { cause: sanitiseCause(opts.cause, secrets) } : {}),
  });
}

/**
 * Replace a cause's message with a scrubbed one, keeping the error identity.
 *
 * The original `cause` object is not mutated: it may be a shared or frozen error
 * from the fetch implementation, and mutating it would rewrite a message another
 * layer is still holding. A shallow clone is enough because only `message` and
 * `stack` carry the secret.
 */
function sanitiseCause(cause: unknown, secrets: Array<string | undefined>): unknown {
  if (!(cause instanceof Error)) return cause;
  const clone = new Error(scrub(cause.message, ...secrets), { cause: undefined });
  clone.name = cause.name;
  if (cause.stack) clone.stack = scrub(cause.stack, ...secrets);
  return clone;
}

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * The env var names, both spellings.
 *
 * `S3_*` is the generic S3-compatible name; `R2_*` is what a Cloudflare operator
 * actually reaches for. Both are read, `S3_*` first, so a deployment can be
 * migrated between an on-prem MinIO and R2 by changing values rather than code,
 * and so a paste of an R2 tutorial works without a translation step.
 *
 * Exported so `docs` and the settings UI can name the variables without this
 * file being the only place they are written down.
 */
export const STORAGE_ENV_VARS = {
  endpoint: ["S3_ENDPOINT", "R2_ENDPOINT"],
  region: ["S3_REGION", "R2_REGION"],
  accessKeyId: ["S3_ACCESS_KEY_ID", "R2_ACCESS_KEY_ID"],
  secretAccessKey: ["S3_SECRET_ACCESS_KEY", "R2_SECRET_ACCESS_KEY"],
  bucket: ["S3_BUCKET", "R2_BUCKET"],
} as const satisfies Record<string, readonly string[]>;

function readEnvValue(names: readonly string[]): string | null {
  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return null;
}

/**
 * Read the storage configuration, or `null` if storage is not configured.
 *
 * Returns `null` rather than throwing, by design (see the module header): an
 * environment missing five variables must degrade to "no object store", not take
 * the fraud console down with it. `null` is also returned for a PARTIAL config —
 * an endpoint without a bucket is not a usable store, and treating it as
 * configured would produce a signing failure at request time instead of a
 * clean, early "storage is off".
 *
 * Read at CALL time, not import time, so a test (and a settings route that
 * writes env before first use) sees the current environment.
 *
 * `region` is required rather than defaulted to `auto`. `auto` is correct for R2
 * and wrong for every other S3, and a silent wrong region is a signature that
 * fails at the far end with a `SignatureDoesNotMatch` nobody can read.
 */
export function resolveStorageConfig(): StorageConfig | null {
  const endpoint = readEnvValue(STORAGE_ENV_VARS.endpoint);
  const region = readEnvValue(STORAGE_ENV_VARS.region);
  const accessKeyId = readEnvValue(STORAGE_ENV_VARS.accessKeyId);
  const secretAccessKey = readEnvValue(STORAGE_ENV_VARS.secretAccessKey);
  const bucket = readEnvValue(STORAGE_ENV_VARS.bucket);
  if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) return null;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    // A typo'd endpoint that is not a URL must read as "unconfigured", not as a
    // TypeError thrown from inside signing.
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.search || url.hash) return null;

  // Normalise the trailing slash away so path-style joining never produces `//`,
  // which S3 reads as an empty path segment rather than as a separator.
  const base = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;

  return {
    endpoint: base,
    region,
    accessKeyId,
    secretAccessKey,
    bucket,
    // Path style by default: see `forcePathStyle` on StorageConfig.
    //
    // `R2_FORCE_PATH_STYLE=false` opts into virtual-host style, which is what a
    // proxy or a non-R2 S3 (MinIO behind a vhost) needs. R2 itself accepts both,
    // so the default is the safer shape and the override is a real knob rather
    // than decoration — it is read here, at the one place the config is built.
    forcePathStyle: (process.env.R2_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false",
  };
}

/** True when an object store is configured. The cheap question every caller asks first. */
export function storageConfigured(): boolean {
  return resolveStorageConfig() !== null;
}

// ── Key validation ───────────────────────────────────────────────────────────

/**
 * Object key shape.
 *
 * Every rule here exists because there is NO per-object ACL in front of this
 * client. The bucket is one flat namespace; the only thing standing between a
 * bug and a cross-tenant disclosure is that a key cannot be crafted to leave
 * its own prefix.
 *
 *  - `..` is refused as a SUBSTRING, not as a path segment. `a..b.mp3` is a
 *    legitimate filename and is rejected anyway: the cost of a false positive is
 *    an object key an integrator has to rename, and the cost of a false negative
 *    is another bank's recording. `recordingKey()` generates keys, so no
 *    legitimate key ever contains two consecutive dots.
 *  - A leading `/` is refused because path-style signing would then produce a
 *    canonical URI the server reads differently from the one we hashed.
 *  - `//` and a trailing `/` are refused for the same reason: an empty segment
 *    is not a separator.
 *  - Backslash and control characters are refused because they are how a
 *    Windows-normalising proxy turns a key into a different one.
 */
const objectKeySchema = z
  .string()
  .min(1, "object key is empty")
  .max(1024, "object key exceeds the 1024-character S3 limit")
  .refine((k) => !k.startsWith("/"), "object key must not start with '/'")
  .refine((k) => !k.endsWith("/"), "object key must not end with '/'")
  .refine((k) => !k.includes("//"), "object key must not contain an empty path segment")
  .refine((k) => !k.includes(".."), "object key must not contain '..'")
  .refine((k) => !k.includes("\\"), "object key must not contain a backslash")
  .refine(
    (k) => !/[\u0000-\u001f\u007f]/.test(k),
    "object key must not contain control characters",
  );

/**
 * Validate an object key, or throw.
 *
 * The thrown message describes the RULE that failed and never the key itself:
 * an object key can carry a customer identifier, and an error message is a
 * thing that ends up in logs and in an HTTP response.
 */
export function assertObjectKey(key: string): string {
  const parsed = objectKeySchema.safeParse(key);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StorageError("invalid_key", `refusing object key: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** Non-throwing form, for the `has`-style probes that must not blow up a list. */
export function isValidObjectKey(key: string): boolean {
  return objectKeySchema.safeParse(key).success;
}

// ── SigV4 primitives ─────────────────────────────────────────────────────────

/** RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone; SigV4 does not. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a key for a URL path: every segment encoded, the `/` separators kept. */
function encodeKeyPath(key: string): string {
  return key.split("/").map(rfc3986).join("/");
}

/**
 * The canonical query string: parameters sorted by encoded name, then encoded
 * value, each `name=value`, joined with `&`.
 *
 * SigV4 hashes this exact byte sequence, so the ordering is not cosmetic — a
 * stable total order over (name, value) is what makes a signature reproducible
 * and testable. `Object.entries` order would work today and break the first time
 * a caller builds the map in a different order; sorting does not. Values are
 * dropped when `undefined` or empty so an unset optional never becomes `k=`,
 * which the server would treat as an empty value.
 */
export function canonicalQueryString(params: Record<string, string | number | undefined>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => [rfc3986(name), rfc3986(String(value))] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/**
 * Canonical headers plus the semicolon-joined `SignedHeaders` list.
 *
 * Lowercased and whitespace-collapsed per the spec: S3 rejects a signature whose
 * header casing or internal spacing differs from what it reconstructs, and the
 * caller never gets to know which version of the rule the store is enforcing.
 */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(
      ([name, value]) =>
        [
          name.toLowerCase().trim().replace(/\s+/g, " "),
          value.trim().replace(/\s+/g, " "),
        ] as const,
    )
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(""),
    signed: entries.map(([name]) => name).join(";"),
  };
}

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * The SigV4 signing key: four chained HMACs, `AWS4`-prefixed secret → date →
 * region → service → terminator.
 *
 * The date and region are part of the derivation precisely so a signature made
 * yesterday for Frankfurt cannot be replayed today against Singapore.
 */
function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, "aws4_request");
}

/** `2026-10-11T12:00:00.000Z` → `20261011T120000Z`. */
function amzDate(when: Date): string {
  return when
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/g, "");
}

/**
 * The string that is actually signed:
 *
 *     AWS4-HMAC-SHA256 \n
 *     <amz date>     \n
 *     <date>/<region>/s3/aws4_request \n
 *     <sha256 of the canonical request>
 */
function stringToSign(amz: string, region: string, canonicalRequest: string): string {
  return [
    ALGORITHM,
    amz,
    `${amz.slice(0, 8)}/${region}/${SERVICE}/aws4_request`,
    sha256Hex(canonicalRequest),
  ].join("\n");
}

function sign(secret: string, region: string, amz: string, canonicalRequest: string): string {
  const key = signingKey(secret, amz.slice(0, 8), region);
  return hmac(key, stringToSign(amz, region, canonicalRequest)).toString("hex");
}

/**
 * The canonical request: method, canonical URI, canonical query, canonical
 * headers, signed headers, payload hash — each on its own line, with the trailing
 * newline after the headers block.
 *
 * The payload hash is a parameter rather than a constant because the two modes
 * are different: a body-bearing PUT signs the real SHA-256 of the bytes (we
 * already hold them in memory, so it costs one pass and proves the object was
 * not altered in transit), while every other request — and every presigned URL —
 * signs `UNSIGNED-PAYLOAD`.
 */
function canonicalRequest(args: {
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  headers: Record<string, string>;
  payloadHash: string;
}): { text: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(args.headers);
  return {
    text: [
      args.method,
      args.canonicalUri,
      args.canonicalQuery,
      canonical,
      signed,
      args.payloadHash,
    ].join("\n"),
    signedHeaders: signed,
  };
}

/** Build the absolute URL for a key, honouring path vs virtual-host style. */
function requestUrl(config: StorageConfig, key: string): URL {
  const url = new URL(config.endpoint);
  const prefix = url.pathname.replace(/\/+$/, "");
  if (config.forcePathStyle === false) {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = `${prefix}/${encodeKeyPath(key)}`;
  } else {
    url.pathname = `${prefix}/${rfc3986(config.bucket)}/${encodeKeyPath(key)}`;
  }
  url.search = "";
  url.hash = "";
  return url;
}

// ── Option validation ────────────────────────────────────────────────────────

const presignOptionsSchema = z.object({
  expiresInSeconds: z.number().int().min(1).max(MAX_EXPIRY_SECONDS).optional(),
  contentDisposition: z.string().min(1).max(512).optional(),
  responseContentType: z.string().min(1).max(255).optional(),
  contentType: z.string().min(1).max(255).optional(),
});

const putOptionsSchema = z.object({
  contentType: z.string().min(1).max(255).optional(),
  cacheControl: z.string().min(1).max(255).optional(),
});

function parseOptions<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StorageError(
      "invalid_options",
      `invalid storage options: ${issue?.path.join(".") || "options"} ${issue?.message ?? "rejected"}`,
    );
  }
  return parsed.data;
}

// ── Presigning ───────────────────────────────────────────────────────────────

/**
 * Query-string presigning — the core primitive.
 *
 * The signature goes in the query string instead of a header because a browser
 * `<audio src>` and an `<input type="file">` XHR cannot add headers to a GET.
 * The URL is therefore a bearer capability: whoever holds it can use it until it
 * expires. Everything about its design follows from that.
 *
 * Returned as an already-encoded string rather than a `URL` object on purpose:
 * `URLSearchParams` re-encodes and re-orders, and the exact byte sequence the
 * signature covers must survive to the wire.
 */
function presignUrl(
  method: "GET" | "PUT" | "HEAD",
  config: StorageConfig,
  key: string,
  opts: PresignOptions,
  now: () => Date,
): string {
  const safeKey = assertObjectKey(key);
  const options = parseOptions(presignOptionsSchema, opts);
  const expires = options.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;

  const url = requestUrl(config, safeKey);
  const amz = amzDate(now());

  // `host` is always signed — it is what binds the URL to one endpoint, so a
  // signature harvested from one store cannot be replayed against another.
  const headers: Record<string, string> = { host: url.host };
  if (method === "PUT" && options.contentType) headers["content-type"] = options.contentType;
  const signedHeaderNames = canonicalHeaders(headers).signed;

  const query = canonicalQueryString({
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${config.accessKeyId}/${amz.slice(0, 8)}/${config.region}/${SERVICE}/aws4_request`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": expires,
    "X-Amz-SignedHeaders": signedHeaderNames,
    // Response overrides. These are part of the canonical query, so they are
    // covered by the signature: an attacker cannot strip `attachment` off a
    // download link and have the remaining URL still verify.
    "response-content-disposition": options.contentDisposition,
    "response-content-type": options.responseContentType,
  });

  const canonical = canonicalRequest({
    method,
    canonicalUri: url.pathname,
    canonicalQuery: query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const signature = sign(config.secretAccessKey, config.region, amz, canonical.text);
  return `${url.origin}${url.pathname}?${query}&X-Amz-Signature=${signature}`;
}

// ── Signed requests ──────────────────────────────────────────────────────────

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, MAX_ERROR_BODY_CHARS);
  } catch {
    return "";
  }
}

/**
 * One signed PUT/GET/HEAD/DELETE.
 *
 * `host` is in the signature but NOT in the headers we hand to `fetch`: the
 * runtime derives it from the URL, and setting it explicitly is at best a
 * forbidden header. That is the right trade — the signature pins the host, so a
 * proxy that rewrites it produces a `SignatureDoesNotMatch` instead of quietly
 * serving the request somewhere else.
 */
async function signedRequest(
  config: StorageConfig,
  method: "GET" | "PUT" | "HEAD" | "DELETE",
  key: string,
  body: Buffer | undefined,
  headersToSign: Record<string, string>,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  now: () => Date,
): Promise<Response> {
  const url = requestUrl(config, key);
  const amz = amzDate(now());

  const headers: Record<string, string> = {
    ...headersToSign,
    host: url.host,
    "x-amz-content-sha256": body ? sha256Hex(body) : UNSIGNED_PAYLOAD,
    "x-amz-date": amz,
  };

  const canonical = canonicalRequest({
    method,
    canonicalUri: url.pathname,
    canonicalQuery: url.search.slice(1),
    headers,
    payloadHash: String(headers["x-amz-content-sha256"]),
  });

  const authorization =
    `${ALGORITHM} Credential=${config.accessKeyId}/${amz.slice(0, 8)}/${config.region}/${SERVICE}/aws4_request, ` +
    `SignedHeaders=${canonical.signedHeaders}, Signature=${sign(
      config.secretAccessKey,
      config.region,
      amz,
      canonical.text,
    )}`;

  // `host` is dropped: the transport sets it from the URL we just signed.
  const { host: _host, ...transported } = headers;

  try {
    return await fetchImpl(url, {
      method,
      headers: { ...transported, authorization },
      ...(body ? { body: new Uint8Array(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw storageError(timedOut ? "timeout" : "request_failed", `storage ${method} failed`, {
      config,
      key,
      cause: err,
    });
  }
}

// ── Client ───────────────────────────────────────────────────────────────────

/**
 * Build a client. Cheap by construction — no network, no cached state — so the
 * module-level wrappers can build one per call and still always see the current
 * environment.
 */
export function createStorageClient(options: StorageClientOptions = {}): StorageClient {
  const config = options.config === undefined ? resolveStorageConfig() : options.config;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  /** Storage being off is a programming error for PRESIGN (the caller should have
   * degraded first) — unlike read/write, there is nothing to degrade TO, so this
   * throws rather than returning a URL that cannot work. */
  function requireConfig(): StorageConfig {
    if (!config) {
      throw new StorageError(
        "not_configured",
        "object storage is not configured (set S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_BUCKET)",
      );
    }
    return config;
  }

  return {
    config,

    presignGet(key, opts) {
      // Synchronous throw on a bad config or key, deliberately.
      //
      // Presigning is synchronous work over synchronous inputs — there is no
      // network, no clock await, nothing asynchronous about it. `presignGet`
      // returns `Promise.resolve(value)` so it composes with the async methods,
      // but a configuration error surfaces as a THROW at call time. A caller
      // that wants to treat misconfiguration as a value must check
      // `client.config` first, which is the documented precondition (see
      // `requireConfig`).
      //
      // Making this reject instead would be defensible on its own, but it would
      // disagree with `assertObjectKey`, which throws for the same class of
      // input error — and a validation API that rejects on one path and throws
      // on another is the inconsistency that gets a caller wrong at 3am.
      return Promise.resolve(presignUrl("GET", requireConfig(), key, opts ?? {}, now));
    },

    presignPut(key, opts) {
      return Promise.resolve(presignUrl("PUT", requireConfig(), key, opts ?? {}, now));
    },

    async putObject(key, body, opts) {
      const cfg = requireConfig();
      const safeKey = assertObjectKey(key);
      const options = parseOptions(putOptionsSchema, opts);
      const res = await signedRequest(
        cfg,
        "PUT",
        safeKey,
        body,
        {
          ...(options.contentType ? { "content-type": options.contentType } : {}),
          ...(options.cacheControl ? { "cache-control": options.cacheControl } : {}),
        },
        fetchImpl,
        timeoutMs,
        now,
      );
      if (!res.ok) {
        const detail = await readErrorBody(res);
        logError("object storage put failed", {
          method: "PUT",
          key: safeKey,
          status: res.status,
          detail: detail.slice(0, 200),
        });
        throw storageError("unexpected_status", `storage PUT failed with ${res.status}`, {
          config: cfg,
          status: res.status,
          key: safeKey,
        });
      }
      const etag = res.headers.get("etag");
      return etag ? { etag } : {};
    },

    async getObject(key) {
      const cfg = requireConfig();
      const safeKey = assertObjectKey(key);
      const res = await signedRequest(
        cfg,
        "GET",
        safeKey,
        undefined,
        {},
        fetchImpl,
        timeoutMs,
        now,
      );
      if (!res.ok) {
        const detail = await readErrorBody(res);
        logError("object storage get failed", {
          method: "GET",
          key: safeKey,
          status: res.status,
          detail: detail.slice(0, 200),
        });
        throw storageError("unexpected_status", `storage GET failed with ${res.status}`, {
          config: cfg,
          status: res.status,
          key: safeKey,
        });
      }
      return Buffer.from(await res.arrayBuffer());
    },

    /**
     * Existence probe, used by `hasRecording`.
     *
     * HEAD rather than a ranged GET so the check costs one header round trip and
     * moves zero audio bytes. Returns a boolean and never throws: the caller is
     * asking "is there a recording to show?", and an unreachable store means the
     * honest answer is `false` — the console already renders that as "no
     * recording retained", which is a far better screen than an error.
     */
    async headObject(key) {
      if (!config || !isValidObjectKey(key)) return false;
      try {
        const res = await signedRequest(
          config,
          "HEAD",
          key,
          undefined,
          {},
          fetchImpl,
          timeoutMs,
          now,
        );
        return res.ok;
      } catch {
        return false;
      }
    },

    async deleteObject(key) {
      const cfg = requireConfig();
      const safeKey = assertObjectKey(key);
      const res = await signedRequest(
        cfg,
        "DELETE",
        safeKey,
        undefined,
        {},
        fetchImpl,
        timeoutMs,
        now,
      );
      // S3 DELETE is idempotent by contract: deleting a key that is already gone
      // is the state the caller asked for. Treat 404 as success so a retention
      // sweep over a partially-deleted prefix does not fail on the second run.
      if (!res.ok && res.status !== 404) {
        const detail = await readErrorBody(res);
        logError("object storage delete failed", {
          method: "DELETE",
          key: safeKey,
          status: res.status,
          detail: detail.slice(0, 200),
        });
        throw storageError("unexpected_status", `storage DELETE failed with ${res.status}`, {
          config: cfg,
          status: res.status,
          key: safeKey,
        });
      }
    },
  };
}

/**
 * The module-level wrappers, for the common case of "one object store, resolved
 * from the environment, right now".
 *
 * They exist so a call site reads `presignGet(key)` rather than threading a
 * client through every function signature. Each builds a client per call, which
 * is object construction only — no network — and is what keeps environment
 * changes visible to the very next call.
 */
export function presignGet(key: string, opts?: PresignOptions): Promise<string> {
  return createStorageClient().presignGet(key, opts);
}

export function presignPut(key: string, opts?: PresignOptions): Promise<string> {
  return createStorageClient().presignPut(key, opts);
}

export function putObject(key: string, body: Buffer, opts?: PutOptions): Promise<PutResult> {
  return createStorageClient().putObject(key, body, opts);
}

export function getObject(key: string): Promise<Buffer> {
  return createStorageClient().getObject(key);
}

export function headObject(key: string): Promise<boolean> {
  return createStorageClient().headObject(key);
}

export function deleteObject(key: string): Promise<void> {
  return createStorageClient().deleteObject(key);
}
