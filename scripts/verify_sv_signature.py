#!/usr/bin/env python3
"""
Bank-side verification for SecureVoice outbound webhooks (WP-5).

This is the reference implementation the brief asks a bank's integration team
to copy. It is the SECOND language implementation of the same scheme, and the
WP-5 gate executes it against a real delivery, so the cross-language claim is
tested rather than asserted.

Scheme
------
  header : SV-Signature: t={unix_seconds},v1={hex}
  digest : v1 = HMAC_SHA256(secret, f"{t}.{body}")
  body   : the RAW request bytes, exactly as received. Do not re-serialise it:
           re-encoding a JSON document changes the bytes and breaks the digest.

Verify
------
    python verify_sv_signature.py <raw_body_file> <signature_header> <secret>

Exit 0 = verified, exit 1 = rejected (with the reason on stderr).
"""

import hashlib
import hmac
import sys
import time

TOLERANCE_SECONDS = 300  # replay window


def canonical_json(value) -> str:
    """Mirror of the sender's canonicalisation (sorted keys, every depth).

    Needed only if you rebuild the body instead of keeping the raw bytes —
    which you should not. Kept here so the two implementations can be diffed.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json_number(value)
    if isinstance(value, str):
        return json_string(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted((k, v) for k, v in value.items() if v is not None)
        return "{" + ",".join(json_string(k) + ":" + canonical_json(v) for k, v in items) + "}"
    raise TypeError(f"unsupported type: {type(value)!r}")


def json_string(s: str) -> str:
    import json

    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def json_number(n) -> str:
    import json

    return json.dumps(n)


def verify(raw_body: bytes, signature_header: str, secret: str, tolerance: int = TOLERANCE_SECONDS):
    if not signature_header:
        return False, "missing_signature"
    parts = {}
    for chunk in signature_header.split(","):
        if "=" in chunk:
            k, v = chunk.strip().split("=", 1)
            parts[k] = v
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False, "malformed_signature"
    try:
        ts = int(t)
    except ValueError:
        return False, "malformed_timestamp"
    if abs(time.time() - ts) > tolerance:
        return False, "stale_timestamp"
    expected = hmac.new(secret.encode("utf-8"), f"{t}.".encode("utf-8") + raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        return False, "digest_mismatch"
    return True, "ok"


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    body_path, header, secret = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(body_path, "rb") as fh:
        raw = fh.read()
    ok, reason = verify(raw, header, secret)
    print(("VERIFIED" if ok else "REJECTED") + f": {reason}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
