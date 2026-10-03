# ---------------------------------------------------------------------------
# Outputs. What the operator needs on the first `apply`, and what CI needs to
# check the deployment actually matches the plan.
# ---------------------------------------------------------------------------

output "instance_id" {
  description = "Linode instance id."
  value       = linode_instance.app.id
}

output "label" {
  description = "Instance label, which is also its hostname on the Linode network."
  value       = linode_instance.app.label
}

output "public_ipv4" {
  description = "Public address. Point DNS A/AAAA here, then run docs/DEPLOY.md."
  value       = one(linode_instance.app.ipv4)
}

output "private_ipv4" {
  description = "Private address. Postgres and the realtime service live here and are never published."
  value       = local.private_ipv4
}

output "ssh_command" {
  description = "Ready-to-paste SSH command for the operator."
  value       = "ssh root@${one(linode_instance.app.ipv4)}"
}

output "firewall_id" {
  description = "Firewall id, for auditing which ports are open."
  value       = linode_firewall.app.id
}

output "public_ports" {
  description = "Ports reachable from the internet. Should be 80 and 443, plus 22 only while allow_ssh_from_anywhere is true."
  value       = local.open_ports
}

output "ssh_is_open_to_world" {
  description = "True means 22 is reachable from anywhere — a deployment-stopper. Flip allow_ssh_from_anywhere to false once a key is installed."
  value       = var.allow_ssh_from_anywhere
}

output "swap_enabled" {
  description = "Whether the swap file was provisioned. False on a box small enough not to need it."
  value       = var.swap_size_mb > 0
}

output "next_steps" {
  description = "Ordered checklist for the operator after apply."
  value = join("\n", compact([
    "1. ssh root@${one(linode_instance.app.ipv4)}",
    var.allow_ssh_from_anywhere ? "2. IMMEDIATE: turn OFF allow_ssh_from_anywhere and re-apply — SSH is open to the internet." : "2. Install your SSH key (already configured if you passed ssh_public_key).",
    "3. git clone the repo to /opt/securevoice and copy .env.example -> .env; set DATABASE_URL, BETTER_AUTH_SECRET (>=32 chars), POSTGRES_PASSWORD.",
    "4. Create the 2G swap file (docs/DEPLOY.md §1) and install Docker — Terraform does not do the OS bootstrap, deliberately.",
    "5. bunx prisma migrate deploy",
    "6. Point DNS at ${one(linode_instance.app.ipv4)} (Caddy obtains the certificate on first boot).",
    "7. docker compose -f docker-compose.yml -f docker-compose.bluegreen.yml up -d --build",
    "8. bun scripts/deploy.mjs status",
  ]))
}
