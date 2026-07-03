<#
.SYNOPSIS
  Download the pinned offline aircraft enrichment DB for LOCAL development.

.DESCRIPTION
  The Docker image bakes this file in at build time (see the repo Dockerfile), so a local
  `dotnet run` doesn't have it and enrichment falls back to OpenSky. Run this once to fetch it
  into backend/data/aircraft.csv.gz, which appsettings.Development.json points at. The URL and
  SHA-256 are pinned to match the Dockerfile; keep them in sync if the Dockerfile pin changes.
  The file is git-ignored (backend/data/).
#>
$ErrorActionPreference = "Stop"

# Pinned to the Dockerfile's wiedehopf/tar1090-db commit — update both together.
$url = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/8661aac00ad9caf09aac9f8ebe614ad1c35632bc/aircraft.csv.gz"
$sha = "f35926918a40d9acdae6e5970f748d5f5948cb0289fb013bf3bbe5c7dbeb3221"

$dataDir = Join-Path $PSScriptRoot "..\data"
$dest = Join-Path $dataDir "aircraft.csv.gz"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

Write-Host "Downloading aircraft.csv.gz ..."
Invoke-WebRequest -Uri $url -OutFile $dest

$actual = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash.ToLower()
if ($actual -ne $sha) {
    Remove-Item $dest -Force
    throw "SHA-256 mismatch (got $actual, expected $sha). File removed."
}

Write-Host "OK: $dest (SHA-256 verified). Restart 'dotnet run' to load it."
