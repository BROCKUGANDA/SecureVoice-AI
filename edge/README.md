# The shared front door

One box, more than one product, and **one edge per product** — with a small
L4 router in front of them so they can share the host's `:80` and `:443`
without sharing anything else.

This directory holds the front door's configuration and **this project's**
fragment of its routing table. The decision it implements is
[`docs/adr/009-isolated-edge-per-project.md`](../docs/adr/009-isolated-edge-per-project.md);
the cutover runbook is in
[`docs/VPS-RECOVERY.md`](../docs/VPS-RECOVERY.md), failure mode #3.

---

## The topology

```
                       public :443, :80
                              │
                    ┌─────────▼─────────┐
                    │  the front door   │   nginx stream + ssl_preread
                    │  (edge/compose.yml)│   TCP forwarder, no TLS, no HTTP
                    └─────────┬─────────┘
             SNI=securevoiceai.me      SNI=the other product
                    │                          │
        ┌───────────▼───────────┐   ┌──────────▼──────────┐
        │  THIS project's edge  │   │  the other product's │
        │  Caddy  (Caddyfile)   │   │  own edge           │
        │  127.0.0.1:8443       │   │  127.0.0.1:8444     │
        │  its own Docker net   │   │  its own Docker net │
        └───────────┬───────────┘   └─────────────────────┘
                    │
              app / realtime / workers
```

Before this, all three products were served by **one** Caddy container that
was hand-attached to **all** of their Docker networks.

---

## What the front door is, precisely

Two listeners, and they are deliberately not the same kind of thing.

|                         |                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Terminates TLS          | **No.** The edge owns the certificate.                                                  |
| Parses the TLS path     | **No.** `ssl_preread` reads the SNI out of the ClientHello and nothing else.            |
| Parses the `:80` path   | **Yes — and it has to.** A plaintext connection carries no SNI.                          |
| Holds a secret          | **No.** No key, no token, no credential.                                                |
| Shares a Docker network | **No.** It runs in the host's network namespace and reaches each edge over `127.0.0.1`. |
| Has per-project state   | **No.** A project's whole contribution is two map files.                                |
| Routes by               | SNI on `:443`, `Host` header on `:80`.                                                  |

### The one bounded exception, and why it is bounded

`:443` — where **every** cookie, credential and byte of case data travels — is
a pure L4 forward. It is never terminated, never decrypted, never parsed.

`:80` is plaintext, and a hostname cannot be read out of a plaintext
connection without parsing HTTP. So the `:80` listener is an HTTP listener,
and it does exactly two things: it forwards the request to the edge that owns
the `Host`, and it lets that edge answer. The edge then does what it did
before the split — it redirects to HTTPS **with its own security headers**,
and it answers the ACME HTTP-01 challenge **with its own certificate**. The
public behaviour of every name is unchanged.

The alternative was to keep this process 100% L4: make the front door
generate the HTTP-to-HTTPS redirect itself, and move certificate issuance to
TLS-ALPN-01 so the challenge rides the SNI path. That would have changed the
certificate lifecycle and the redirect's headers on a box serving live
traffic. The bounded exception was the smaller change.

The shared surface between two products is therefore **a name and a port**.
A wrong entry in that table is a routing mistake. It is not a capability to
read the other product's TLS traffic, its logs, its containers or its
certificates.

### Fail-closed

A name that is in no map is forwarded to `127.0.0.1:9` — the reserved
discard port, which is never listening. The connection is refused and the
client connection is closed with no response. An unrecognised SNI gets no
service and no information about what is behind the host.

---

## The routing table

Two files per project, both shipped by that project and reviewed in that
project's repository:

| File                              | Keyed by      | Used by             |
| --------------------------------- | ------------- | ------------------- |
| `nginx/edge.d/<project>.sni.map`  | SNI           | the `:443` listener |
| `nginx/edge.d/<project>.host.map` | `Host` header | the `:80` listener  |

This project's pair is here: `nginx/edge.d/securevoice.sni.map` and
`nginx/edge.d/securevoice.host.map`.

The **names** in those files are checked against the site list in this
repository's `Caddyfile` by `tests/unit/edge-isolation.test.ts`, so the front
door and the edge cannot disagree about what this project serves. The
**ports** are checked against the running container by
`bun scripts/deploy.mjs edge-status`.

On the host, the tables from every project are collected into one directory
(`/srv/edge/edge.d` by default) and the front door includes the whole
directory. A project adding a hostname ships its own map file; it does not
edit the front door.

---

## Why not the alternatives

**One IP per project.** Cleaner on paper — no shared component at all. It was
rejected for two measured reasons: an OVHcloud failover IP rewrites the
source address, and `src/proxy.ts` turns `X-Forwarded-For` into the
rate-limit key and the audit trail, so a rewritten source address is a
correctness problem and not only a logging one; and the per-project IP has
to be re-plumbed for every one of three availability zones, whereas a
loopback port is a per-zone detail of the edge itself.

**One Caddy for everything, kept as it was.** That is the arrangement this
replaces. Its measured cost: on 2026-10-21 a traffic flip in this project
recreated the shared edge, the attachment to the other project's network was
dropped, and that project's product answered 502 for every request while
every one of its own containers reported itself healthy.

**An HTTP reverse proxy in front (nginx `http{}` + `proxy_pass`).** It would
terminate TLS, which means certificates move to a place that is not the
product's repository, and it would parse every request, which puts a
request-inspecting component in front of the entire trust model that
`src/proxy.ts` depends on. The L4 router is smaller than the thing it fronts.

---

## Running it

```bash
mkdir -p /srv/edge/edge.d
cp edge/nginx/edge.d/securevoice.*.map /srv/edge/edge.d/

docker compose -f edge/compose.yml up -d
docker compose -f edge/compose.yml exec router nginx -t   # validate
```

`nginx -t` validates the configuration before nginx starts, so a malformed
table is a refusal rather than a half-working front door.

To try it locally against this repository's own tables:

```bash
EDGE_FRAGMENT_DIR=./edge/nginx/edge.d docker compose -f edge/compose.yml up -d
```

---

## What it does NOT do, and where that is handled instead

- **It does not terminate TLS.** The certificate stays with the edge, and
  ACME stays with the edge: the HTTP-01 challenge arrives on the public
  `:80`, the front door forwards it to the edge that owns the name, and that
  edge answers it itself.
- **It does not redirect HTTP to HTTPS.** That redirect, and the security
  headers that belong with it, live in the project's own `Caddyfile`.
- **It does not carry HTTP/3.** QUIC cannot be routed by SNI at this layer,
  and the front door does not terminate QUIC. Nothing live is lost: the
  production firewall never opened UDP 443 (`terraform/versions.tf` opens TCP
  80 and 443 only), so HTTP/3 has never been reachable on that host.
- **It does not add availability.** One front door on one box is still one
  box. The three-AZ topology is in
  [`docs/INFRASTRUCTURE.md`](../docs/INFRASTRUCTURE.md).
