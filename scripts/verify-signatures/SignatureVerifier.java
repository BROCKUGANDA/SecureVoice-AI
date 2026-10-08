/*
 * SecureVoice bank-side signature verification — Java reference implementation.
 *
 * For integration teams on core-banking platforms, where the receiver is a
 * permanent, audited piece of infrastructure and "we re-serialised the JSON"
 * is the bug that gets discovered in production. This file is the THIRD
 * reference implementation of the same scheme; the TypeScript
 * (scripts/verify_sv_signature.ts) and Python
 * (scripts/verify_sv_signature.py) verifiers are the other two, and the
 * cross-language agreement is what makes the scheme a contract rather than a
 * claim about one runtime.
 *
 * ── The scheme ─────────────────────────────────────────────────────────────
 *
 *   header  SV-Signature: t={unix_seconds},v1={hex64}
 *   digest  v1 = HMAC_SHA256(secret, "{t}." + raw_body_bytes)
 *   body    the EXACT request bytes as received. Do not re-serialise.
 *
 * ── The four mistakes this implementation is shaped to prevent ─────────────
 *
 *   1. Verifying a re-serialised body. JSON key order and number formatting
 *      are not preserved by a parse/serialise round trip, so the digest will
 *      not match and the rejection will look like a key rotation problem. This
 *      class verifies over a byte[] and never over a String it built itself.
 *   2. Verifying before capturing the raw bytes. Servlet containers may have
 *      already consumed the stream by the time your controller runs; use a
 *      filter (see RawBodyCapture below) that buffers the body BEFORE any
 *      parsing. BodyVerifier.VERIFY is null when the filter did not run, and
 *      the verifier REFUSES rather than falling back to a re-read.
 *   3. Non-constant-time comparison. String.equals on a digest leaks it. This
 *      uses MessageDigest.isEqual, which is constant time for equal lengths.
 *   4. Trusting an unbounded timestamp. An HMAC over a body captured by a
 *      proxy is replayable forever unless a window is enforced. DEFAULT_TOLERANCE_SECONDS
 *      matches the sender's window exactly; do not widen it.
 *
 * ── Compile and run (JDK 8 or later; no dependencies) ──────────────────────
 *
 *   javac -d out SignatureVerifier.java
 *   java -cp out SignatureVerifier <raw_body_file> <signature_header> <secret>
 *
 * Exit codes: 0 verified, 1 rejected (reason on stderr), 2 usage error.
 *
 * ── Embedding ──────────────────────────────────────────────────────────────
 *
 *   SignatureVerifier.Result result = SignatureVerifier.verify(rawBytes, header, secret);
 *   if (!result.ok) { auditLog.warn("sv_signature_rejected {}", result.reason); return 401; }
 *
 * Do not import the secret from an environment variable into a long-lived
 * process without understanding where it lands in a heap dump — the same
 * applies to this implementation as to any credential.
 */
package securevoice.integration;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Locale;

public final class SignatureVerifier {

    /** The header name. HTTP lower-cases it on the wire; read it case-insensitively. */
    public static final String HEADER_NAME = "sv-signature";

    /**
     * The sender's replay window. Widening it weakens the scheme; narrowing it
     * breaks honest receivers. Defaults to 300 to match the sender's
     * REPLAY_WINDOW_SEC (src/lib/config.ts); the env override exists so both
     * sides can be moved together during a rotation window.
     */
    public static final long DEFAULT_TOLERANCE_SECONDS = toleranceFromEnv();

    private static long toleranceFromEnv() {
        String raw = System.getenv("REPLAY_WINDOW_SEC");
        if (raw == null || raw.isBlank()) return 300L;
        try {
            return Long.parseLong(raw.trim());
        } catch (NumberFormatException e) {
            return 300L;
        }
    }

    private static final String ALGORITHM = "HmacSHA256";

    /** Never construct one; the class is a namespace for the static entry points. */
    private SignatureVerifier() {
    }

    /**
     * A verification verdict.
     *
     * <p>{@code ok} false always carries a machine-readable {@code reason}, which
     * is one of: missing_signature, malformed_signature, malformed_timestamp,
     * stale_timestamp, digest_mismatch. Those five values are the contract; the
     * sender emits the same vocabulary, so a log line quoting one is comparable
     * across the two sides.</p>
     */
    public static final class Result {
        public final boolean ok;
        public final String reason;
        /** The timestamp parsed out of the header, or -1 when it was absent/unparseable. */
        public final long timestampSeconds;

        private Result(boolean ok, String reason, long timestampSeconds) {
            this.ok = ok;
            this.reason = reason;
            this.timestampSeconds = timestampSeconds;
        }

        static Result good(long timestampSeconds) {
            return new Result(true, "ok", timestampSeconds);
        }

        static Result bad(String reason, long timestampSeconds) {
            return new Result(false, reason, timestampSeconds);
        }

        @Override
        public String toString() {
            return (ok ? "VERIFIED" : "REJECTED") + ": " + reason;
        }
    }

    /**
     * Verify an SV-Signature header over raw request bytes.
     *
     * @param rawBody the exact bytes received, before any parsing. Passing a
     *                re-serialised document is the single most common cause of a
     *                false rejection.
     * @param header  the header value, or null when absent.
     * @param secret  the shared signing secret.
     * @return a verdict. Never throws for bad input — a malformed header is a
     *         rejection, not an exception, so a hostile caller cannot turn the
     *         verifier into an error path.
     */
    public static Result verify(byte[] rawBody, String header, String secret) {
        return verify(rawBody, header, secret, DEFAULT_TOLERANCE_SECONDS, System.currentTimeMillis());
    }

    /** Full form: explicit tolerance and clock, so the verifier is unit-testable without sleeping. */
    public static Result verify(byte[] rawBody, String header, String secret, long toleranceSeconds, long nowMillis) {
        if (rawBody == null) {
            return Result.bad("missing_signature", -1L);
        }
        if (header == null || header.trim().isEmpty()) {
            return Result.bad("missing_signature", -1L);
        }
        if (secret == null || secret.isEmpty()) {
            // Fail closed. An unconfigured secret must never accept anything.
            return Result.bad("digest_mismatch", -1L);
        }

        // Header grammar: comma-separated k=v pairs, whitespace tolerated, first
        // occurrence wins — matching the sender's parser rather than inventing a
        // stricter one that would reject a delivery the sender considers valid.
        String timestamp = null;
        String digest = null;
        for (String part : header.split(",")) {
            String chunk = part.trim();
            int eq = chunk.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String key = chunk.substring(0, eq).trim().toLowerCase(Locale.ROOT);
            String value = chunk.substring(eq + 1).trim();
            if ("t".equals(key) && timestamp == null) {
                timestamp = value;
            } else if ("v1".equals(key) && digest == null) {
                digest = value;
            }
        }

        if (timestamp == null || digest == null || digest.isEmpty()) {
            return Result.bad("malformed_signature", -1L);
        }

        long ts;
        try {
            ts = Long.parseLong(timestamp);
        } catch (NumberFormatException notANumber) {
            return Result.bad("malformed_timestamp", -1L);
        }

        // The window is checked in BOTH directions. A timestamp from the future is
        // as suspicious as one from the past, and a sender with a fast clock
        // would otherwise be able to pin a signature open indefinitely.
        long skewMillis = Math.abs(nowMillis - ts * 1000L);
        if (skewMillis > toleranceSeconds * 1000L) {
            return Result.bad("stale_timestamp", ts);
        }

        byte[] expected = computeDigest(secret, timestamp, rawBody);
        byte[] provided;
        try {
            provided = hexToBytes(digest);
        } catch (IllegalArgumentException notHex) {
            return Result.bad("malformed_signature", ts);
        }
        if (expected.length != provided.length) {
            return Result.bad("digest_mismatch", ts);
        }
        // Constant time. Do not replace this with Arrays.equals or String.equals.
        return MessageDigest.isEqual(expected, provided) ? Result.good(ts) : Result.bad("digest_mismatch", ts);
    }

    /**
     * The signed message is the timestamp, a literal dot, then the raw bytes —
     * not a concatenation of three Strings, because the body is not valid UTF-8
     * in general and String concatenation would silently replace malformed
     * sequences with U+FFFD, changing the bytes that were hashed.
     */
    private static byte[] computeDigest(String secret, String timestamp, byte[] rawBody) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), ALGORITHM));
            mac.update(timestamp.getBytes(StandardCharsets.UTF_8));
            mac.update((byte) '.');
            return mac.doFinal(rawBody);
        } catch (GeneralSecurityException impossible) {
            // HmacSHA256 is required of every JRE. If it is missing, the platform
            // is not fit to verify a signature and failing closed is the answer.
            throw new IllegalStateException("HmacSHA256 unavailable", impossible);
        }
    }

    private static byte[] hexToBytes(String hex) {
        int length = hex.length();
        if ((length & 1) != 0) {
            throw new IllegalArgumentException("hex string must have an even length");
        }
        byte[] out = new byte[length / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(hex.charAt(i * 2), 16);
            int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) {
                throw new IllegalArgumentException("hex string contains a non-hex character");
            }
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    /** Build the header value the SENDER would produce. Provided so a receiver's test can sign and verify in one process. */
    public static String sign(byte[] rawBody, String secret, long timestampSeconds) {
        byte[] digest = computeDigest(secret, Long.toString(timestampSeconds), rawBody);
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return "t=" + timestampSeconds + ",v1=" + hex;
    }

    public static void main(String[] args) throws IOException {
        if (args.length != 3) {
            System.err.println("usage: java SignatureVerifier <raw_body_file> <signature_header> <secret>");
            System.err.println("  exit 0 = verified, 1 = rejected, 2 = usage error");
            System.exit(2);
        }
        byte[] body = Files.readAllBytes(Paths.get(args[0]));
        Result result = verify(body, args[1], args[2]);
        System.out.println(result.toString());
        System.exit(result.ok ? 0 : 1);
    }

    /*
     * ── Web-tier integration, where the raw bytes are the hard part ─────────
     *
     * RawBodyCapture is a filter sketch, not code to paste blindly: wire it
     * BEFORE the body is parsed and hand the byte[] to verify(). The shape is:
     *
     *   class RawBodyCapture implements Filter {
     *       static final ThreadLocal<byte[]> VERIFY = new ThreadLocal<>();
     *       void doFilter(ServletRequest req, ServletResponse res, FilterChain chain) {
     *           byte[] raw = StreamUtils.copyToByteArray(req.getInputStream());
     *           req.getInputStream().reset();          // let the controller re-read
     *           VERIFY.set(raw);
     *           try { chain.doFilter(req, res); } finally { VERIFY.remove(); }
     *       }
     *   }
     *
     * A cap is mandatory (the sender's payload is a small JSON object; anything
     * beyond a few kilobytes is not a SecureVoice delivery). Do NOT read the
     * body twice from the socket, and do not trust a Content-Length to decide
     * how much to read.
     */
}
