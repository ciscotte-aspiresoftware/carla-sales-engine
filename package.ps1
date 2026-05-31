<#
.SYNOPSIS
    Bundle SDR Engine into a clean zip for handing off to a third party.

.DESCRIPTION
    Stages a copy of the repo into a temp folder, excluding the same things
    .gitignore excludes (secrets, virtualenvs, node_modules, databases,
    backups, OS junk, IDE folders), then zips that staging folder.

    Source code, all four pack layers, docs, install scripts, READMEs,
    and seed CSVs are included.

.PARAMETER OutputPath
    Where to write the zip. Defaults to ../sdr-engine-<yyyy-MM-dd>.zip
    next to the repo folder.

.PARAMETER IncludeDockmaster
    Skip this switch to ship without the DockMaster vendor + product packs.
    Use it (default) to keep them in.

.EXAMPLE
    .\package.ps1
    .\package.ps1 -OutputPath C:\Users\me\Desktop\sdr-engine.zip
#>

[CmdletBinding()]
param(
    [string]$OutputPath,
    [switch]$IncludeDockmaster = $true
)

$ErrorActionPreference = 'Stop'

function Write-Info($text) { Write-Host "[info] $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "[ok]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[warn] $text" -ForegroundColor Yellow }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ParentDir = Split-Path -Parent $ScriptDir
$RepoName  = 'sdr-engine'

if (-not $OutputPath) {
    $stamp = Get-Date -Format 'yyyy-MM-dd'
    $OutputPath = Join-Path $ParentDir "$RepoName-$stamp.zip"
}

# Normalise to absolute path so robocopy/Compress-Archive can find it.
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)

# Staging dir under TEMP so we can't accidentally include it in itself.
$Staging = Join-Path ([System.IO.Path]::GetTempPath()) ("$RepoName-stage-" + [Guid]::NewGuid().ToString('N'))
$StagedRoot = Join-Path $Staging $RepoName

Write-Info "Repo:    $ScriptDir"
Write-Info "Staging: $Staging"
Write-Info "Output:  $OutputPath"

# ── Exclusions (mirror .gitignore + a couple of zip-only extras) ─────────────
$ExcludeDirs = @(
    '.venv', 'venv', 'env', 'ENV',
    'node_modules', '.next', 'out', '.turbo', '.swc',
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
    '.git', '.github',
    '.vscode', '.idea', '.history',
    'dist', 'build', '.cache', 'htmlcov', '.tox',
    'logs'
)

$ExcludeFiles = @(
    # Secrets / local config
    '.env', '.env.local', '.env.*.local',
    '.settings_encryption_key', '.app_settings.json',
    # Databases + backups
    '*.db', '*.db-shm', '*.db-wal', '*.db.bak*',
    '*.sqlite', '*.sqlite3',
    # Logs / temp
    '*.log', '*.tmp', '*.bak',
    # Compiled / build artifacts
    '*.pyc', '*.pyo', '*.tsbuildinfo',
    # OS junk
    '.DS_Store', 'Thumbs.db', 'desktop.ini', 'ehthumbs.db',
    # Zip-only extras: don't ship the zip back inside itself
    "$RepoName-*.zip"
)

if (-not $IncludeDockmaster) {
    $ExcludeFiles += @('dockmaster.json', 'dockmaster.*.json')
    Write-Warn "DockMaster packs will be excluded from this bundle."
}

# Clean up old staging if a stale one exists.
if (Test-Path $Staging) { Remove-Item $Staging -Recurse -Force }
New-Item -ItemType Directory -Path $StagedRoot -Force | Out-Null

# ── Copy via robocopy (handles long paths, mirror semantics, exclusions) ─────
Write-Info "Staging files (this may take a moment)..."

$robocopyArgs = @(
    $ScriptDir, $StagedRoot,
    '/E',                # include subdirs, including empty ones
    '/NFL', '/NDL', '/NJH', '/NJS', '/NP',  # quieter output
    '/R:1', '/W:1',      # don't retry forever on locked files
    '/XD'
) + $ExcludeDirs + @('/XF') + $ExcludeFiles

& robocopy @robocopyArgs | Out-Null
# robocopy exit codes 0-7 are success-ish; >=8 is failure
if ($LASTEXITCODE -ge 8) {
    throw "robocopy failed with exit code $LASTEXITCODE"
}

# ── Sanity check: confirm no secret files snuck through ──────────────────────
$leaked = @()
foreach ($pat in @('.env', '.settings_encryption_key', '*.db')) {
    $hits = Get-ChildItem -Path $StagedRoot -Recurse -Force -Filter $pat -ErrorAction SilentlyContinue |
            Where-Object { -not $_.PSIsContainer }
    if ($hits) { $leaked += $hits.FullName }
}
if ($leaked) {
    Write-Warn "These files matched a secret/db pattern and will be DROPPED:"
    foreach ($p in $leaked) {
        Write-Warn "  $p"
        Remove-Item $p -Force
    }
}

# ── Zip it ───────────────────────────────────────────────────────────────────
if (Test-Path $OutputPath) {
    Write-Warn "Overwriting existing file: $OutputPath"
    Remove-Item $OutputPath -Force
}

Write-Info "Compressing..."
Compress-Archive -Path (Join-Path $StagedRoot '*') -DestinationPath $OutputPath -CompressionLevel Optimal

$sizeMB = [Math]::Round((Get-Item $OutputPath).Length / 1MB, 2)
$fileCount = (Get-ChildItem $StagedRoot -Recurse -File).Count

Write-Ok "Bundled $fileCount files into $OutputPath ($sizeMB MB)"

# ── Cleanup ──────────────────────────────────────────────────────────────────
Remove-Item $Staging -Recurse -Force
Write-Ok "Staging folder cleaned up."

Write-Host ""
Write-Host "Recipient should:" -ForegroundColor Cyan
Write-Host "  1. Unzip the archive"
Write-Host "  2. cd into $RepoName/"
Write-Host "  3. Run install.sh (mac/linux) or install.ps1 / install.bat (windows)"
Write-Host "  4. Run start.sh / start.bat to launch"
Write-Host ""
