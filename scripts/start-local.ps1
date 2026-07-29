[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker no está disponible. Inicia Docker Desktop y vuelve a intentarlo.'
}

if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host 'Se creó .env desde .env.example.' -ForegroundColor Yellow
    Write-Host 'Configura tu API key y secretos en .env, luego ejecuta este script otra vez.'
    exit 1
}

if (-not (Test-Path -LiteralPath 'secrets')) {
    New-Item -ItemType Directory -Path 'secrets' | Out-Null
}
if (-not (Test-Path -LiteralPath 'secrets/youtube_cookies')) {
    New-Item -ItemType File -Path 'secrets/youtube_cookies' | Out-Null
}

$savedErrorActionPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'SilentlyContinue'
    & docker info *> $null
    $dockerInfoExitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $savedErrorActionPreference
}

if ($dockerInfoExitCode -ne 0) {
    throw 'Docker Desktop no está listo. Espera a que termine de iniciar y vuelve a intentarlo.'
}

$port = 8080
$portLine = Get-Content -LiteralPath '.env' |
    Where-Object { $_ -match '^\s*ETM_LOCAL_PORT\s*=\s*(\d+)\s*$' } |
    Select-Object -Last 1
if ($portLine -and $portLine -match '^\s*ETM_LOCAL_PORT\s*=\s*(\d+)\s*$') {
    $port = [int]$Matches[1]
}

$compose = @(
    'compose',
    '-f', 'docker-compose.yml',
    '-f', 'docker-compose.local.yml'
)

Write-Host 'Validando la configuración local…'
& docker @compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'La configuración de Docker Compose no es válida.' }

Write-Host 'Construyendo e iniciando ETM Class Engine…'
& docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose no pudo iniciar la aplicación.' }

$url = "http://localhost:$port"
$readyUrl = "$url/ready"
Write-Host 'Esperando a que el motor esté listo…'
$ready = $false
for ($attempt = 1; $attempt -le 90; $attempt++) {
    try {
        $response = Invoke-RestMethod -Uri $readyUrl -TimeoutSec 3
        if ($response.status -eq 'ready') {
            $ready = $true
            break
        }
    }
    catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) {
    & docker @compose ps
    throw "La aplicación no respondió en $readyUrl. Revisa: docker compose -f docker-compose.yml -f docker-compose.local.yml logs --tail=200 api worker"
}

Write-Host "ETM Class Engine está listo en $url" -ForegroundColor Green
Start-Process $url
