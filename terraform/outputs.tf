# ---------------------------------------------------------------------------
# Outputs. What the operator needs on the first `apply`, and what CI needs to
# check the deployment actually matches the plan.
# ---------------------------------------------------------------------------

locals {
  # The public interface is the one network entry with no `network_id` — the
  # per-attributes note on `current_state.networks` says the public (Ext-Net)
  # interface is the single observed entry with no id. Private interfaces always
  # carry one.
  public_interface = [for n in ovh_cloud_instance.app.current_state.networks : n if n.id == null]

  public_addresses = flatten([for n in local.public_interface : n.addresses])

  # Selected by the presence of dots rather than by a `version` field, because
  # the provider has typed that field as both number and string across versions
  # and a filter on it fails at plan time on the wrong one. An IPv4 literal has
  # dots; an IPv6 one does not.
  public_ipv4 = try([for a in local.public_addresses : a.ip if strcontains(a.ip, ".")][0], null)

  public_ipv6 = [for a in local.public_addresses : a.ip if !strcontains(a.ip, ".")]
}

output "instance_id" {
  description = "OVHcloud instance id."
  value       = ovh_cloud_instance.app.id
}

output "instance_name" {
  description = "Instance name, which is also its hostname inside OVHcloud."
  value       = ovh_cloud_instance.app.name
}

output "public_ipv4" {
  description = "Public address. Point DNS A/AAAA here, then run docs/DEPLOY.md. Null until the first apply has settled."
  value       = local.public_ipv4
}

output "public_ipv6" {
  description = "Public IPv6 addresses on the same interface, if the project has any."
  value       = local.public_ipv6
}

output "private_ipv4" {
  description = <<-EOT
    Always empty.

    The Linode configuration reported a private address here and told the
    operator that Postgres and the realtime service lived on it. This deployment
    provisions no private network, so there is no private address and nothing to
    bind to.

    That is not a regression. Postgres and the realtime socket service are
    unpublished here because the security group contains NO RULE admitting 5432
    or 9090 — OpenStack drops traffic that matches no rule, on every interface.
    Binding them to 127.0.0.1 inside the compose network is defence in depth; the
    security group is the control.
  EOT
  value       = []
}

output "ssh_command" {
  description = "Ready-to-paste SSH command for the operator."
  value       = "ssh root@${coalesce(local.public_ipv4, "<public-ip-pending>")}"
}

output "security_group_id" {
  description = "Security group id, for auditing which ports are open."
  value       = ovh_cloud_security_group.app.id
}

output "public_ports" {
  description = "Ports reachable from the internet. Should be 80 and 443, plus 22 only while allow_ssh_from_anywhere is true."
  value       = local.open_ports
}

output "ssh_is_open_to_world" {
  description = "True means 22 is reachable from anywhere — a deployment-stopper. Flip allow_ssh_from_anywhere to false once a key is installed."
  value       = var.allow_ssh_from_anywhere
}

output "denied_ports_of_note" {
  description = <<-EOT
    Ports this deployment deliberately does NOT admit, with the reason. CI can
    assert that none of them ever appears in public_ports — a future edit that
    opens 5432 should fail a check, not pass review.
  EOT
  value = {
    "5432" = "PostgreSQL — unpublished by the absence of any rule"
    "9090" = "realtime socket service — unpublished by the absence of any rule"
  }
}

output "swap_enabled" {
  description = "Whether the swap file was provisioned by cloud-init. False on a flavor large enough not to need it."
  value       = var.swap_size_mb > 0
}

output "flavor" {
  description = "The flavor actually resolved, as the catalog reports it. CI can assert the box really has the vCPU/RAM the plan asked for."
  value = {
    id     = local.flavor_id
    name   = try(ovh_cloud_instance.app.current_state.flavor.name, null)
    vcpus  = try(ovh_cloud_instance.app.current_state.flavor.vcpus, null)
    ram_mb = try(ovh_cloud_instance.app.current_state.flavor.ram, null)
    disk   = try(ovh_cloud_instance.app.current_state.flavor.disk, null)
  }
}

output "next_steps" {
  description = "Ordered checklist for the operator after apply."
  value = join("\n", compact([
    "1. ssh root@${coalesce(local.public_ipv4, "<public-ip-pending>")}",
    var.allow_ssh_from_anywhere ? "2. IMMEDIATE: turn OFF allow_ssh_from_anywhere and re-apply — SSH is open to the internet." : "2. SSH is already restricted to allow_ssh_from.",
    "3. Verify the swap file cloud-init created: free -h | grep Swap. ${var.swap_size_mb > 0 ? "Expect ${var.swap_size_mb} MB." : "None requested; confirm the flavor is large enough not to need one."}",
    "4. git clone the repo to ${var.app_directory} and copy .env.example -> .env; set DATABASE_URL, BETTER_AUTH_SECRET (>=32 chars), POSTGRES_PASSWORD.",
    "5. bunx prisma migrate deploy",
    "6. Point DNS at ${coalesce(local.public_ipv4, "<public-ip-pending>")} (Caddy obtains the certificate on first boot).",
    "7. docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml up -d --build",
    "8. bun scripts/deploy.mjs status",
    "",
    "REMINDER: user_data is write-only. Editing templates/cloud-init.yaml.tftpl and",
    "re-applying REBUILDS the instance and WIPES the root disk. See the warning in main.tf.",
  ]))
}
