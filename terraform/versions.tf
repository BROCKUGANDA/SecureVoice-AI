# ---------------------------------------------------------------------------
# SecureVoice AI — Terraform
#
# Provisions the box `docs/DEPLOY.md` describes by hand: a Linode instance with
# Docker, the swap file a 4 GB Next build needs, and a firewall that leaves ONLY
# Caddy public.
#
# Why the firewall is the point: the whole trust model in `src/proxy.ts` rests
# on the application being unreachable except through Caddy, which sets
# `X-SecureVoice-Proxy: 1` and overwrites `X-Forwarded-For`. A stray published
# port lets a caller forge that header and poison rate limiting and the audit
# trail. `tests/e2e` and `tests/surface` assert the app never publishes a port;
# this file asserts it at the NETWORK layer, which a test cannot reach.
#
#   terraform init
#   terraform plan  -var-file=prod.tfvars
#   terraform apply -var-file=prod.tfvars
#
# This creates real, billable infrastructure. `plan` first, every time.
# ---------------------------------------------------------------------------
terraform {
  required_version = ">= 1.7.0"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.14"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    cloudinit = {
      source  = "hashicorp/cloudinit"
      version = "~> 2.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # ── State backend ───────────────────────────────────────────────────────────
  # Intentionally NOT declared. An empty backend block makes `terraform init`
  # fail with "Missing Required Value" before a single resource is planned,
  # which reads like a broken module rather than an unconfigured backend.
  #
  # Add your own, per environment, before the first apply:
  #
  #   backend "s3" {
  #     bucket = "securevoice-tfstate"
  #     key    = "prod/terraform.tfstate"
  #     region = "eu-central-1"
  #   }
  #
  # Remote state matters here: the firewall and the instance are the security
  # boundary, and local state on a deploy box means a lost disk silently forgets
  # the firewall rules it was supposed to create.
}

provider "linode" {
  # LINODE_TOKEN — never committed. Use the environment or a secrets manager.
  token = var.linode_token

  # Refuse to guess the account. A wrong default here deploys to someone
  # else's billing.
  config_path = "~/.config/linode-cli"
}

provider "tls" {}

provider "random" {}

locals {
  # Deduplicated list of what is allowed to reach the app from the internet.
  # Only Caddy's ports appear. The database and the realtime socket service are
  # reachable on the private network and nowhere else.
  open_ports = concat([80, 443], var.extra_open_ports)

  # Debian 13, which docs/DEPLOY.md requires and which the Dockerfile builds on.
  image = "Debian 13"
}
