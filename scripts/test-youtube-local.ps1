[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$VideoUrl
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

& docker compose `
    -f docker-compose.yml `
    -f docker-compose.local.yml `
    exec -T worker `
    yt-dlp `
    --no-playlist `
    --skip-download `
    --print '%(id)s | %(title)s | %(duration_string)s' `
    -- $VideoUrl

if ($LASTEXITCODE -ne 0) {
    throw 'YouTube rechazó la extracción desde esta conexión.'
}

Write-Host 'YouTube es accesible desde la conexión local.' -ForegroundColor Green
