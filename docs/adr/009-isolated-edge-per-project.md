# ADR-009: One edge per project, behind a shared L4 front door

## Context

One physical box in one OVHcloud region (GRA11, Gravelines — France) serves two
products. Until 2026-10-22, both of them were served by **one** Caddy container.

That container did three things at once, and the third is the one that cost
money.

1. It terminated TLS for both products and issued both products' certificates.
2. It routed both products' traffic and wrote both products' access logs.
3. It reached the other product's containers **by service name**, which only
   resolves from inside that product's Docker network — so the shared edge was
   hand-attached to a network that this project's compose file does not own.

Point 3 is a capability, not a convenience. An edge that can open a connection
to another product's database is an edge that can be used to do so. And
`docker compose up` rebuilds a container from _its own_ compose definition, so
every recreate dropped those hand-made attachments.

**This was not theoretical.** On 2026-10-21 a traffic flip recreated the shared
edge, the attachment to the other product's network was silently dropped, and
that product answered 502 for every request while every one of its own
containers reported itself healthy. One product's deploy was the other
product's outage, and the failing product's own dashboard said everything was
fine.

The first fix preserved the attachments across a recreate
(`scripts/deploy.mjs`, `reattachCaddyNetworks`). It worked. It was also the
wrong shape: it kept the cross-project capability alive indefinitely, made this
repository's deploy script responsible for another product's reachability, and
left the blast radius exactly where it was.

Three forces push the same direction, which is why this is a decision rather
than a preference.

**Blast radius.** One edge, one process, one configuration file, two products.
A Caddyfile bug, a certificate expiry, a bad upgrade, a memory leak or a
traffic flip in _either_ product takes down _both_. The 2026-10-21 incident is
the measured instance.

**Trust boundary.** A shared Caddy gives each product a capability against the
other's containers, and a shared log file gives each product's operators read
access to the other's traffic metadata. No compliance regime — GDPR, UAE PDPL,
or a bank's own due diligence — accepts "the two tenants share an edge process"
as isolation. It is not isolation; it is a shared process with a friendly name.

**Three availability zones.** The target topology is three AZ. Every zone must
serve the _same_ hostname list from the _same_ configuration, because a
difference between zones is a TLS/SNI failure that only one of the three has.
The old arrangement made that impossible by construction: the effective edge
configuration was the tracked `Caddyfile` **plus** an untracked, host-local
`sites.d/*.caddy` directory, so "the same configuration in every zone" was not
a thing that could be true.

There is also a commercial motivation, and it is a real one: a product sold on
"data never leaves the country" cannot be deployed in France and re-deployed in
the UAE by changing a region string. Sovereignty means the architecture has to
be _portable_ — every piece of it reviewable, versioned and movable — and a
box-level, untracked, hand-edited edge configuration is the least portable
thing in the stack.

## Decision

**Each product gets its own Caddy, with its own Caddyfile, in its own
repository, in its own Docker network. On a host that serves more than one
product, a small L4 front door owns the public `:80`/`:443` and forwards each
connection to the right edge by SNI.**

**The front door is `nginx stream` + `ssl_preread`, and it is nothing else.**
It does not terminate TLS, does not parse HTTP, does not read a header, URL,
body or cookie, holds no certificate and no secret, and shares no Docker
network with any product. It runs in the host's network namespace and reaches
each edge over `127.0.0.1`.

The shared surface between two products is therefore **a hostname and a port**.
A wrong entry in that table is a routing mistake. It is not a capability to
read the other product's traffic, its logs, its containers or its certificates.

**A name that is in no table is refused, not routed.** The default in the
table is a closed port on loopback, so an unrecognised SNI gets no service and
no information about what is behind the host.

**The tracked `Caddyfile` is the whole edge configuration.** The
`import sites.d/*.caddy` wildcard is removed. There is no host-local directory
of site blocks any more, because:

- every hostname this edge answers for is a literal in a reviewed file, so
  "which names does this company serve?" is answered by the repository rather
  than by a directory listing on a host;
- the configuration is then identical in every availability zone by
  construction, rather than by discipline;
- adding a hostname becomes a reviewed change on a branch, promoted like any
  other change.

**The per-product table is shipped by the product that owns the name.** Each
project writes `edge/nginx/edge.d/<project>.sni.map` and
`<project>.host.map`; the front door includes the whole directory. A project
adding a hostname edits its own map file and nothing else.

**The deploy script enforces the isolation instead of accommodating it.** It
still reads the networks the edge is attached to, because the attachment is
what caused the outage — but the meaning changed:

- before the cutover (`edge` mode `shared`), a foreign attachment is
  **preserved** and reported loudly, because dropping it is the 2026-10-21
  outage and a deploy script that starts failing on a production box is a
  worse outcome than a deprecated arrangement that still works;
- after the cutover (`edge` mode `isolated`), a foreign attachment is a
  **hard error** and the recreate is refused, because preserving it would
  quietly re-create the coupling this decision exists to end.

`bun scripts/deploy.mjs edge-status` reports the state; `edge-isolate --yes`
performs the cutover, and it refuses unless the public path is already being
served by the front door.

### Alternatives that were rejected

**One Caddy for everything, kept as it was.** The status quo, and the thing
this record exists to end. Rejected on the measured 2026-10-21 outage and on
the three-AZ requirement, which it cannot satisfy.

**One Caddy for everything, but with the attachments preserved.** This is what
the code did between 2026-10-21 and this record. It works and it is a
mitigation for a symptom: the cross-project capability, the shared blast
radius and the un-reviewable effective configuration all remain. A mitigation
that preserves the thing it mitigates is not a fix.

**One IP per product, each edge binding its own address.** Cleaner on paper —
no shared component at all. Rejected on two measured grounds. First, an
OVHcloud failover IP rewrites the source address, and `src/proxy.ts` turns
`X-Forwarded-For` into the rate-limit key and the audit trail, so a rewritten
source address is a correctness problem and not only a logging one. Second,
the per-product address has to be re-plumbed for each of three availability
zones, whereas a loopback port is a per-zone detail of that zone's edge.

**An HTTP reverse proxy in front of the edges (nginx `http{}` +
`proxy_pass`).** It would terminate TLS, which moves certificates to a place
that is not the product's repository, and it would parse every request, which
puts a request-inspecting component in front of the entire trust model
`src/proxy.ts` depends on. The L4 router is smaller than the thing it fronts.

**The other product's edge lives in this repository.** It would make the
coupling visible instead of removing it, and it would put one product's
routing in another product's repository. The front door's table is the only
place the two products' names meet, and it is a table of names.

## Consequences

**Positive.**

- The failure of this project's edge is this project's failure. The 2026-10-21
  class of incident cannot recur across the product boundary.
- The effective edge configuration is reviewable, and identical in every
  availability zone by construction.
- A product's operators can read their product's edge logs without reading
  another product's traffic metadata.
- The edge becomes movable: the same tracked `Caddyfile` and the same compose
  file run in France, in the UAE, and in each of three zones.

**Negative, stated plainly.**

- **The front door is a new single point of failure for the public path.** It
  is deliberately as small as it can be, and it is a TCP forwarder rather than
  a proxy, but it is one process that every connection passes through. Until
  there are three zones, this trades a shared _application_ failure domain for
  a shared _transport_ one — a strictly smaller domain, but not none.
- **HTTP/3 is not available behind the front door.** QUIC cannot be routed by
  SNI at this layer. Nothing live is lost: the production firewall never
  opened UDP 443 (`terraform/versions.tf` opens TCP 80 and 443 only), so
  HTTP/3 has never been reachable on that host.
- **Adding a hostname is now a change in a repository** rather than a file
  written on a host. That is slower, and it is the point: a hostname is a
  published surface, and a published surface should be reviewed.
- **Two Caddys means two certificate sets and two renewals** on a host, and
  two health checks to watch. The front door's table is one more thing to keep
  in step with the Caddyfiles — which is why
  `tests/unit/edge-isolation.test.ts` compares the two name lists rather than
  trusting a human to.
- **The cutover is a manual, operator-driven step on the production box**, and
  the other product has to do its half first. The cutover is refused unless
  the public path is already being served by the front door, so a half-done
  cutover cannot take a product offline — but it does mean the two products
  have to be cut over in the same window, or one of them keeps the shared
  edge until it is ready.
- **The deploy script keeps a deprecated path alive** (`edge` mode `shared`).
  It is removed when the last box is cut over.

## Evidence

`Caddyfile` (no host-local import; the site list is the whole list) ·
`docker-compose.yml` (the edge declares exactly one network, and its host
bindings are loopback when it is behind the front door) ·
`edge/nginx/edge.conf` (L4 only — no `http {}` block, `ssl_preread on`, a
fail-closed default) · `edge/nginx/edge.d/securevoice.sni.map` and
`securevoice.host.map` (this product's table) · `scripts/deploy.mjs`
(`edge-status`, `edge-isolate`, and the refuse-rather-than-preserve rule) ·
`tests/unit/edge-isolation.test.ts` (the name lists, the network, the
fail-closed default, and the deploy script's two modes) ·
`tests/unit/bluegreen-invariants.test.ts` (still exactly one place that
recreates the edge) · `docs/VPS-RECOVERY.md` failure mode #3 (the cutover
runbook) · `edge/README.md` (the topology and the rejected alternatives).
