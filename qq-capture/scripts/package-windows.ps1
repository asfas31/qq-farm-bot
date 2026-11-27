[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutputRoot
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageName = "qq-capture-windows-amd64-$Version"
$Stage = Join-Path $OutputRoot $PackageName
$Archive = Join-Path $OutputRoot "$PackageName.zip"

Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Stage
Remove-Item -Force -ErrorAction SilentlyContinue $Archive
New-Item -ItemType Directory -Force -Path $Stage | Out-Null

Push-Location $ProjectRoot
try {
    go test ./...
    $env:CGO_ENABLED = "0"
    $env:GOOS = "windows"
    $env:GOARCH = "amd64"
    go build -trimpath -ldflags="-s -w" -o (Join-Path $Stage "qq-capture.exe") .
}
finally { Pop-Location }

Copy-Item (Join-Path $ProjectRoot "config.example.yaml") (Join-Path $Stage "config.example.yaml")
Copy-Item (Join-Path $ProjectRoot ".env.example") (Join-Path $Stage ".env.example")
Copy-Item (Join-Path $ProjectRoot "README-DEPLOY.md") (Join-Path $Stage "README-DEPLOY.md")
New-Item -ItemType Directory -Force -Path (Join-Path $Stage "scripts") | Out-Null
Copy-Item (Join-Path $ProjectRoot "scripts\run-windows.ps1") (Join-Path $Stage "scripts\run-windows.ps1")
Compress-Archive -Path $Stage -DestinationPath $Archive -Force
Remove-Item -Recurse -Force $Stage
Write-Output $Archive
