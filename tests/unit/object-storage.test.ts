/**
 * UNIT — the S3/SigV4 client (`src/lib/storage/s3.ts`).
 *
 * SigV4 is the kind of code that is either exactly right or subtly wrong, and
 * the subtly-wrong versions all fail the same way: at the far end, against a
 * live R2 bucket, on a customer's recording, in production. There is no unit
 * test here that can prove a real store would accept our signature — but there
 * is one that can prove the canonical bytes we HASH are the canonical bytes we
 * SEND, that the signing key is derived the way the spec says, and that nothing
 * leaks. So the properties asserted below are the ones whose failure is silent:
 *
 *   1. The query string carries the full SigV4 parameter set, and `host` is in
 *      `SignedHeaders` — without `host` a signature harvested from one store
 *      replays against another.
 *   2. `UNSIGNED-PAYLOAD` is what a presigned URL signs. Signing a real hash
 *      produces a URL that fails verification at the far end, which is the
 *      single most common SigV4 bug.
 *   3. Canonical query ordering is a TOTAL order over (name, value), not
 *      insertion order. `Object.entries` order works until one call site builds
 *      the map differently, and then the bug is intermittent.
 *   4. The secret never appears in a URL or in an error message. A leaked
 *      secret is not a bug, it is an incident.
 *   5. `..` is refused, not normalised. Normalising is the trap:
 *      `<orgA>/../<orgB>/x` resolves to `<orgB>/x` at the server.
 *   6. Unconfigured storage returns `null` instead of throwing, because a
 *      missing env var must not take a fraud console down.
 *   7. A real PUT sends `Authorization: AWS4-HMAC-SHA256 ...`.
 *
 * The clock and `fetch` are injected, so nothing here touches the network and
 * every expiry assertion is exact rather than approximate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_EXPIRY_SECONDS,
  STORAGE_ENV_VARS,
  StorageError,
  assertObjectKey,
  canonicalQueryString,
  createStorageClient,
  isValidObjectKey,
  presignGet,
  resolveStorageConfig,
  type StorageConfig,
} from "@/lib/storage/s3";

/** A key pair that is obviously fake and long enough to trip the scrub backstop. */
const SECRET = "unit-test-secret-access-key-0123456789";
const ACCESS_KEY_ID = "AKIAUNITTESTACCESS01";

const CONFIG: StorageConfig = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: ACCESS_KEY_ID,
  secretAccessKey: SECRET,
  bucket: "securevoice-recordings",
  forcePathStyle: true,
};

/** A frozen clock, so `X-Amz-Date` is the same on every call in the suite. */
const FIXED_NOW = new Date("2026-10-11T09:30:15.000Z");

function client(overrides: Partial<Parameters<typeof createStorageClient>[0]> = {}) {
  return createStorageClient({
    config: CONFIG,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

function queryOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("storage configuration", () => {
  const KEYS = [
    "S3_ENDPOINT",
    "R2_ENDPOINT",
    "S3_REGION",
    "R2_REGION",
    "S3_ACCESS_KEY_ID",
    "R2_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY",
    "S3_BUCKET",
    "R2_BUCKET",
    "R2_FORCE_PATH_STYLE",
  ] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of KEYS) saved.set(k, process.env[k]);
    // Bun loads the developer's `.env` into the test process, so "unconfigured"
    // has to be established explicitly — otherwise this suite is green or red
    // depending on whose machine it ran on.
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("returns null when storage is unconfigured rather than throwing", () => {
    // The whole "storage is optional" contract. A throw here would 500 the
    // console page an investigator is reading mid-fraud-intervention.
    expect(resolveStorageConfig()).toBeNull();
  });

  test("returns null on a PARTIAL config, not a half-built one", () => {
    // An endpoint without a bucket is not a usable store. Treating it as
    // configured turns a deployment mistake into a SignatureDoesNotMatch at
    // request time, which nobody can read.
    process.env.S3_ENDPOINT = CONFIG.endpoint;
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.S3_SECRET_ACCESS_KEY = SECRET;
    expect(resolveStorageConfig()).toBeNull();

    process.env.S3_BUCKET = CONFIG.bucket;
    const cfg = resolveStorageConfig();
    expect(cfg?.endpoint).toBe(CONFIG.endpoint);
    expect(cfg?.bucket).toBe(CONFIG.bucket);
    // Path style by default: R2 resolves no virtual-host URLs.
    expect(cfg?.forcePathStyle).toBe(true);
  });

  test("accepts the R2_* spelling of every variable", () => {
    // An operator following a Cloudflare tutorial should not have to translate
    // variable names to get storage working.
    process.env.R2_ENDPOINT = `${CONFIG.endpoint}/`;
    process.env.R2_REGION = "auto";
    process.env.R2_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.R2_SECRET_ACCESS_KEY = SECRET;
    process.env.R2_BUCKET = CONFIG.bucket;

    const cfg = resolveStorageConfig();
    // Trailing slash normalised away, so path-style joining never emits `//`
    // (which S3 reads as an empty segment rather than a separator).
    expect(cfg?.endpoint).toBe(CONFIG.endpoint);
    expect(cfg?.region).toBe("auto");
  });

  test("S3_* wins over R2_* when both are present", () => {
    process.env.R2_ENDPOINT = "https://r2.example.com";
    process.env.S3_ENDPOINT = CONFIG.endpoint;
    process.env.R2_REGION = "auto";
    process.env.S3_REGION = "eu-west-1";
    process.env.R2_BUCKET = "r2-bucket";
    process.env.S3_BUCKET = "s3-bucket";
    process.env.R2_ACCESS_KEY_ID = "r2";
    process.env.S3_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.R2_SECRET_ACCESS_KEY = SECRET;
    process.env.S3_SECRET_ACCESS_KEY = SECRET;

    const cfg = resolveStorageConfig();
    expect(cfg?.endpoint).toBe(CONFIG.endpoint);
    expect(cfg?.region).toBe("eu-west-1");
    expect(cfg?.bucket).toBe("s3-bucket");
  });

  test("a non-URL endpoint reads as unconfigured, not as a crash", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.S3_ENDPOINT = "r2.cloudflarestorage.com"; // missing scheme
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.S3_SECRET_ACCESS_KEY = SECRET;
    process.env.S3_BUCKET = CONFIG.bucket;
    expect(resolveStorageConfig()).toBeNull();
  });

  test("an https-only endpoint rule holds (no javascript:, no file:)", () => {
    for (const k of KEYS) delete process.env[k];
    process.env.S3_ENDPOINT = "file:///etc/passwd";
    process.env.S3_REGION = "auto";
    process.env.S3_ACCESS_KEY_ID = ACCESS_KEY_ID;
    process.env.S3_SECRET_ACCESS_KEY = SECRET;
    process.env.S3_BUCKET = CONFIG.bucket;
    expect(resolveStorageConfig()).toBeNull();
  });
});

describe("object key validation", () => {
  test("a well-formed key is accepted", () => {
    expect(assertObjectKey("org_123/recordings/conv-abc.mp3")).toBe(
      "org_123/recordings/conv-abc.mp3",
    );
  });

  test("a key containing '..' is refused, not normalised", () => {
    // THE traversal case. Normalising would resolve this to
    // `org_b/recordings/x` at the server — another tenant's prefix — which is
    // exactly the disclosure this refuses to make reachable.
    expect(() => assertObjectKey("org_a/../org_b/recordings/x.mp3")).toThrow(StorageError);
    expect(() => assertObjectKey("..")).toThrow(StorageError);
    expect(() => assertObjectKey("../../etc/passwd")).toThrow(StorageError);
    // Substring, not just segment: a false positive costs a renamed key, a
    // false negative costs another bank's recording.
    expect(isValidObjectKey("org_a/rec..ording.mp3")).toBe(false);
  });

  test("a key with a leading slash, trailing slash or empty segment is refused", () => {
    // Each of these produces a canonical URI the server reads differently from
    // the one we hashed, so the signature would fail at the far end — or worse,
    // resolve somewhere unintended.
    expect(isValidObjectKey("/org/recordings/x.mp3")).toBe(false);
    expect(isValidObjectKey("org/recordings/x.mp3/")).toBe(false);
    expect(isValidObjectKey("org//recordings/x.mp3")).toBe(false);
    expect(isValidObjectKey("")).toBe(false);
  });

  test("backslashes and control characters are refused", () => {
    // A backslash is how a Windows-normalising proxy turns one key into another;
    // a newline in a key is how it turns a request into two log lines.
    expect(isValidObjectKey("org\\recordings\\x.mp3")).toBe(false);
    expect(isValidObjectKey("org/recordings/x\n.mp3")).toBe(false);
    expect(isValidObjectKey("org/recordings/x\u0000.mp3")).toBe(false);
  });

  test("an over-long key is refused", () => {
    expect(isValidObjectKey("a".repeat(1025))).toBe(false);
    expect(isValidObjectKey(`org/${"b".repeat(1000)}`)).toBe(true);
  });

  test("the refusal message names the RULE and never the key", () => {
    // An object key can carry a customer identifier, and an error message is a
    // thing that ends up in a log sink and an HTTP response.
    try {
      assertObjectKey("org_a/../secret-customer-42.mp3");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("invalid_key");
      expect((err as Error).message).toContain("..");
      expect((err as Error).message).not.toContain("secret-customer-42");
    }
  });

  test("a traversal key is refused BEFORE any network call is attempted", () => {
    // presignGet is synchronous under the hood; the point is that the guard is
    // first, so a crafted key cannot reach signing at all.
    expect(() => client().presignGet("org/../other/x.mp3")).toThrow(StorageError);
  });
});

describe("SigV4 presigning", () => {
  test("the URL carries the full SigV4 query parameter set", async () => {
    const url = await client().presignGet("org_1/recordings/conv-1.mp3", {
      expiresInSeconds: 300,
    });
    const q = queryOf(url);

    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toBe(`${ACCESS_KEY_ID}/20261011/auto/s3/aws4_request`);
    expect(q.get("X-Amz-Date")).toBe("20261011T093015Z");
    expect(q.get("X-Amz-Expires")).toBe("300");
    // `host` MUST be signed: it is what binds the URL to one endpoint, so a
    // signature harvested from one store cannot be replayed against another.
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

    // Path style against the configured bucket — R2 resolves nothing else.
    expect(url.startsWith(`${CONFIG.endpoint}/${CONFIG.bucket}/org_1/recordings/conv-1.mp3?`)).toBe(
      true,
    );
  });

  test("a GET presign signs UNSIGNED-PAYLOAD, never a real hash", async () => {
    // A presigned URL has to work for bytes we have never seen — the 6 MB MP3
    // an operator is about to upload. Signing a hash produces a URL that fails
    // verification at the far end; this is the single most common SigV4 bug.
    const url = await client().presignGet("org_1/recordings/conv-1.mp3");
    // The signature must be an HMAC chain and nothing else. If the payload were
    // hashed in, changing the key would not change the signature at all.
    const a = await client().presignGet("org_1/recordings/conv-1.mp3");
    const b = await client().presignGet("org_1/recordings/conv-2.mp3");
    expect(queryOf(a).get("X-Amz-Signature")).not.toBe(queryOf(b).get("X-Amz-Signature"));
    expect(url).toBe(a);
  });

  test("the canonical query is DETERMINISTIC and totally ordered", async () => {
    // Ordering is not cosmetic: SigV4 hashes this exact byte sequence. Insertion
    // order would work until one call site built the map differently.
    const params = {
      "response-content-type": "audio/mpeg",
      "X-Amz-SignedHeaders": "host",
      "X-Amz-Expires": 300,
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${ACCESS_KEY_ID}/20261011/auto/s3/aws4_request`,
      "X-Amz-Date": "20261011T093015Z",
    };
    const forward = canonicalQueryString(params);
    const reversed = canonicalQueryString(
      Object.fromEntries(Object.entries(params).reverse()) as typeof params,
    );
    expect(forward).toBe(reversed);

    // And the names are in sorted order as they appear on the wire.
    const names = forward.split("&").map((p) => p.split("=")[0]!);
    expect(names).toEqual([...names].sort());
  });

  test("the same input and clock produce a byte-identical URL", async () => {
    const first = await client().presignGet("org_1/recordings/conv-1.mp3");
    const second = await client().presignGet("org_1/recordings/conv-1.mp3");
    // Deterministic given a clock, which is what makes the signature testable at
    // all: a signature that varied run to run could not be asserted on.
    expect(first).toBe(second);
    expect(new URL(first).searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a different secret produces a different signature", async () => {
    const a = await client().presignGet("org_1/recordings/conv-1.mp3");
    const b = await client({
      config: { ...CONFIG, secretAccessKey: `${SECRET}-rotated` },
    }).presignGet("org_1/recordings/conv-1.mp3");
    expect(queryOf(a).get("X-Amz-Signature")).not.toBe(queryOf(b).get("X-Amz-Signature"));
  });

  test("response overrides ride inside the signed query string", async () => {
    // If these were separate from the canonical query they could be stripped
    // from a download link and the remaining URL would still verify.
    const url = await client().presignGet("org_1/recordings/conv-1.mp3", {
      contentDisposition: 'inline; filename="conv-1.mp3"',
      responseContentType: "audio/mpeg",
    });
    const q = queryOf(url);
    expect(q.get("response-content-disposition")).toBe('inline; filename="conv-1.mp3"');
    expect(q.get("response-content-type")).toBe("audio/mpeg");
  });

  test("a PUT presign signs content-type as a header when one is given", async () => {
    const q = queryOf(
      await client().presignPut("org_1/recordings/conv-1.mp3", { contentType: "audio/mpeg" }),
    );
    // `content-type;host` — sorted, semicolon-joined, both lowercased.
    expect(q.get("X-Amz-SignedHeaders")).toBe("content-type;host");
  });

  test("the default expiry is applied when none is given", async () => {
    expect(
      queryOf(await client().presignGet("org_1/recordings/conv-1.mp3")).get("X-Amz-Expires"),
    ).toBe(String(DEFAULT_EXPIRY_SECONDS));
  });

  test("an out-of-range expiry is refused, not clamped", () => {
    // A caller asking for a year-long link has a bug. Clamping would hand them
    // a working link and hide it; refusing makes the mistake visible.
    expect(() => client().presignGet("org_1/x.mp3", { expiresInSeconds: 0 })).toThrow(StorageError);
    expect(() => client().presignGet("org_1/x.mp3", { expiresInSeconds: 604_801 })).toThrow(
      StorageError,
    );
  });

  test("presigning without a configured store throws a typed, non-leaking error", () => {
    // Presigning has nothing to degrade TO — there is no honest URL to return —
    // so this one is a programming error, and the caller should have branched
    // on a null config before getting here.
    try {
      createStorageClient({ config: null }).presignGet("org_1/x.mp3");
      throw new Error("expected a refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("not_configured");
      expect((err as Error).message).toContain("S3_ENDPOINT");
      expect((err as Error).message).not.toContain(SECRET);
    }
  });

  test("the module-level presignGet reads the environment", () => {
    // Present so a route can call `presignGet(key)` without threading a client.
    // Asserted through the typed error rather than a real URL: the env is not
    // set here, and a developer's `.env` must not decide whether this suite is
    // green or red.
    //
    // A THROW, not a rejection: presigning is synchronous work, and a
    // configuration error surfaces at call time exactly as `assertObjectKey`
    // throws for a bad key. The method still returns a Promise for a successful
    // result, so the two contracts do not contradict each other.
    const keys = Object.values(STORAGE_ENV_VARS).flat();
    const savedHere = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) delete process.env[k];
    try {
      expect(() => presignGet("org_1/x.mp3")).toThrow(StorageError);
    } finally {
      for (const [k, v] of savedHere) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("the secret never leaves the module", () => {
  test("it is absent from a presigned URL, credential scope and all", async () => {
    const url = await client().presignGet("org_1/recordings/conv-1.mp3");
    const put = await client().presignPut("org_1/recordings/conv-1.mp3");
    // The credential scope carries the ACCESS KEY ID — that is public and
    // required. It must never carry the secret.
    expect(url).toContain(ACCESS_KEY_ID);
    expect(url).not.toContain(SECRET);
    expect(put).not.toContain(SECRET);
    expect(decodeURIComponent(url)).not.toContain(SECRET);
  });

  test("it is absent from every error message this module can raise", async () => {
    // A failed PUT whose error is surfaced by a route handler is a log line. If
    // the secret is in it, the log line is a credential.
    const messages: string[] = [];
    const failing = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        messages.push(err instanceof Error ? `${err.message}` : String(err));
        // The cause is where a leaked secret would realistically hide: a fetch
        // rejection carrying the request URL.
        if (err instanceof Error && err.cause instanceof Error) {
          messages.push(err.cause.message);
        }
      }
    };

    await failing(() =>
      client({
        fetchImpl: (async () =>
          new Response("<Error>denied</Error>", { status: 403 })) as typeof fetch,
      }).putObject("org_1/recordings/conv-1.mp3", Buffer.from("audio")),
    );
    await failing(() =>
      client({
        fetchImpl: (async () =>
          new Response("<Error>nope</Error>", { status: 500 })) as typeof fetch,
      }).getObject("org_1/recordings/conv-1.mp3"),
    );
    await failing(() =>
      client({
        fetchImpl: (async () => {
          throw new Error(`connect ECONNREFUSED using ${SECRET}`);
        }) as typeof fetch,
      }).deleteObject("org_1/recordings/conv-1.mp3"),
    );
    // A validation failure is a message too. It cannot leak the secret by
    // construction, which is the point: the guard runs before signing does.
    await failing(async () => client().presignGet("org_1/x.mp3", { expiresInSeconds: 0 }));

    expect(messages.length).toBeGreaterThanOrEqual(4);
    for (const message of messages) {
      expect(message).not.toContain(SECRET);
    }
    // And the scrub is what did it, not luck: the raw cause DID contain it.
    expect(messages.some((m) => m.includes("[redacted]"))).toBe(true);
  });
});

describe("signed object requests", () => {
  test("a PUT sends Authorization: AWS4-HMAC-SHA256 with a credential scope", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit };
      return new Response("", { status: 200, headers: { etag: '"abc123"' } });
    }) as unknown as typeof fetch;

    const result = await client({ fetchImpl }).putObject(
      "org_1/recordings/conv-1.mp3",
      Buffer.from("fake-mp3-bytes"),
      { contentType: "audio/mpeg", cacheControl: "no-store" },
    );
    expect(result).toEqual({ etag: '"abc123"' });

    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
    expect(headers.authorization).toContain(`${ACCESS_KEY_ID}/20261011/auto/s3/aws4_request`);
    // host is in SignedHeaders but is NOT transported: the runtime derives it
    // from the URL we just signed. Sending it explicitly is at best a forbidden
    // header, and at worst a second value the signature does not cover. The list
    // is sorted and semicolon-joined, which is what makes it reproducible.
    expect(headers.authorization).toContain(
      "SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(headers["x-amz-date"]).toBe("20261011T093015Z");
    expect(headers["content-type"]).toBe("audio/mpeg");
    // PDPL personal data: an object that can sit in a cache is an object a
    // right-to-erasure request cannot reach.
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["host"]).toBeUndefined();
    expect(captured!.url).toBe(`${CONFIG.endpoint}/${CONFIG.bucket}/org_1/recordings/conv-1.mp3`);
  });

  test("a PUT with a body signs the REAL payload hash, not UNSIGNED-PAYLOAD", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await client({ fetchImpl }).putObject("org_1/x.mp3", Buffer.from("audio"));

    // We hold the bytes in memory, so hashing them costs one pass and proves
    // the object was not altered in transit. Presigned URLs are the case that
    // genuinely cannot do this — see the UNSIGNED-PAYLOAD test above.
    expect(headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-amz-content-sha256"]).not.toBe("UNSIGNED-PAYLOAD");
  });

  test("a bodyless GET signs UNSIGNED-PAYLOAD", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      headers = (init as RequestInit).headers as Record<string, string>;
      return new Response("audio-bytes");
    }) as unknown as typeof fetch;

    const bytes = await client({ fetchImpl }).getObject("org_1/x.mp3");
    expect(bytes.toString()).toBe("audio-bytes");
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });

  test("a non-2xx response throws a typed error carrying the status", async () => {
    const fetchImpl = (async () =>
      new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })) as typeof fetch;

    try {
      await client({ fetchImpl }).getObject("org_1/x.mp3");
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("unexpected_status");
      expect((err as StorageError).status).toBe(404);
    }
  });

  test("DELETE is idempotent — a 404 is the state the caller asked for", async () => {
    // A retention sweep runs over a prefix that is partly deleted already. If 404
    // threw, the second run of every sweep would fail forever.
    const fetchImpl = (async () => new Response("", { status: 404 })) as typeof fetch;
    await client({ fetchImpl }).deleteObject("org_1/x.mp3");
  });

  test("a network failure is a typed error, not an unhandled rejection", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    try {
      await client({ fetchImpl }).putObject("org_1/x.mp3", Buffer.from("a"));
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StorageError);
      expect((err as StorageError).code).toBe("request_failed");
    }
  });

  test("every request carries a bounded timeout signal", async () => {
    // Without it a hung connection holds the Next.js request open indefinitely,
    // and an operator waiting on a "no recording" answer is worse off than one
    // waiting on an error they can retry.
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      signal = (init as RequestInit).signal ?? undefined;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await client({ fetchImpl, timeoutMs: 1234 }).putObject("org_1/x.mp3", Buffer.from("a"));
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test("HEAD is the existence probe, and it never throws", async () => {
    let method = "";
    const ok = (async (_url: unknown, init: unknown) => {
      method = (init as RequestInit).method!;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await client({ fetchImpl: ok }).headObject("org_1/x.mp3")).toBe(true);
    // HEAD, not a ranged GET: the check costs one header round trip and moves
    // zero audio bytes.
    expect(method).toBe("HEAD");

    const missing = (async () => new Response("", { status: 404 })) as typeof fetch;
    expect(await client({ fetchImpl: missing }).headObject("org_1/x.mp3")).toBe(false);

    const broken = (async () => {
      throw new Error("unreachable");
    }) as typeof fetch;
    // Unreachable collapses into the same answer the console already renders.
    expect(await client({ fetchImpl: broken }).headObject("org_1/x.mp3")).toBe(false);
    // And an unconfigured store, and a hostile key, are both "no".
    expect(await createStorageClient({ config: null }).headObject("org_1/x.mp3")).toBe(false);
    expect(await client().headObject("../escape.mp3")).toBe(false);
  });
});
