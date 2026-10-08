#requires -Version 5.1
<#
.SYNOPSIS
  Creates the SecureVoice Northflank stack (caddy edge / app / realtime).

  Reads NORTHFLANK_TOKEN from the environment and app secrets from ./.env.
  Never prints secret values. Idempotent: skips services that already exist.

  Usage:
    $env:NORTHFLANK_TOKEN = "nf-…"
    powershell scripts/nf-create-services.ps1
#>
$ErrorActionPreference = "Stop"
$token = $env:NORTHFLANK_TOKEN
if (-not $token) { throw "Set NORTHFLANK_TOKEN first." }
$H = @{ Authorization = "Bearer $token" }
# Env-overridable so re-pointing the stack (new project, new account, new region)
# is config, not a script edit.
$API = if ($env:NORTHFLANK_API) { $env:NORTHFLANK_API } else { "https://api.northflank.com/v1" }
$PROJECT = if ($env:NORTHFLANK_PROJECT) { $env:NORTHFLANK_PROJECT } else { "securevoice-ai" }

function Invoke-NF($method, $path, $body = $null) {
  $json = $null
  if ($null -ne $body) { $json = $body | ConvertTo-Json -Depth 12 }
  try {
    if ($json) { return Invoke-RestMethod -Method $method -Uri "$API$path" -Headers $H -ContentType "application/json" -Body $json }
    return Invoke-RestMethod -Method $method -Uri "$API$path" -Headers $H
  } catch {
    $msg = $_.ErrorDetails.Message
    if ($msg -and $msg -match '"status":409' -and $msg -match 'already exists') { return @{ _exists = $true } }
    throw "$method $path failed: $msg"
  }
}

# ---- read .env without echoing anything ----
$envMap = @{}
Get-Content .env | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_ -split '=', 2
  $envMap[$k.Trim()] = $v.Trim().Trim('"')
}

# DATABASE_URL: direct Supabase host is IPv6-only — use the IPv4 transaction
# pooler for the runtime (session pooler :5432 is only for migrations).
$direct = [uri]$envMap["DATABASE_URL"]
$pw = $direct.UserInfo.Split(":")[1]
$ref = $direct.Host.Split(".")[1]
$poolerRegion = if ($envMap["SUPABASE_POOLER_REGION"]) { $envMap["SUPABASE_POOLER_REGION"] } else { "aws-0-eu-central-1" }
$pooler = "postgresql://postgres.${ref}:$pw@${poolerRegion}.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

$gitUrl = if ($env:NF_GIT_URL) { $env:NF_GIT_URL } else { "https://github.com/BROCKUGANDA/SecureVoice-AI" }
$gitAccount = if ($env:NF_GIT_ACCOUNT) { $env:NF_GIT_ACCOUNT } else { "BROCKUGANDA" }
$vcs = @{ projectUrl = $gitUrl; projectType = "github"; accountLogin = $gitAccount; projectBranch = "main" }

function New-Service($name, $spec) {
  try {
    $existing = Invoke-RestMethod -Method Get -Uri "$API/projects/$PROJECT/services/$name" -Headers $H
    if ($existing.data) { "SKIP $name (exists)"; return }
  } catch {
    # 404 = does not exist yet — proceed to create.
  }
  $null = Invoke-NF Post "/projects/$PROJECT/services/combined" $spec
  "CREATE $name"
}

# ---- caddy: the ONLY public ingress ----
New-Service "caddy" @{
  name = "caddy"; description = "Single public ingress (LB terminates TLS)"
  billing = @{ deploymentPlan = "nf-compute-20" }
  deployment = @{ instances = 1; docker = @{ configType = "default" }; storage = @{ ephemeralStorage = @{ storageSize = 1024 } } }
  ports = @(@{ name = "http"; internalPort = 80; public = $true; vpcAccessible = $false; protocol = "HTTP" })
  buildSource = "git"; vcsData = $vcs
  buildSettings = @{ dockerfile = @{ buildEngine = "buildkit"; dockerFilePath = "/Dockerfile.caddy"; dockerWorkDir = "/" } }
  healthChecks = @(@{ protocol = "HTTP"; type = "readinessProbe"; path = "/healthz"; port = 80; initialDelaySeconds = 10; periodSeconds = 30; timeoutSeconds = 5; failureThreshold = 3; successThreshold = 1 })
}

# ---- app: private Next.js standalone ----
$appEnv = @{
  DATABASE_URL = $pooler; HOSTNAME = "0.0.0.0"; NEXT_TELEMETRY_DISABLED = "1"
  REALTIME_URL = "http://realtime:4000"; DEPLOY_REGION = "northflank-eu-west"
}
foreach ($k in @(
  "AUTH_SECRET","WEBHOOK_SECRET","REALTIME_INGEST_SECRET","REALTIME_ALLOWED_ORIGIN",
  "BETTER_AUTH_SECRET","BETTER_AUTH_API_KEY",
  "ELEVENLABS_API_KEY","ELEVENLABS_DRY_RUN","ELEVENLABS_MODEL","ELEVENLABS_STT_MODEL",
  "ELEVENLABS_AGENT_ID","ELEVENLABS_PHONE_NUMBER_ID",
  "ELEVENLABS_VOICE_EN","ELEVENLABS_VOICE_AR","ELEVENLABS_VOICE_HI","ELEVENLABS_VOICE_UR","ELEVENLABS_VOICE_FR","ELEVENLABS_VOICE_SW",
  "TWILIO_ACCOUNT_SID","TWILIO_API_KEY_SID","TWILIO_API_KEY_SECRET","TWILIO_AUTH_TOKEN","TWILIO_FROM_NUMBER",
  "GROQ_API_KEY","GROQ_MODEL","GEMINI_API_KEY","GEMINI_MODEL","DEEPGRAM_API_KEY",
  "AGENT_TOOL_SECRET","AGENT_TOOL_ALLOWED","SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY"
)) { if ($envMap[$k]) { $appEnv[$k] = $envMap[$k] } }

New-Service "app" @{
  name = "app"; description = "Next.js standalone API + console (private)"
  billing = @{ deploymentPlan = "nf-compute-50" }
  deployment = @{ instances = 1; docker = @{ configType = "default" }; storage = @{ ephemeralStorage = @{ storageSize = 2048 } } }
  ports = @(@{ name = "http"; internalPort = 3000; public = $false; vpcAccessible = $false; protocol = "HTTP" })
  buildSource = "git"; vcsData = $vcs
  buildSettings = @{ dockerfile = @{ buildEngine = "buildkit"; dockerFilePath = "/Dockerfile"; dockerWorkDir = "/" } }
  # No auth build args: BETTER_AUTH_* is runtime env (see runtimeEnvironment).
  runtimeEnvironment = $appEnv
  healthChecks = @(@{ protocol = "HTTP"; type = "readinessProbe"; path = "/api/health"; port = 3000; initialDelaySeconds = 20; periodSeconds = 30; timeoutSeconds = 5; failureThreshold = 3; successThreshold = 1 })
}

# ---- realtime: private socket.io ----
New-Service "realtime" @{
  name = "realtime"; description = "Command Center push path (private socket.io)"
  billing = @{ deploymentPlan = "nf-compute-20" }
  deployment = @{ instances = 1; docker = @{ configType = "default" }; storage = @{ ephemeralStorage = @{ storageSize = 1024 } } }
  ports = @(@{ name = "ws"; internalPort = 4000; public = $false; vpcAccessible = $false; protocol = "HTTP" })
  buildSource = "git"; vcsData = $vcs
  buildSettings = @{ dockerfile = @{ buildEngine = "buildkit"; dockerFilePath = "/mini-services/realtime/Dockerfile"; dockerWorkDir = "/mini-services/realtime" } }
  runtimeEnvironment = @{
    HOST = "0.0.0.0"; PORT = "4000"
    REALTIME_INGEST_SECRET = $envMap["REALTIME_INGEST_SECRET"]
    REALTIME_ALLOWED_ORIGIN = $envMap["REALTIME_ALLOWED_ORIGIN"]
  }
  healthChecks = @(@{ protocol = "HTTP"; type = "readinessProbe"; path = "/healthz"; port = 4000; initialDelaySeconds = 10; periodSeconds = 30; timeoutSeconds = 5; failureThreshold = 3; successThreshold = 1 })
}

"Done. Check builds: $API/projects/$PROJECT/services"
