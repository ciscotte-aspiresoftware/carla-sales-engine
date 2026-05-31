#!/usr/bin/env bash
# SDR Engine — launches backend (uvicorn) and frontend (next dev) together.
# Tries to open a new terminal window per service; falls back to backgrounded
# processes with combined logs if no supported terminal is found.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$SCRIPT_DIR/backend"
FRONTEND="$SCRIPT_DIR/frontend"

if [[ ! -d "$BACKEND/.venv" ]]; then
    echo "Backend virtualenv not found. Run ./install.sh first." >&2
    exit 1
fi
if [[ ! -d "$FRONTEND/node_modules" ]]; then
    echo "Frontend node_modules not found. Run ./install.sh first." >&2
    exit 1
fi

BACKEND_CMD="cd \"$BACKEND\" && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000"
FRONTEND_CMD="cd \"$FRONTEND\" && npm run dev"

open_browser_later() {
    # Give Next.js a few seconds to bind to :3000 before opening the browser.
    (
        sleep 5
        if command -v open >/dev/null 2>&1; then
            open http://localhost:3000 || true
        elif command -v xdg-open >/dev/null 2>&1; then
            xdg-open http://localhost:3000 >/dev/null 2>&1 || true
        fi
    ) &
}

run_in_terminal() {
    local title="$1"; local cmd="$2"
    case "$(uname -s)" in
        Darwin*)
            # macOS — use AppleScript to open Terminal.app
            osascript <<EOF
tell application "Terminal"
    activate
    do script "echo '── $title ──'; $cmd"
end tell
EOF
            ;;
        Linux*)
            if command -v gnome-terminal >/dev/null 2>&1; then
                gnome-terminal --title="$title" -- bash -c "$cmd; exec bash" &
            elif command -v konsole >/dev/null 2>&1; then
                konsole --new-tab -p "tabtitle=$title" -e bash -c "$cmd; exec bash" &
            elif command -v xterm >/dev/null 2>&1; then
                xterm -T "$title" -e bash -c "$cmd; exec bash" &
            else
                return 1
            fi
            ;;
        *)
            return 1
            ;;
    esac
}

echo "Starting SDR Engine..."

if run_in_terminal "SDR Engine Backend" "$BACKEND_CMD" && \
   run_in_terminal "SDR Engine Frontend" "$FRONTEND_CMD"; then
    open_browser_later
    echo ""
    echo "Both servers are starting in separate terminal windows."
    echo "  Backend:  http://localhost:8000"
    echo "  Frontend: http://localhost:3000"
    echo ""
    echo "Close those two terminal windows to stop the servers."
    exit 0
fi

# ── Fallback: run inline as background jobs with combined output ──────────────
warn_no_term() {
    echo ""
    echo "No supported terminal emulator found. Running both services in this"
    echo "shell with combined logs. Press Ctrl+C to stop both."
    echo ""
}
warn_no_term

trap 'echo ""; echo "Stopping..."; kill 0' EXIT INT TERM

(
    cd "$BACKEND"
    # shellcheck disable=SC1091
    source .venv/bin/activate
    uvicorn app.main:app --reload --port 8000 2>&1 | sed 's/^/[backend] /'
) &

(
    cd "$FRONTEND"
    npm run dev 2>&1 | sed 's/^/[frontend] /'
) &

open_browser_later
wait
