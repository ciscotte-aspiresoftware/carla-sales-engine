#!/usr/bin/env bash
# SDR Engine — Setup script for macOS and Linux
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    RED='\033[0;31m';  BOLD='\033[1m';     NC='\033[0m'
else
    CYAN=''; GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

header() { printf "\n${CYAN}${BOLD}══════════════════════════════════════════════════${NC}\n"
           printf "${CYAN}${BOLD}  %s${NC}\n" "$1"
           printf "${CYAN}${BOLD}══════════════════════════════════════════════════${NC}\n\n"; }
ok()     { printf "${GREEN}✓  %s${NC}\n" "$1"; }
warn()   { printf "${YELLOW}⚠  %s${NC}\n" "$1"; }
err()    { printf "${RED}✗  %s${NC}\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── OS detection ──────────────────────────────────────────────────────────────
OS_KIND="unknown"
case "$(uname -s)" in
    Darwin*) OS_KIND="macos" ;;
    Linux*)  OS_KIND="linux" ;;
    *)       OS_KIND="other" ;;
esac

install_hint_python() {
    case "$OS_KIND" in
        macos) echo "    brew install python@3.12" ;;
        linux) echo "    See https://www.python.org/downloads/  (or your distro: sudo apt install python3.12 python3.12-venv)" ;;
        *)     echo "    See https://www.python.org/downloads/" ;;
    esac
}

install_hint_node() {
    case "$OS_KIND" in
        macos) echo "    brew install node       # or use nvm: https://github.com/nvm-sh/nvm" ;;
        linux) echo "    See https://nodejs.org/  (or use nvm: https://github.com/nvm-sh/nvm)" ;;
        *)     echo "    See https://nodejs.org/" ;;
    esac
}

# ── Banner ────────────────────────────────────────────────────────────────────
header "SDR Engine — Setup Wizard ($OS_KIND)"
echo "This script will:"
echo "  1. Check that Python 3.11+ and Node.js 18+ are installed"
echo "  2. Prompt you for your API keys"
echo "  3. Create a Python virtual environment and install backend dependencies"
echo "  4. Install frontend (Node.js) dependencies"
echo ""

# ── Prerequisites ─────────────────────────────────────────────────────────────
header "Checking Prerequisites"

if ! command -v python3 &>/dev/null; then
    err "Python 3 is not installed or not in PATH."
    install_hint_python
    exit 1
fi
PY_VER_RAW=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=${PY_VER_RAW%.*}
PY_MINOR=${PY_VER_RAW#*.}
ok "Python $PY_VER_RAW"

if (( PY_MAJOR < 3 )) || { (( PY_MAJOR == 3 )) && (( PY_MINOR < 11 )); }; then
    err "Python 3.11+ is required (you have $PY_VER_RAW)."
    install_hint_python
    exit 1
fi

if ! command -v node &>/dev/null; then
    err "Node.js is not installed or not in PATH."
    install_hint_node
    exit 1
fi
NODE_VER=$(node --version | sed 's/^v//')
NODE_MAJOR=${NODE_VER%%.*}
ok "Node.js v$NODE_VER"
if (( NODE_MAJOR < 18 )); then
    err "Node.js 18+ is required (you have v$NODE_VER)."
    install_hint_node
    exit 1
fi

if ! command -v npm &>/dev/null; then
    err "npm is not installed (it normally ships with Node.js)."
    exit 1
fi
ok "npm $(npm --version)"

# ── API Keys ──────────────────────────────────────────────────────────────────
header "API Keys"

echo "The application needs two API keys."
echo ""
printf "  ${BOLD}1. Anthropic (Claude) — Required${NC}\n"
echo "     Powers all AI agents: prospect discovery, research profiles,"
echo "     email copywriting, revenue optimization, and pack generation."
echo "     Get your key at: https://console.anthropic.com/"
echo ""
printf "  ${BOLD}2. Tavily — Optional but recommended${NC}\n"
echo "     Enables live web search during prospect discovery, so Claude"
echo "     can verify business details against real websites."
echo "     Sign up free at: https://tavily.com/"
echo ""

while true; do
    read -rp "$(printf "${BOLD}Anthropic API key${NC} (starts with sk-ant-): ")" ANTHROPIC_KEY
    if [[ -n "${ANTHROPIC_KEY:-}" ]]; then
        ok "Anthropic key received"
        break
    fi
    err "Anthropic API key is required — the app cannot run without it."
done

echo ""
read -rp "$(printf "${BOLD}Tavily API key${NC} (press Enter to skip): ")" TAVILY_KEY || true
if [[ -z "${TAVILY_KEY:-}" ]]; then
    warn "Tavily key skipped. Discovery will use Claude training knowledge only (no live web search)."
else
    ok "Tavily key received"
fi

# ── Backend ───────────────────────────────────────────────────────────────────
header "Setting Up Backend"

cd "$SCRIPT_DIR/backend"

if [[ -d .venv ]]; then
    ok "Reusing existing virtual environment at backend/.venv"
else
    echo "Creating Python virtual environment..."
    if ! python3 -m venv .venv 2>/tmp/sdr_venv_error; then
        err "Failed to create virtual environment."
        cat /tmp/sdr_venv_error
        if [[ "$OS_KIND" == "linux" ]]; then
            echo ""
            warn "On Debian/Ubuntu you may need: sudo apt install python${PY_VER_RAW}-venv"
        fi
        exit 1
    fi
    ok "Virtual environment created at backend/.venv"
fi

echo "Installing Python dependencies..."
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
ok "Python dependencies installed"

echo "Writing backend/.env..."
{
    echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY"
    echo "DATABASE_URL=sqlite:///./aspire_demo.db"
    echo "PACKS_DIR=./packs"
    echo "ENVIRONMENT=development"
    [[ -n "${TAVILY_KEY:-}" ]] && echo "TAVILY_API_KEY=$TAVILY_KEY"
} > .env
chmod 600 .env || true
ok ".env written (chmod 600)"

deactivate

# ── Frontend ──────────────────────────────────────────────────────────────────
header "Setting Up Frontend"

cd "$SCRIPT_DIR/frontend"

echo "Installing Node.js dependencies (this may take a minute)..."
if [[ -f package-lock.json ]]; then
    npm ci || npm install
else
    npm install
fi
ok "Frontend dependencies installed"

# ── Done ──────────────────────────────────────────────────────────────────────
header "Setup Complete!"

printf "Run ${BOLD}./start.sh${NC} from the repo root to launch both servers, or start them manually:\n\n"

printf "${CYAN}${BOLD}Terminal 1 — Backend (API server):${NC}\n"
echo "  cd \"$SCRIPT_DIR/backend\""
echo "  source .venv/bin/activate"
echo "  uvicorn app.main:app --reload --port 8000"
echo ""

printf "${CYAN}${BOLD}Terminal 2 — Frontend (UI):${NC}\n"
echo "  cd \"$SCRIPT_DIR/frontend\""
echo "  npm run dev"
echo ""

printf "Then open your browser at: ${CYAN}${BOLD}http://localhost:3000${NC}\n"
echo ""
ok "All done."
