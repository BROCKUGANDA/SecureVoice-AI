# Infrastructure

Three things live here: the **blue/green deployment** that ships a release without
dropping a live call, and the **Terraform** that provisions the box it ships to.

## Blue/green deployment

### Why

A fraud intervention mid-call is the worst thing a deploy can drop. Blue/green
brings the new build up _alongside_ the running one, proves it on its own
readiness check, and only then moves traffic. The old colour stays warm, so a
rollback is a second traffic flip rather than a cold rebuild.

```
   deploy v0.4.0
        │
        ├─ start app-green  ──── healthcheck /api/readyz ──── ✔
        │
        ├─ flip APP_UPSTREAM: app-blue → app-green, reload caddy
        │
        ├─ probe THROUGH caddy ─────────────────────────── ✔
        │
        └─ soak. then `promote` stops app-blue.
                                  any failure ⇒ rollback to a still-warm app-blue
```

### Usage

```bash
bun scripts/deploy.mjs deploy --image ghcr.io/<org>/securevoice-ai:v0.4.0
bun scripts/deploy.mjs status      # active colour, both containers, caddy probe
bun scripts/deploy.mjs rollback    # flip back to the previous colour
bun scripts/deploy.mjs promote     # stop the previous colour after a soak
```

or `bun run deploy` / `bun run deploy:status`.

### How the traffic actually moves

`Caddyfile` now reads:

```
reverse_proxy {$APP_UPSTREAM:app:3000}
```

`scripts/deploy.mjs` is the **only** writer of `APP_UPSTREAM` (recorded in
`.deploy/state.json`). Keeping a single writer is what makes `rollback` reliable —
a hand-edit racing the script is the failure mode worth designing out.

The `app:3000` default keeps a plain `docker compose up` working unchanged on a
single-colour stack, so this is opt-in.

### What it does NOT protect you from

**A bad database migration.** Code rolls back; a dropped column does not. Migrate
_before_ deploying, and prefer expand/contract so the previous build still works
against the new schema. `scripts/deploy.mjs` deliberately does not run migrations.

### Files

| File                           | Role                                                                  |
| ------------------------------ | --------------------------------------------------------------------- |
| `docker-compose.bluegreen.yml` | the two colour slots; healthcheck is `/api/readyz`, not `/api/health` |
| `scripts/deploy.mjs`           | the switch, health gating, rollback, promote                          |
| `Caddyfile`                    | `{$APP_UPSTREAM}` instead of a hardcoded service name                 |

## Terraform

Provisions the box `docs/DEPLOY.md` describes by hand: an **OVHcloud Public Cloud**
instance, the swap file a 4 GB Next build needs, and — the point of the whole
exercise — a security group that leaves only Caddy public.

```bash
cd terraform
terraform init
cp prod.tfvars.example prod.tfvars   # edit it
terraform plan  -var-file=prod.tfvars
terraform apply -var-file=prod.tfvars
```

### Why the firewall is the deliverable that matters

`src/proxy.ts` trusts `X-Forwarded-For` **only** when Caddy sets
`X-SecureVoice-Proxy: 1`. That guarantee is worthless if anything else can reach
the app: a stray published port lets a caller forge the marker header and poison
rate limiting and the audit trail. The test suite asserts the app never publishes
a port in compose — this asserts it at the _network_ layer, which no test can
reach.

`ovh_cloud_security_group` is an OpenStack **allow list**: traffic matching no
rule does not pass, on every interface. The previous Linode configuration said
`inbound_policy = "DROP"` and then listed what to accept, so an omitted rule was
covered by a deny policy standing behind it. OVHcloud has no such attribute, and
that difference is load-bearing the next time this file is edited:

- on Linode, adding a port meant adding a rule and the deny policy stayed behind
  it;
- here, one entry in `local.ingress_rules` opens a port to `0.0.0.0/0` and
  nothing re-closes it.

So the guarantee is not "a deny policy is set" — it is **"the list is short"**.
`local.open_ports` is therefore the single value both the security group and
`outputs.public_ports` read, so the docs cannot promise less than the box grants,
and `outputs.denied_ports_of_note` names 5432 (Postgres) and 9090 (realtime)
explicitly so a CI check can fail a future edit that opens them instead of leaving
it to review.

There is no private network by design. A vRack + subnet + gateway is a billed
resource per month, and it buys nothing this control does not already provide:
Postgres and the realtime socket service are unpublished because **no rule
admits their ports**, not because they sit on a private address. Binding them to
`127.0.0.1` inside the compose network is defence in depth, not the control.

### Guardrails, so a plan cannot quietly do the wrong thing

- `allow_ssh_from` **must** be non-empty — an empty or `0.0.0.0/0` list fails
  validation rather than opening 22 to the world.
- `allow_ssh_from_anywhere` defaults to `false`, and when set, `outputs` prints a
  loud warning: it is a bootstrap escape hatch, not a configuration.
- `region` must look like an OVHcloud region code (`GRA11`, `SBG5`, `BHS5`), so
  an AWS-style name like `me-central-1` fails validation with a readable message
  instead of an opaque 404 from the API.
- `flavor_name` must look like an OVH flavor (`d2-8`, `c2-7`), and is resolved to
  its per-region `flavor_id` through the catalog data source rather than
  hardcoded — so the config names a size and the region decides the SKU.
- `deploy_env` is constrained to `pilot|staging|prod`.
- `outputs.next_steps` prints an ordered checklist including the "turn SSH back
  off" reminder, because that is the step that gets forgotten.

### `user_data` is the sharp edge

The cloud-init payload reaches the instance as `user_data`, which the provider
documents as **write-only** and destructive to change. A modified value
**reinstalls the instance and wipes the root disk**, while Terraform reports a
successful in-place update — the instance id, ports and IPs all survive, so
nothing in the apply output says data was lost. Removing the argument does
nothing; setting it to `""` is a clear, and a clear reinstalls. Editing
`templates/cloud-init.yaml.tftpl` on a live box is a production data-loss event.
This is why `next_steps` repeats it on every run.

### Scope, stated honestly

Terraform provisions the **infrastructure**. It does not bootstrap the OS —
swap, Docker and log rotation stay manual per `docs/DEPLOY.md`, and
`outputs.next_steps` says so. That is a deliberate split: cloud-init only runs on
a boot that already has the config attached, so an automated version would either
be a no-op that silently never ran, or a rebuild of the box on every plan. A
visible manual step beats an invisible broken one.

The backend block is **not** declared. An empty `backend "s3" {}` makes
`terraform init` fail with `Missing Required Value` before anything is planned,
which reads like a broken module rather than an unconfigured backend. Add your own
per environment — remote state matters here, because local state on a deploy box
means a lost disk silently forgets the firewall rules it was supposed to create.

### Validated

```
$ terraform validate
Success! The configuration is valid.
```
