[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "..\config.yaml"),
    [string]$CertDir = (Join-Path $PSScriptRoot "..\certs"),
    [string]$PublicHost = $env:PUBLIC_HOST
)

$ErrorActionPreference = "Stop"
$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Binary = Join-Path $AppRoot "qq-capture.exe"
if (-not (Test-Path $Binary)) { throw "Missing executable: $Binary" }
if (-not (Test-Path $ConfigPath)) { throw "Missing config: $ConfigPath. Copy config.example.yaml to config.yaml first." }
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null

$env:CONFIG_PATH = (Resolve-Path $ConfigPath).Path
$env:CERT_DIR = (Resolve-Path $CertDir).Path
if ($PublicHost) { $env:PUBLIC_HOST = $PublicHost }
Set-Location $AppRoot
& $Binary
