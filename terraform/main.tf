# ---------------------------------------------------------------------------
# The box itself, the network edge, and the bootstrap that makes a bare Debian
# image into the host docs/DEPLOY.md assumes.
# ---------------------------------------------------------------------------

# SSH key material. When none is supplied the provider creates one and writes the
# private half to disk, so `terraform output` can tell the operator where to look.
resource "tls_private_key" "deploy" {
  count     = var.ssh_public_key == null ? 1 : 0
  algorithm = "RSA" # 4096 is the default strength; ED25519 is not accepted by every Linode rescue image
}

locals {
  ssh_public_key      = var.ssh_public_key != null ? var.ssh_public_key : tls_private_key.deploy[0].public_key_openssh
  ssh_private_key_pem = var.ssh_public_key == null ? tls_private_key.deploy[0].private_key_openssh : null
}

# ── the instance ─────────────────────────────────────────────────────────────
resource "linode_instance" "app" {
  label           = "${var.name}-${var.deploy_env}"
  region          = var.region
  type            = var.instance_type
  image           = local.image
  authorized_keys = [local.ssh_public_key]
  booted          = true
  private_ip      = true # the app and Postgres talk over this, never the public one
  tags            = var.tags
  root_pass       = random_password.root.result

}

resource "linode_instance_disk" "boot" {
  label      = linode_instance.app.label
  size       = var.disk_size_mb
  linode_id  = linode_instance.app.id
  filesystem = "ext4"
}

# A root password is generated because Linode requires one; it is NOT a login
# path anyone should use, and it is marked random rather than derived so it can
# never be guessed from the label. SSH keys are the only intended route in.
resource "random_password" "root" {
  length           = 64
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
  min_lower        = 16
  min_upper        = 16
  min_numeric      = 16
  min_special      = 8
}

locals {
  # The private address, separated from the public one. Postgres and the realtime
  # service bind here and nothing else, so this is never published. Derived
  # rather than indexed because the provider exposes the addresses as a SET.
  private_ipv4 = element(
    [for ip in linode_instance.app.ipv4 : ip if tonumber(split(".", ip)[0]) == 10],
    0,
  )

  # Every ingress rule, merged into one list so the firewall resource carries a
  # single `dynamic "inbound"`. Kept as data (not inline blocks) so
  # `outputs.public_ports` is asserted against the SAME list the firewall uses
  # — a divergence there would mean the docs promise less than the box grants.
  ingress_rules = concat(
    [for p in local.open_ports : {
      label       = "ingress-${p}"
      description = "Public ingress on ${p}."
      ipv4        = ["0.0.0.0/0"]
      ipv6        = ["::/0"]
      port        = p
    }],
    var.allow_ssh_from_anywhere ? [{
      label       = "ingress-ssh-anywhere"
      description = "SSH from anywhere — TEMPORARY bootstrap only."
      ipv4        = ["0.0.0.0/0"]
      ipv6        = ["::/0"]
      port        = 22
    }] : [],
    [for cidr in var.allow_ssh_from : {
      label       = "ingress-ssh-${replace(cidr, "/", "-")}"
      description = "SSH from ${cidr}."
      ipv4        = [cidr]
      ipv6        = []
      port        = 22
    }],
  )
}

# ── the network edge ─────────────────────────────────────────────────────────
# This is the resource that protects the trust model in src/proxy.ts.
resource "linode_firewall" "app" {
  label = "${var.name}-${var.deploy_env}-edge"
  tags  = var.tags

  # Default-deny inbound, allow egress. Linode firewalls default to ACCEPT, so
  # an omitted rule is a hole rather than a wall.
  inbound_policy  = "DROP"
  outbound_policy = "ACCEPT"

  # `inbound` is a LIST block carrying `ipv4`/`ipv6` LISTS (not a `rule` block
  # with `addresses`) — that is the provider v2 shape, and the difference is
  # load-bearing: a rule that set only `ipv4` would leave ::/0 open.
  dynamic "inbound" {
    for_each = local.ingress_rules
    content {
      label       = inbound.value.label
      description = inbound.value.description
      action      = "ACCEPT"
      protocol    = "TCP"
      ports       = tostring(inbound.value.port)
      ipv4        = inbound.value.ipv4
      ipv6        = inbound.value.ipv6
    }
  }
}

# Egress is unrestricted: the box pulls images and reaches ElevenLabs, Twilio
# and Supabase. Restricting it means enumerating vendor egress and breaks on the
# first vendor change — a documented decision, not an oversight.

resource "linode_firewall_device" "app" {
  entity_id   = linode_instance.app.id
  firewall_id = linode_firewall.app.id
}
# Egress is unrestricted: the box needs to pull images and reach ElevenLabs,
# Twilio and Supabase. Restricting it would mean enumerating vendor egress and
# would break on the first vendor change, so it is a documented decision rather
# than an oversight.

# ── bootstrap ────────────────────────────────────────────────────────────────
# cloud-init is the right tool here: it runs ONCE at first boot, so the box does
# not depend on this Terraform state file staying around to finish setting up.
