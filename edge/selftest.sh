#!/bin/bash
# A local proof that the front door routes by SNI, before the production
# switch. Two TLS backends with different certificates, one front door, and
# the question that matters: does a connection for name A land on backend A?
#
# It is the whole mechanism in one test. Everything else about the front
# door -- the fail-closed default, the :80 Host routing -- is a table.
set -euo pipefail
say() { echo "==> $*"; }

WORK="$(mktemp -d)"
trap 'docker rm -f fd-test-a fd-test-b fd-test-door >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# ── two backends, each with a self-signed certificate for its own name ──────
make_backend() {
	local name="$1" dir="$WORK/$1"
	mkdir -p "$dir"
	openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
		-subj "/CN=$name" -keyout "$dir/key.pem" -out "$dir/cert.pem" >/dev/null 2>&1
	cat >"$dir/nginx.conf" <<EOF
events {}
http {
    server {
        listen 443 ssl;
        ssl_certificate     /etc/ssl/cert.pem;
        ssl_certificate_key /etc/ssl/key.pem;
        server_name $name;
        location / { return 200 "backend=$name\n"; }
    }
}
EOF
}

make_backend alpha.svalley.tech
make_backend beta.svalley.tech

say "starting two backends"
docker run -d --name fd-test-a -p 127.0.0.1:18444:443 \
	-v "$WORK/alpha.svalley.tech:/etc/ssl:ro" \
	-v "$WORK/alpha.svalley.tech/nginx.conf:/etc/nginx/nginx.conf:ro" \
	nginx:1.27-alpine >/dev/null
docker run -d --name fd-test-b -p 127.0.0.1:18445:443 \
	-v "$WORK/beta.svalley.tech:/etc/ssl:ro" \
	-v "$WORK/beta.svalley.tech/nginx.conf:/etc/nginx/nginx.conf:ro" \
	nginx:1.27-alpine >/dev/null

# ── the front door, with the listen ports moved for the test ────────────────
say "building the test front door"
mkdir -p "$WORK/edge.d"
cat >"$WORK/edge.d/test.sni.map" <<'EOF'
alpha.svalley.tech 127.0.0.1:18444;
beta.svalley.tech 127.0.0.1:18445;
EOF
cat >"$WORK/edge.d/test.host.map" <<'EOF'
alpha.svalley.tech 127.0.0.1:18080;
beta.svalley.tech 127.0.0.1:18081;
EOF
# The real configuration, with the ports moved so the test does not need the
# public ones, and the plaintext listener pointed at a port nothing answers
# (the point of the test is the TLS path).
sed -e 's/listen 443;/listen 18443;/' \
	-e 's/listen \[::\]:443;/listen [::]:18443;/' \
	-e 's/listen 80;/listen 18080;/' \
	-e 's/listen \[::\]:80;/listen [::]:18080;/' \
	"$(dirname "$0")/nginx/edge.conf" >"$WORK/edge.conf"

say "validating the test front door"
docker run --rm -v "$WORK/edge.conf:/etc/nginx/nginx.conf:ro" \
	-v "$WORK/edge.d:/etc/nginx/edge.d:ro" nginx:1.27-alpine nginx -t 2>&1 | tail -2

say "starting the front door"
docker run -d --name fd-test-door --network host \
	-v "$WORK/edge.conf:/etc/nginx/nginx.conf:ro" \
	-v "$WORK/edge.d:/etc/nginx/edge.d:ro" \
	nginx:1.27-alpine >/dev/null
sleep 2

# ── the question ─────────────────────────────────────────────────────────────
say "which backend answers for which name?"
fail=0
for pair in "alpha.svalley.tech alpha" "beta.svalley.tech beta"; do
	read -r name want <<<"$pair"
	cn="$(echo | openssl s_client -servername "$name" -connect 127.0.0.1:18443 2>/dev/null \
		| openssl x509 -noout -subject 2>/dev/null || echo NONE)"
	body="$(curl -sk --resolve "$name:18443:127.0.0.1" "https://$name:18443/" 2>/dev/null || echo none)"
	echo "    $name -> certificate: $cn | body: $body"
	case "$cn" in
	*"CN = $name"* | *"CN=$name"*) ;;
	*) echo "    FAIL: $name did not reach the $name backend" >&2; fail=1 ;;
	esac
	case "$body" in
	*"backend=$want"*) ;;
	*) echo "    FAIL: $name got '$body', expected backend=$want" >&2; fail=1 ;;
	esac
done

say "an unknown name is refused, not routed"
# `curl -w '%{http_code}'` prints 000 AND exits non-zero when the connection is
# refused, so a `|| echo 000` would append a SECOND 000 and the comparison
# would be against the wrong string. Take what curl printed and ignore the
# exit status; the printed code is the answer.
code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
	--resolve unknown.example.com:18443:127.0.0.1 "https://unknown.example.com:18443/" 2>/dev/null || true)"
echo "    unknown name -> $code (000 means the connection was refused, which is the point)"
[ "${code:0:3}" = "000" ] || {
	echo "    FAIL: an unknown name was routed somewhere" >&2
	fail=1
}

[ "$fail" = "0" ] || { echo "THE SNI ROUTING DOES NOT WORK" >&2; exit 1; }
echo
echo "==> the front door routes by SNI, and refuses a name it does not know."
