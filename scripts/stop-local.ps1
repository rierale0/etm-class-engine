[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

& docker compose `
    -f docker-compose.yml `
    -f docker-compose.local.yml `
    down --remove-orphans

if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo detener ETM Class Engine.'
}

Write-Host 'ETM Class Engine se detuvo. Los resultados y la base de datos se conservaron.' -ForegroundColor Green
