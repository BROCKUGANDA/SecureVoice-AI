# Supabase root CA — the development/test database trust anchor
#
# WHY THIS FILE IS COMMITTED (it is a public CA certificate, not a secret):
#
# `DATABASE_URL` needs `sslmode=verify-full&sslrootcert=supabase-ca.crt` or every
# DB-backed suite fails with:
#
#     TlsConnectionError: self signed certificate in certificate chain
#
# Two facts about that failure, because both are counter-intuitive and both cost
# real time to diagnose:
#
#   1. The server is NOT misconfigured. `db.<project>.supabase.co` presents a
#      genuine chain up to "Supabase Root 2021 CA" (see the certificate below).
#      `sslmode=require` asks `pg` to verify that chain against Node's DEFAULT
#      root store, and Supabase's root is not in it. "self signed certificate in
#      certificate chain" is therefore the local trust store missing an anchor,
#      not a hostile server. It reproduces identically in Bun AND Node, so it is
#      not a runtime quirk either.
#
#   2. Removing `sslmode` "fixes" it by falling back to no verification at all
#      (`server_ssl=on` but unverified). That is the wrong trade: it looks like a
#      fix and silently removes protection on the connection that carries case
#      rows, transcripts and phone numbers. Do not do that.
#
# Pinning the anchor instead makes verification STRICTER than `require`: the full
# chain is validated to this exact root, so a certificate issued by anyone else
# is rejected. Fetch it from Supabase and check the fingerprint before trusting:
#
#   curl -o supabase-ca.crt \
#     https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
#   openssl x509 -in supabase-ca.crt -noout -subject -issuer -dates -fingerprint -sha256
#
# Expected (prod-ca-2021.crt):
#   subject=C=US, ST=Delware, L=New Castle, O=Supabase Inc, CN=Supabase Root 2021 CA
#   notAfter=Apr 26 10:56:53 2031 GMT
#   SHA256 = 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
#
# Rotate before Apr 2026-04-26. If a DB outage starts with that TLS error and the
# clock is near the notAfter date, this file is the thing to replace.
#
# PRODUCTION: not needed. The VPS runs its own Postgres on a private network and
# compose passes DB_ALLOW_PLAINTEXT_PRIVATE_NETWORK=true, so DATABASE_URL there is
# built from POSTGRES_* parts with no sslmode at all.