# ---------------------------------------------------------------------------
# SecureVoice AI — Terraform (OVHcloud Public Cloud)
#
# Provisions the box `docs/DEPLOY.md` describes by hand: an OVHcloud Public
# Cloud instance running Debian, a swap file large enough for a Next build, and
# a security group that leaves ONLY Caddy public.
#
# ## Why the security group is the point
#
# The whole trust model in `src/proxy.ts` rests on the application being
# unreachable except through Caddy, which sets `X-SecureVoice-Proxy: 1` and
# overwrites `X-Forwarded-For`. A stray published port lets a caller forge that
# header and poison rate limiting and the audit trail. `tests/e2e` and
# `tests/surface` assert the app never publishes a port; this file asserts it at
# the NETWORK layer, which a test cannot reach.
#
# ## Default-deny is structural here, and it is worth being precise about why
#
# The previous Linode configuration said `inbound_policy = "DROP"` and then
# listed the ports to accept. OVHcloud has no such attribute: an OpenStack
# security group is an ALLOW list, and traffic that matches no rule does not
# pass. Listing only 80/443 (+22 under the conditions below) therefore produces
# the same wall — but it gets there by omission rather than by an explicit deny,
# so the guarantee is that the LIST IS SHORT, not that a deny policy is set.
#
# That difference matters when this file is edited. On Linode, adding a port
# meant adding a rule and the default-deny stayed behind it. Here, a single
# `local.ingress_rules` entry opens a port to `0.0.0.0/0` and nothing re-closes
# it. `outputs.public_ports` is asserted against that same list so the docs can
# never promise less than the box grants.
#
# ## Egress
#
# OpenStack attaches an allow-all egress rule to every new security group. It is
# NOT part of the managed `rule` set, so it never shows up as drift and cannot
# be removed through this file. The box needs egress to pull images and reach
# ElevenLabs, Twilio and Supabase; restricting it would mean enumerating vendor
# egress and would break on the first vendor change. A documented platform
# behaviour, not an oversight.
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
    ovh = {
      source  = "ovh/ovh"
      version = "~> 2.21"
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
  #     bucket     = "securevoice-tfstate"
  #     key        = "prod/terraform.tfstate"
  #     region     = "eu-west-1"
  #     encrypt    = true
  #     kms_key_id = null # or an alias for a customer-managed key
  #   }
  #
  # Remote state matters here: the security group is the security boundary, and
  # local state on a deploy box means a lost disk silently forgets the rules it
  # was supposed to create. Note that OVH credentials and the instance's
  # `user_data` are both sensitive — see the cloud-init warning in main.tf.
}

# ── OVHcloud credentials ─────────────────────────────────────────────────────
# `OVH_ENDPOINT` is the API target: "ovh-eu" for worldwide, "ovh-ca" for the
# Canadian endpoint. `OVH_CLIENT_ID` + `OVH_CLIENT_SECRET` are an application
# keypair from the OVHcloud token page, NOT the same credential as a VPS or
# dedicated-server API key. They are read from the environment when the
# arguments below are null, which keeps them out of tfvars as well as state.
provider "ovh" {
  endpoint = var.ovh_endpoint

  client_id     = var.ovh_client_id
  client_secret = var.ovh_client_secret
}

provider "tls" {}

provider "random" {}

locals {
  # Deduplicated list of what is allowed to reach the app from the internet.
  # Only Caddy's ports appear. The database and the realtime socket service are
  # denied by the ABSENCE of a rule, which is why they never need a subnet of
  # their own to stay unpublished.
  open_ports = distinct(concat([80, 443], var.extra_open_ports))

  # Debian 13, which docs/DEPLOY.md requires and which the Dockerfile builds on.
  image_name = "Debian 13"
}
