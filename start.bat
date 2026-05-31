@echo off
setlocal

set ROOT=%~dp0
set BACKEND=%ROOT%backend
set FRONTEND=%ROOT%frontend

if not exist "%BACKEND%\.venv\Scripts\activate.bat" (
    echo Backend virtualenv not found at %BACKEND%\.venv
    echo Run install.bat or install.ps1 first.
    pause
    exit /b 1
)
if not exist "%FRONTEND%\node_modules" (
    echo Frontend node_modules not found at %FRONTEND%\node_modules
    echo Run install.bat or install.ps1 first.
    pause
    exit /b 1
)

echo Starting SDR Engine...

REM Backend (FastAPI + uvicorn via .venv)
start "SDR Engine Backend" cmd /k "cd /d "%BACKEND%" && .venv\Scripts\activate && uvicorn app.main:app --reload --port 8000"

REM Frontend (Next.js)
start "SDR Engine Frontend" cmd /k "cd /d "%FRONTEND%" && npm run dev"

REM Open browser after 5s (enough for Next.js to boot)
timeout /t 5 /nobreak > nul
start http://localhost:3000

echo.
echo Both servers are starting in separate windows.
echo   Backend:  http://localhost:8000
echo   Frontend: http://localhost:3000
echo.
echo Close those two CMD windows to stop the servers.
