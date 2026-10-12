# ---------------------------------------------------------------------------
# Inputs. Everything that differs between the pilot box and production is a
# variable, so one module serves both.
# ---------------------------------------------------------------------------

# ── credentials ──────────────────────────────────────────────────────────────
# These default to null so the OVH_ENDPOINT / OVH_CLIENT_ID / OVH_CLIENT_SECRET
# environment variables are used instead. That keeps the secret out of tfvars as
# well as out of the file; it is still written to state, which is the reason the
# backend note in versions.tf asks for encryption.
variable "ovh_endpoint" {
  description = "OVHcloud API endpoint: ovh-eu (worldwide) or ovh-ca (Canada). Null uses OVH_ENDPOINT."
  type        = string
  default     = null
}

variable "ovh_client_id" {
  description = "OVHcloud application key CLIENT_ID. Null uses OVH_CLIENT_ID. Never commit it."
  type        = string
  sensitive   = true
  default     = null
}

variable "ovh_client_secret" {
  description = "OVHcloud application key CLIENT_SECRET. Null uses OVH_CLIENT_SECRET. Never commit it."
  type        = string
  sensitive   = true
  default     = null
}

variable "service_name" {
  description = <<-EOT
    The Public Cloud PROJECT id this box belongs to, e.g. "wwwwwwwwwwwwwwww".

    This is a project, not a subscription: a project owns instances, security
    groups and volumes together, and every resource below is addressed through
    it. Creating the project itself is a one-time act in the OVHcloud control
    panel — it is not managed here, because a project cannot be moved between
    accounts once resources exist and a destroy would take the database with it.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{16,32}$", var.service_name))
    error_message = "service_name must be the OVHcloud Public Cloud project id (16-32 lowercase alphanumerics). Find it in the control panel under Public Cloud > Projects, or via `ovh_cloud_project` in the API."
  }
}

# ── identity ─────────────────────────────────────────────────────────────────
variable "name" {
  description = "Prefix for every resource, so a pilot and a production box are distinguishable in the control panel."
  type        = string
  default     = "securevoice"
}

variable "deploy_env" {
  description = "Environment label exported to the instance for the app to read (pilot | staging | prod)."
  type        = string
  default     = "pilot"

  validation {
    condition     = contains(["pilot", "staging", "prod"], var.deploy_env)
    error_message = "deploy_env must be one of: pilot, staging, prod."
  }
}

# ── placement and size ───────────────────────────────────────────────────────
variable "region" {
  description = <<-EOT
    OVHcloud region code, e.g. GRA11 (Gravelines), GRA9, SBG5 (Strasbourg),
    BHS5 (Beauharnois), or WBG1 (Warsaw).

    Pick the one closest to where calls are answered: the tool round-trips are in
    the voice path, and transatlantic latency is audible. This is NOT an AWS-style
    region name — "me-central-1" is not an OVHcloud region and will fail with an
    opaque error.

    Note for data residency: the Middle East is served from WBG1 (Warsaw) or
    GRA, not from an in-country facility. A deployment that must promise in-region
    hosting for PDPL has to confirm the actual data path with OVHcloud rather
    than reading a region code — see docs/INFRASTRUCTURE.md.
  EOT
  type        = string
  default     = "GRA11"

  validation {
    condition     = can(regex("^[A-Z]{2,3}[0-9]+$", var.region))
    error_message = "region must be an OVHcloud region code like GRA11, SBG5 or BHS5 — not an AWS region name."
  }
}

variable "flavor_name" {
  description = <<-EOT
    OVHcloud flavor NAME, resolved to its per-region id through the catalog data
    source. docs/DEPLOY.md says 2 vCPU / 4 GB minimum and notes that a Next build
    needs swap at 4 GB.

    Naming convention is <class>-<vcpus>-<ram_gb>:
      d2-4  general purpose, 2 dedicated vCPU, 4 GB  — the documented minimum
      d2-8  general purpose, 2 dedicated vCPU, 8 GB  — the size the reference
            deployment ran at, and the one to prefer
      c2-7  general purpose, 2 shared vCPU, 7 GB     — cheaper, noisier neighbours
      b2-7  discovery, 2 shared vCPU, 7 GB           — will NOT hold a production build

    Availability differs per region. A name that exists in GRA11 may not exist in
    your chosen region; `terraform plan` fails with the catalog listing, which is
    the intended way to discover that.
  EOT
  type        = string
  default     = "d2-8"

  validation {
    condition     = can(regex("^[a-z][0-9]+-[0-9]+$", var.flavor_name))
    error_message = "flavor_name must be an OVHcloud flavor name like d2-8, not an instance type slug or a size."
  }
}

# ── the network edge ─────────────────────────────────────────────────────────
variable "allow_ssh_from" {
  description = <<-EOT
    CIDRs permitted to reach SSH. RESTRICT THIS — an open 22 is the single most
    common way a deploy box is compromised. Accepts a list.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.allow_ssh_from) > 0
    error_message = "allow_ssh_from must list at least one CIDR. An empty or 0.0.0.0/0 entry is not acceptable for a box holding production credentials."
  }
}

variable "allow_ssh_from_anywhere" {
  description = <<-EOT
    Escape hatch for a first boot with no known IP. Deliberately OFF by default:
    it opens 22 to the internet, so the deployment prints a warning and the
    docs say to turn it off once the SSH key is installed.
  EOT
  type        = bool
  default     = false
}

variable "extra_open_ports" {
  description = <<-EOT
    Additional ports to expose. Empty by default: the app publishes none, and
    every entry here widens the network edge.

    On this provider there is no separate deny policy behind this list — the
    security group permits what it lists and nothing else — so each entry here is
    a direct grant from the internet.
  EOT
  type        = list(number)
  default     = []
}

locals {
  # Every ingress rule, merged into one list assigned to `ovh_cloud_security_group.rule`.
  # Kept as data rather than inline blocks so `outputs.public_ports` is asserted
  # against the SAME list the group uses.
  ingress_rules = concat(
    [for p in local.open_ports : {
      direction        = "INGRESS"
      ethernet_type    = "IPV4"
      protocol         = "TCP"
      port_range_min   = p
      port_range_max   = p
      remote_ip_prefix = "0.0.0.0/0"
      description      = "Public ingress on ${p}."
    }],
    var.allow_ssh_from_anywhere ? [{
      direction        = "INGRESS"
      ethernet_type    = "IPV4"
      protocol         = "TCP"
      port_range_min   = 22
      port_range_max   = 22
      remote_ip_prefix = "0.0.0.0/0"
      description      = "SSH from anywhere - TEMPORARY bootstrap only."
    }] : [],
    [for cidr in var.allow_ssh_from : {
      direction        = "INGRESS"
      ethernet_type    = "IPV4"
      protocol         = "TCP"
      port_range_min   = 22
      port_range_max   = 22
      remote_ip_prefix = cidr
      description      = "SSH from ${cidr}."
    }],
  )
}

# ── bootstrap ────────────────────────────────────────────────────────────────
variable "ssh_public_key" {
  description = "Public key installed as the only permitted login. A generated RSA key is used when null."
  type        = string
  default     = null
  nullable    = true
}

variable "swap_size_mb" {
  description = <<-EOT
    Swap file size. docs/DEPLOY.md prescribes 2G because `next build` OOMs on a
    4 GB box without it. 0 disables the swap file, which is only correct on a
    flavor at 8 GB or more.
  EOT
  type        = number
  default     = 2048
}

variable "bootstrap_packages" {
  description = <<-EOT
    Extra apt packages installed by cloud-init, beyond the base set. Empty by
    default; every entry lengthens the boot and widens the image.
  EOT
  type        = list(string)
  default     = []
}

variable "app_directory" {
  description = "Directory docs/DEPLOY.md clones the repository into."
  type        = string
  default     = "/opt/securevoice"
}

variable "postgres_major_version" {
  description = "PostgreSQL major version to install for the database container."
  type        = number
  default     = 17

  validation {
    condition     = contains([15, 16, 17], var.postgres_major_version)
    error_message = "postgres_major_version must be 15, 16 or 17 — the versions docker-compose.yml has been exercised against."
  }
}

# ── backups ──────────────────────────────────────────────────────────────────
variable "enable_backups" {
  description = <<-EOT
    Provision a backup volume. Off by default: a fraud case database is PII-bearing,
    so where backups live is a decision, not a default. When enabled the volume is
    created in THIS region, which is the only place this configuration can put it.
  EOT
  type        = bool
  default     = false
}

variable "backup_volume_gb" {
  description = "Backup volume size in GB × 10 (the provider bills in 10 GB units)."
  type        = number
  default     = 100
}

# ── removed from the Linode configuration ────────────────────────────────────
# `linode_token`      — replaced by ovh_client_id / ovh_client_secret.
# `instance_type`     — replaced by flavor_name. The Linode slug (g6-standard-2)
#                       carried its vCPU/RAM in an opaque string; the OVH catalog
#                       is queryable, so the config names the size instead.
# `disk_size_mb`      — a Linode disk attached to a running instance. OVHcloud
#                       flavors carry a local root disk sized by the flavor, and
#                       additional storage is a block volume (see enable_backups).
# `tags`              — Linode-only metadata. OVHcloud labels this box by `name`
#                       and groups resources by the project.
