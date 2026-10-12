# sites.d — host-local Caddy site blocks

The tracked `Caddyfile` ends with `import sites.d/*.caddy`. Anything in this
directory ending in `.caddy` is a **complete site block** served by the same
edge, on whichever machine the stack runs. Only this README is tracked —
`.gitignore` keeps everything else out of the repo, because these files
describe one physical host, not the product.

This exists so the tracked `Caddyfile` can stay byte-identical everywhere.
The shared production box also fronts `crucible.svalley.tech` (another
project); that block lives here on the box, not in the repo. The previous
arrangement — box-local blocks inline in a skip-worktree'd copy of the
Caddyfile — made every promoted change to the Caddyfile refuse to pull until
an operator merged by hand (`docs/VPS-RECOVERY.md`, failure mode #2).

## Adding a host

```bash
ssh <box>
cd ~/securevoice-ai
cat > sites.d/<host>.caddy <<'EOF'
<host> {
    import site
}
EOF
docker compose up -d --force-recreate caddy
```

Notes, each measured against `caddy:2-alpine`:

- `import site` works from here: `(site)` is defined in the parent Caddyfile
  and snippets are global once defined.
- The wildcard import matching **zero** files is valid — this directory may
  contain just this README and Caddy starts clean.
- Relative imports resolve against the importing file's directory, so the
  container sees `/etc/caddy/sites.d/*.caddy` (mounted read-only by
  `docker-compose.yml`).
- Editing a file here needs a **process restart** — `admin off` means there is
  no reload endpoint. Do not `caddy reload`.
- Live TLS via ACME only works if the hostname's DNS record is **DNS-only**
  (grey cloud). Under the Cloudflare proxy the HTTP-01 challenge never reaches
  the origin — see the TLS note in `Caddyfile`.
- Files must be world-readable (the caddy container runs as uid 1000).
