<#
.SYNOPSIS
    SDR Engine setup wizard for Windows PowerShell.

.DESCRIPTION
    Checks prerequisites (Python 3.11+, Node.js 18+), prompts for API keys,
    creates the backend virtualenv, installs Python + Node dependencies,
    and writes backend\.env.

.EXAMPLE
    # If you hit an execution-policy error, run this once per session:
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    .\install.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-Header($text) {
    Write-Host ""
    Write-Host ("=" * 50) -ForegroundColor Cyan
    Write-Host "  $text" -ForegroundColor Cyan
    Write-Host ("=" * 50) -ForegroundColor Cyan
    Write-Host ""
}
function Write-Ok($text)   { Write-Host "[OK]   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "[WARN] $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "[ERROR] $text" -ForegroundColor Red }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Header "SDR Engine - Setup Wizard (Windows / PowerShell)"
Write-Host "This script will:"
Write-Host "  1. Check that Python 3.11+ and Node.js 18+ are installed"
Write-Host "  2. Prompt you for your API keys"
Write-Host "  3. Create a Python virtual environment and install backend deps"
Write-Host "  4. Install frontend (Node.js) dependencies"

# ── Prerequisites ────────────────────────────────────────────────────────────
Write-Header "Checking Prerequisites"

# Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Err "Python is not installed or not in PATH."
    Write-Host "       Install Python 3.11+ from: https://www.python.org/downloads/"
    Write-Host "       Make sure 'Add Python to PATH' is checked during install."
    Write-Host "       If you just installed it, open a NEW PowerShell window."
    exit 1
}
$pyVerLine = & python --version 2>&1
if ($pyVerLine -notmatch 'Python\s+(\d+)\.(\d+)') {
    Write-Err "Could not parse Python version: $pyVerLine"
    exit 1
}
$pyMajor = [int]$Matches[1]
$pyMinor = [int]$Matches[2]
Write-Ok "Python $pyMajor.$pyMinor detected"
if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 11)) {
    Write-Err "Python 3.11+ is required (you have $pyMajor.$pyMinor)."
    exit 1
}

# Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err "Node.js is not installed or not in PATH."
    Write-Host "       Install Node.js 18+ LTS from: https://nodejs.org/"
    Write-Host "       If you just installed it, open a NEW PowerShell window."
    exit 1
}
$nodeVer = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVer.Split('.')[0])
Write-Ok "Node.js v$nodeVer detected"
if ($nodeMajor -lt 18) {
    Write-Err "Node.js 18+ is required (you have v$nodeVer)."
    exit 1
}

# npm
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Err "npm is not installed or not callable."
    exit 1
}
$npmVer = (& npm --version)
Write-Ok "npm $npmVer detected"

# ── API Keys ─────────────────────────────────────────────────────────────────
Write-Header "API Keys"
Write-Host "The application needs two API keys."
Write-Host ""
Write-Host "  1. Anthropic (Claude) - Required" -ForegroundColor White
Write-Host "     Powers all AI agents: prospect discovery, research"
Write-Host "     profiles, email copywriting, revenue optimization,"
Write-Host "     and pack generation."
Write-Host "     Get your key at: https://console.anthropic.com/"
Write-Host ""
Write-Host "  2. Tavily - Optional but recommended" -ForegroundColor White
Write-Host "     Enables live web search during prospect discovery"
Write-Host "     so Claude can verify business details against real"
Write-Host "     websites."
Write-Host "     Sign up free at: https://tavily.com/"
Write-Host ""

$anthropicKey = ''
while ([string]::IsNullOrWhiteSpace($anthropicKey)) {
    $anthropicKey = Read-Host "Anthropic API key (starts with sk-ant-)"
    if ([string]::IsNullOrWhiteSpace($anthropicKey)) {
        Write-Err "Anthropic API key is required."
    }
}
Write-Ok "Anthropic key received"

$tavilyKey = Read-Host "Tavily API key (press Enter to skip)"
if ([string]::IsNullOrWhiteSpace($tavilyKey)) {
    Write-Warn "Tavily key skipped. Discovery will use Claude training knowledge only."
} else {
    Write-Ok "Tavily key received"
}

# ── Backend ──────────────────────────────────────────────────────────────────
Write-Header "Setting Up Backend"

$BackendDir = Join-Path $ScriptDir 'backend'
Set-Location $BackendDir

$venvActivate = Join-Path $BackendDir '.venv\Scripts\Activate.ps1'
if (Test-Path $venvActivate) {
    Write-Ok "Reusing existing virtual environment at backend\.venv"
} else {
    Write-Host "Creating Python virtual environment..."
    & python -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to create virtual environment."
        exit 1
    }
    Write-Ok "Virtual environment created at backend\.venv"
}

Write-Host "Installing Python dependencies..."
& (Join-Path $BackendDir '.venv\Scripts\python.exe') -m pip install --upgrade pip -q
if ($LASTEXITCODE -ne 0) { Write-Err "Failed to upgrade pip."; exit 1 }
& (Join-Path $BackendDir '.venv\Scripts\pip.exe') install -r requirements.txt -q
if ($LASTEXITCODE -ne 0) { Write-Err "Failed to install Python dependencies."; exit 1 }
Write-Ok "Python dependencies installed"

Write-Host "Writing backend\.env..."
$envLines = @(
    "ANTHROPIC_API_KEY=$anthropicKey",
    "DATABASE_URL=sqlite:///./aspire_demo.db",
    "PACKS_DIR=./packs",
    "ENVIRONMENT=development"
)
if (-not [string]::IsNullOrWhiteSpace($tavilyKey)) {
    $envLines += "TAVILY_API_KEY=$tavilyKey"
}
$envPath = Join-Path $BackendDir '.env'
$envLines | Out-File -FilePath $envPath -Encoding ascii -Force
Write-Ok ".env written"

# ── Frontend ─────────────────────────────────────────────────────────────────
Write-Header "Setting Up Frontend"

$FrontendDir = Join-Path $ScriptDir 'frontend'
Set-Location $FrontendDir

Write-Host "Installing Node.js dependencies (this may take a minute)..."
if (Test-Path (Join-Path $FrontendDir 'package-lock.json')) {
    & npm ci
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "npm ci failed, falling back to npm install..."
        & npm install
        if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
    }
} else {
    & npm install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}
Write-Ok "Frontend dependencies installed"

Set-Location $ScriptDir

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Header "Setup Complete!"

Write-Host "Run .\start.bat from this folder to launch both servers, or" -ForegroundColor Cyan
Write-Host "open TWO PowerShell windows and run:"
Write-Host ""
Write-Host "  Terminal 1 - Backend (API server):" -ForegroundColor Cyan
Write-Host "    cd `"$BackendDir`""
Write-Host "    .\.venv\Scripts\Activate.ps1"
Write-Host "    uvicorn app.main:app --reload --port 8000"
Write-Host ""
Write-Host "  Terminal 2 - Frontend (UI):" -ForegroundColor Cyan
Write-Host "    cd `"$FrontendDir`""
Write-Host "    npm run dev"
Write-Host ""
Write-Host "Then open your browser at: http://localhost:3000" -ForegroundColor Cyan
Write-Host ""
Write-Ok "All done."
