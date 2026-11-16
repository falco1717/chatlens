# Gives the ChatLens container on your server its own Claude login.
#
# 1. Creates a long-lived token for your Claude subscription (opens a browser).
# 2. Asks you to paste it at a hidden prompt.
# 3. Writes it to <RemoteDir>/.env on the server over SSH (never echoed, never
#    stored on this PC) and restarts the container.
#
#   powershell -File set-claude-token.ps1 -Server me@my-server
#   powershell -File set-claude-token.ps1 -Server me@my-server -SkipCreate   # reuse a token you already made
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$RemoteDir = '/opt/chatlens',
  [switch]$SkipCreate
)
$ErrorActionPreference = 'Stop'
$claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
$ssh = 'C:\Windows\System32\OpenSSH\ssh.exe'

if (-not $SkipCreate) {
  Write-Host "Step 1: creating a token. Sign in in the browser window, then copy the token it prints." -ForegroundColor Cyan
  Write-Host "(Widen this window first if you can: a token that wraps still works, the line breaks are removed.)" -ForegroundColor DarkGray
  & $claude setup-token
  Write-Host ""
}

$secure = Read-Host "Step 2: paste the token (input is hidden)" -AsSecureString
$raw = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
# A narrow terminal wraps the token; copying it then picks up spaces/newlines.
$token = $raw -replace '\s', ''
if ($token -notmatch '^sk-ant-oat\d+-[A-Za-z0-9_\-]{40,}$') {
  throw "That doesn't look like a Claude token (expected sk-ant-oat01-..., got $($token.Length) characters after removing spaces); nothing was changed."
}

Write-Host "Step 3: saving it on $Server and restarting ChatLens..." -ForegroundColor Cyan
"CLAUDE_CODE_OAUTH_TOKEN=$token`n" | & $ssh -o BatchMode=yes $Server "umask 077 && cat > $RemoteDir/.env.new && mv $RemoteDir/.env.new $RemoteDir/.env && cd $RemoteDir && docker compose up -d --force-recreate >/dev/null 2>&1 && echo ok"
$token = $null
Write-Host "Done." -ForegroundColor Green
