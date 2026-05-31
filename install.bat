@echo off
setlocal enabledelayedexpansion
title SDR Engine - Setup Wizard

echo.
echo ==================================================
echo   SDR Engine - Setup Wizard (Windows / cmd)
echo ==================================================
echo.
echo This script will:
echo   1. Check that Python 3.11+ and Node.js 18+ are installed
echo   2. Prompt you for your API keys
echo   3. Create a Python virtual environment and install
echo      backend dependencies
echo   4. Install frontend (Node.js) dependencies
echo.
echo TIP: PowerShell users may prefer install.ps1 instead.
echo.

REM ── Prerequisites ────────────────────────────────────────────────────────────
echo ==================================================
echo   Checking Prerequisites
echo ==================================================
echo.

echo Checking Python...
python --version 1>nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python is not installed or not in PATH.
    echo         Install Python 3.11+ from: https://www.python.org/downloads/
    echo         Make sure to check "Add Python to PATH" during install.
    echo         If you just installed it, close this window and open a NEW
    echo         Command Prompt so PATH is refreshed.
    goto :fail
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo [OK] Python !PY_VER! detected

REM Enforce Python 3.11+
for /f "tokens=1,2 delims=." %%a in ("!PY_VER!") do (
    set PY_MAJOR=%%a
    set PY_MINOR=%%b
)
if !PY_MAJOR! LSS 3 (
    echo [ERROR] Python 3.11+ is required ^(you have !PY_VER!^).
    goto :fail
)
if !PY_MAJOR! EQU 3 if !PY_MINOR! LSS 11 (
    echo [ERROR] Python 3.11+ is required ^(you have !PY_VER!^).
    goto :fail
)

echo.
echo Checking Node.js...
node --version 1>nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Install Node.js 18+ LTS from: https://nodejs.org/
    echo         If you just installed it, close this window and open a NEW
    echo         Command Prompt so PATH is refreshed.
    goto :fail
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo [OK] Node.js !NODE_VER! detected

REM Enforce Node 18+ (strip leading 'v', read major)
set NODE_VER_NOV=!NODE_VER:v=!
for /f "tokens=1 delims=." %%a in ("!NODE_VER_NOV!") do set NODE_MAJOR=%%a
if !NODE_MAJOR! LSS 18 (
    echo [ERROR] Node.js 18+ is required ^(you have !NODE_VER!^).
    goto :fail
)

echo.
echo Checking npm...
call npm --version 1>nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not installed or not callable.
    echo         npm ships with Node.js. If Node was just installed, open a NEW
    echo         Command Prompt and run install.bat again.
    goto :fail
)
for /f "tokens=*" %%v in ('call npm --version') do set NPM_VER=%%v
echo [OK] npm !NPM_VER! detected
echo.

REM ── API Keys ──────────────────────────────────────────────────────────────────
echo ==================================================
echo   API Keys
echo ==================================================
echo.
echo The application needs two API keys.
echo.
echo   1. Anthropic ^(Claude^) - Required
echo      Powers all AI agents: prospect discovery, research
echo      profiles, email copywriting, revenue optimization,
echo      and pack generation.
echo      Get your key at: https://console.anthropic.com/
echo.
echo   2. Tavily - Optional but recommended
echo      Enables live web search during prospect discovery
echo      so Claude can verify business details against real
echo      websites.
echo      Sign up free at: https://tavily.com/
echo.

:ask_anthropic
set ANTHROPIC_KEY=
set /p ANTHROPIC_KEY=Anthropic API key (starts with sk-ant-):
if "!ANTHROPIC_KEY!"=="" (
    echo [ERROR] Anthropic API key is required.
    goto :ask_anthropic
)
echo [OK] Anthropic key received
echo.

set TAVILY_KEY=
set /p TAVILY_KEY=Tavily API key (press Enter to skip):
if "!TAVILY_KEY!"=="" (
    echo [WARN] Tavily key skipped. Discovery will use Claude training
    echo        knowledge only -- no live web search.
) else (
    echo [OK] Tavily key received
)
echo.

REM ── Backend ───────────────────────────────────────────────────────────────────
echo ==================================================
echo   Setting Up Backend
echo ==================================================
echo.

cd /d "%~dp0backend"

if exist .venv\Scripts\activate.bat (
    echo [OK] Reusing existing virtual environment at backend\.venv
) else (
    echo Creating Python virtual environment...
    python -m venv .venv 2> "%TEMP%\sdr_venv_error.txt"
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment.
        type "%TEMP%\sdr_venv_error.txt"
        goto :fail
    )
    echo [OK] Virtual environment created at backend\.venv
)

echo Installing Python dependencies...
call .venv\Scripts\activate.bat
if errorlevel 1 (
    echo [ERROR] Failed to activate backend virtual environment.
    goto :fail
)
python -m pip install --upgrade pip -q > "%TEMP%\sdr_pip_upgrade_log.txt" 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to upgrade pip.
    type "%TEMP%\sdr_pip_upgrade_log.txt"
    goto :fail
)
pip install -r requirements.txt -q > "%TEMP%\sdr_requirements_log.txt" 2>&1
if errorlevel 1 (
    echo [ERROR] Failed to install Python dependencies.
    type "%TEMP%\sdr_requirements_log.txt"
    goto :fail
)
echo [OK] Python dependencies installed

echo Writing backend\.env...
(echo ANTHROPIC_API_KEY=!ANTHROPIC_KEY!) > .env
(echo DATABASE_URL=sqlite:///./aspire_demo.db) >> .env
(echo PACKS_DIR=./packs) >> .env
(echo ENVIRONMENT=development) >> .env
if not "!TAVILY_KEY!"=="" (echo TAVILY_API_KEY=!TAVILY_KEY!) >> .env
echo [OK] .env written

call deactivate
cd /d "%~dp0"

REM ── Frontend ──────────────────────────────────────────────────────────────────
echo.
echo ==================================================
echo   Setting Up Frontend
echo ==================================================
echo.

cd /d "%~dp0frontend"

echo Installing Node.js dependencies (this may take a minute)...
if exist package-lock.json (
    call npm ci
    if errorlevel 1 (
        echo [WARN] npm ci failed, falling back to npm install...
        call npm install
        if errorlevel 1 goto :fail
    )
) else (
    call npm install
    if errorlevel 1 goto :fail
)
echo [OK] Frontend dependencies installed

cd /d "%~dp0"

REM ── Done ──────────────────────────────────────────────────────────────────────
echo.
echo ==================================================
echo   Setup Complete!
echo ==================================================
echo.
echo Run start.bat from this folder to launch both servers,
echo or open TWO Command Prompt windows and run:
echo.
echo   Terminal 1 - Backend (API server):
echo     cd "%~dp0backend"
echo     .venv\Scripts\activate
echo     uvicorn app.main:app --reload --port 8000
echo.
echo   Terminal 2 - Frontend (UI):
echo     cd "%~dp0frontend"
echo     npm run dev
echo.
echo Then open your browser at: http://localhost:3000
echo.
echo [OK] All done.
echo.
pause
exit /b 0

:fail
echo.
echo Setup did not complete. Fix the error above and re-run this script.
echo.
pause
exit /b 1
