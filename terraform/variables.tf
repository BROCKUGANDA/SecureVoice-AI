# ---------------------------------------------------------------------------
# Inputs. Everything that differs between the pilot box and production is a
# variable, so one module serves both.
# ---------------------------------------------------------------------------

variable "linode_token" {
  description = "Linode API token. Read from LINODE_TOKEN; never commit it."
  type        = string
  sensitive   = true
  default     = null
}

variable "name" {
  description = "Prefix for every resource, so a pilot and a production box are distinguishable in the console."
  type        = string
  default     = "securevoice"
}

variable "region" {
  description = <<-EOT
    Linode region. Pick the one closest to where calls are answered: the tool
    round-trips are in the voice path, and transatlantic latency is audible.
    Docs currently deploy to Frankfurt (de).
  EOT
  type        = string
  default     = "de"
}

variable "instance_type" {
  description = <<-EOT
    Linode plan slug. docs/DEPLOY.md says 2 vCPU / 4 GB minimum and notes that a
    Next build needs swap on 4 GB. The current deployment is 8 GB (g6-nanode-2).
  EOT
  type        = string
  default     = "g6-standard-2"

  validation {
    condition     = can(regex("^g6-", var.instance_type))
    error_message = "instance_type must be a Linode g6 plan slug, e.g. g6-standard-2."
  }
}

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

variable "ssh_public_key" {
  description = "Public key installed as the only permitted login. The provider's default key is used when null."
  type        = string
  default     = null
  nullable    = true
}

variable "extra_open_ports" {
  description = "Additional ports to expose. Empty by default: the app publishes none, and every entry here widens the network edge."
  type        = list(number)
  default     = []
}

variable "swap_size_mb" {
  description = <<-EOT
    Swap file size. docs/DEPLOY.md prescribes 2G because `next build` OOMs on a
    4 GB box without it. 0 disables the swap file, which is only correct on a
    machine already at 8 GB or more.
  EOT
  type        = number
  default     = 2048
}

variable "enable_backups" {
  description = "Linode automated backups. Off by default: a fraud case database is PII-bearing, so where backups live is a decision, not a default."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to the instance."
  type        = list(string)
  default     = ["securevoice", "terraform"]
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

variable "disk_size_mb" {
  description = "Boot disk. 81920 is the smallest size that holds Docker images for two colours plus Postgres."
  type        = number
  default     = 81920
}
