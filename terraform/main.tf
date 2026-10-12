# ---------------------------------------------------------------------------
# The box itself, the network edge, and the bootstrap that makes a bare Debian
# image into the host docs/DEPLOY.md assumes.
# ---------------------------------------------------------------------------

# ── SSH key material ─────────────────────────────────────────────────────────
# When none is supplied the provider creates one and writes the private half to
# disk, so `terraform output` can tell the operator where to look.
resource "tls_private_key" "deploy" {
  count     = var.ssh_public_key == null ? 1 : 0
  algorithm = "RSA" # 4096 is the default strength; ED25519 is not accepted by every image
}

locals {
  ssh_public_key = var.ssh_public_key != null ? var.ssh_public_key : tls_private_key.deploy[0].public_key_openssh
}

# OVHcloud takes the key as a NAMED resource attached at boot, not as an inline
# list the way Linode did. The name is stable so the instance does not see it
# change on every apply.
resource "ovh_cloud_ssh_key" "deploy" {
  service_name = var.service_name
  name         = "${var.name}-${var.deploy_env}-deploy"
  public_key   = local.ssh_public_key
}

# ── the network edge ─────────────────────────────────────────────────────────
# This is the resource that protects the trust model in src/proxy.ts.
#
# `rule` is a LIST ATTRIBUTE, not a block, so the whole allow-list is built as
# data in variables.tf and assigned here. An OpenStack security group permits
# only what it lists; a port with no matching rule does not pass. Building the
# list as data means `outputs.public_ports` can be derived from the SAME value
# the group uses — a divergence there would mean the docs promise less than the
# box grants.
resource "ovh_cloud_security_group" "app" {
  service_name = var.service_name
  region       = var.region
  name         = "${var.name}-${var.deploy_env}-edge"
  description  = "SecureVoice: Caddy only. Everything else is denied by absence."

  rule = local.ingress_rules
}

# ── catalogs ─────────────────────────────────────────────────────────────────
# `flavor_id` and `image_id` are opaque per-region UUIDs that change between
# regions and over time. Hardcoding them — as the checklist's `flavor_name`
# example invites — produces a config that works in exactly one region and
# fails with an opaque 404 everywhere else. Resolving by NAME through the
# catalog data sources means the config names an intent ("4 vCPU, 8 GB") and
# the region decides which SKU that is.
data "ovh_cloud_instance_flavors" "catalog" {
  service_name = var.service_name
  region       = var.region
}

data "ovh_cloud_instance_images" "catalog" {
  service_name = var.service_name
  region       = var.region
}

locals {
  flavor_id = one([
    for f in data.ovh_cloud_instance_flavors.catalog.flavors : f.id
    if f.name == var.flavor_name
  ])

  image_id = one([
    for i in data.ovh_cloud_instance_images.catalog.images : i.id
    if i.name == local.image_name
  ])
}

# ── the instance ─────────────────────────────────────────────────────────────
resource "ovh_cloud_instance" "app" {
  service_name       = var.service_name
  region             = var.region
  name               = "${var.name}-${var.deploy_env}"
  flavor_id          = local.flavor_id
  image_id           = local.image_id
  ssh_key_name       = ovh_cloud_ssh_key.deploy.name
  security_group_ids = [ovh_cloud_security_group.app.id]

  # A single Ext-Net interface. There is no private network here on purpose: a
  # vRack + subnet + gateway costs an extra billed resource per month, and it
  # buys nothing that the security group does not already guarantee. Postgres and
  # the realtime socket service are unpublished because NO RULE admits 5432 or
  # 9090 from anywhere — not because they sit on a private address. Binding them
  # to a private address is defence in depth, not the control itself, and
  # variables.tf says so.
  networks = [
    { auto_assign_public_ip = true },
  ]

  # ── cloud-init: runs ONCE at first boot ──────────────────────────────────
  # The box does not depend on this state file staying around to finish setting
  # itself up.
  #
  # ## WARNING — this argument is a loaded weapon
  #
  # `user_data` is WRITE-ONLY: the API accepts it and never returns it, so
  # Terraform state holds the only copy and a change made in the control panel
  # stays invisible to the next plan. More importantly, how it MOVES decides
  # what happens to the disk:
  #
  #   · changed to a different non-empty value → the API REBUILDS the instance
  #     and WIPES the root disk. The instance id, ports and IPs survive, so
  #     Terraform reports a successful in-place update while the deployed
  #     database on that box is gone.
  #   · set to `""`            → the same reinstall. `""` is a CLEAR, not an absence.
  #   · REMOVED from the config → the key is left out of the PUT, nothing happens
  #     server-side, and the instance keeps the user data it booted with.
  #
  # So editing the cloud-init template below is a production data-loss event on
  # an existing box. Change it on a fresh instance, or accept the rebuild.
  user_data = base64encode(local.cloud_init)

  # NOTE: there is deliberately no `timeouts {}` block. The provider documents
  # that this resource offers none, and that create/update/delete each poll the
  # API for up to 60 minutes with no way to shorten or extend that from here.
  # Adding the block is a hard error ("Blocks of type \"timeouts\" are not
  # expected here"), not a silently ignored setting.

  depends_on = [ovh_cloud_security_group.app]
}

# ── bootstrap ────────────────────────────────────────────────────────────────
locals {
  cloud_init = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    hostname         = "${var.name}-${var.deploy_env}"
    deploy_env       = var.deploy_env
    swap_size_mb     = var.swap_size_mb
    extra_packages   = join(" ", var.bootstrap_packages)
    app_directory    = var.app_directory
    postgres_version = var.postgres_major_version
  })
}

# A root password is generated because some OVHcloud images and the recovery
# console expect one. It is NOT a login path: SSH keys are the only intended
# route in, and this value exists so `console access` is never a standing
# invitation. Marked random rather than derived so it can never be guessed from
# the instance name.
resource "random_password" "root" {
  length           = 64
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
  min_lower        = 16
  min_upper        = 16
  min_numeric      = 16
  min_special      = 8
}

# ── backups ──────────────────────────────────────────────────────────────────
# Off by default and, unlike the Linode version, not merely defaulted: a fraud
# case database is PII-bearing, so where its backups physically live is a legal
# decision about data residency, not a boolean someone forgot to flip. Setting
# `enable_backups` provisions snapshot volumes in THIS region — which is the
# only place this configuration can put them.
resource "ovh_cloud_storage_block_volume" "backup" {
  count = var.enable_backups ? 1 : 0

  service_name = var.service_name
  region       = var.region
  name         = "${var.name}-${var.deploy_env}-backup"
  size         = var.backup_volume_gb * 10
  volume_type  = "CLASSIC"

  depends_on = [ovh_cloud_instance.app]
}
