#!/usr/bin/env bash
# SDR Engine — bundle the repo into a clean zip for handing off to a third party.
# Mirrors the exclusions in .gitignore (secrets, virtualenvs, node_modules,
# databases, backups, OS junk, IDE folders). Includes all four pack layers,
# docs, install scripts, READMEs, and seed CSVs.
#
# Usage:
#   ./package.sh                       # → ../sdr-engine-YYYY-MM-DD.zip
#   ./package.sh /path/to/out.zip      # custom output path
#   ./package.sh --no-dockmaster       # exclude DockMaster packs
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_NAME="sdr-engine"
STAMP="$(date +%Y-%m-%d)"

OUTPUT=""
INCLUDE_DOCKMASTER=1

for arg in "$@"; do
    case "$arg" in
        --no-dockmaster) INCLUDE_DOCKMASTER=0 ;;
        -h|--help)
            sed -n '1,11p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) OUTPUT="$arg" ;;
    esac
done

if [[ -z "$OUTPUT" ]]; then
    OUTPUT="$PARENT_DIR/${REPO_NAME}-${STAMP}.zip"
fi
# Make output absolute so the cd later doesn't break it.
case "$OUTPUT" in
    /*) ;;
    *)  OUTPUT="$(pwd)/$OUTPUT" ;;
esac

info() { printf "[info] %s\n" "$1"; }
ok()   { printf "[ok]   %s\n" "$1"; }
warn() { printf "[warn] %s\n" "$1"; }

# Prefer `zip`; fall back to Python's zipfile if not installed.
ZIP_TOOL=""
if command -v zip >/dev/null 2>&1; then
    ZIP_TOOL="zip"
elif command -v python3 >/dev/null 2>&1; then
    ZIP_TOOL="python"
else
    echo "Neither 'zip' nor 'python3' is available. Install one and retry." >&2
    exit 1
fi

STAGING="$(mktemp -d -t "${REPO_NAME}-stage-XXXXXX")"
STAGED_ROOT="$STAGING/$REPO_NAME"
mkdir -p "$STAGED_ROOT"

info "Repo:    $SCRIPT_DIR"
info "Staging: $STAGING"
info "Output:  $OUTPUT"

# ── Exclusions (mirror .gitignore + a couple of zip-only extras) ─────────────
# Directory names to skip anywhere in the tree
EXCLUDE_DIRS=(
    .venv venv env ENV
    node_modules .next out .turbo .swc
    __pycache__ .pytest_cache .mypy_cache .ruff_cache
    .git .github
    .vscode .idea .history
    dist build .cache htmlcov .tox
    logs
)
# File glob patterns to skip
EXCLUDE_FILES=(
    .env .env.local
    .settings_encryption_key .app_settings.json
    "*.db" "*.db-shm" "*.db-wal" "*.db.bak*"
    "*.sqlite" "*.sqlite3"
    "*.log" "*.tmp" "*.bak"
    "*.pyc" "*.pyo" "*.tsbuildinfo"
    .DS_Store Thumbs.db desktop.ini ehthumbs.db
    "${REPO_NAME}-*.zip"
)
if (( ! INCLUDE_DOCKMASTER )); then
    EXCLUDE_FILES+=("dockmaster.json" "dockmaster.*.json")
    warn "DockMaster packs will be excluded from this bundle."
fi

# Build rsync prune list. rsync uses --exclude with glob semantics — directory
# excludes with a trailing slash skip anywhere in the tree.
RSYNC_ARGS=(-a --prune-empty-dirs)
for d in "${EXCLUDE_DIRS[@]}"; do
    RSYNC_ARGS+=(--exclude "$d/")
done
for f in "${EXCLUDE_FILES[@]}"; do
    RSYNC_ARGS+=(--exclude "$f")
done

info "Staging files..."
if command -v rsync >/dev/null 2>&1; then
    rsync "${RSYNC_ARGS[@]}" "$SCRIPT_DIR/" "$STAGED_ROOT/"
else
    # Fallback: cp -R then prune. Less efficient but works on bare Linux/macOS.
    warn "rsync not found — using cp + post-prune (slower)."
    cp -R "$SCRIPT_DIR/." "$STAGED_ROOT/"
    for d in "${EXCLUDE_DIRS[@]}"; do
        find "$STAGED_ROOT" -depth -name "$d" -type d -exec rm -rf {} + 2>/dev/null || true
    done
    for f in "${EXCLUDE_FILES[@]}"; do
        find "$STAGED_ROOT" -depth -name "$f" -type f -exec rm -f {} + 2>/dev/null || true
    done
fi

# ── Sanity check: drop anything that looks like a secret or db ───────────────
leaked=()
while IFS= read -r -d '' f; do leaked+=("$f"); done < <(
    find "$STAGED_ROOT" \( -name '.env' -o -name '.settings_encryption_key' -o -name '*.db' -o -name '*.db-shm' -o -name '*.db-wal' \) -type f -print0
)
if (( ${#leaked[@]} > 0 )); then
    warn "These files matched a secret/db pattern and will be DROPPED:"
    for f in "${leaked[@]}"; do
        warn "  $f"
        rm -f "$f"
    done
fi

# ── Zip it ───────────────────────────────────────────────────────────────────
if [[ -e "$OUTPUT" ]]; then
    warn "Overwriting existing file: $OUTPUT"
    rm -f "$OUTPUT"
fi

info "Compressing..."
cd "$STAGING"
if [[ "$ZIP_TOOL" == "zip" ]]; then
    zip -rq "$OUTPUT" "$REPO_NAME"
else
    python3 -c "
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, _, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            arc  = os.path.relpath(full, os.path.dirname(root))
            z.write(full, arc)
" "$STAGED_ROOT" "$OUTPUT"
fi

size_bytes=$(stat -c %s "$OUTPUT" 2>/dev/null || stat -f %z "$OUTPUT")
size_mb=$(awk "BEGIN {printf \"%.2f\", $size_bytes/1048576}")
file_count=$(find "$STAGED_ROOT" -type f | wc -l | tr -d ' ')

ok "Bundled $file_count files into $OUTPUT ($size_mb MB)"

rm -rf "$STAGING"
ok "Staging folder cleaned up."

cat <<EOF

Recipient should:
  1. Unzip the archive
  2. cd into $REPO_NAME/
  3. Run install.sh (mac/linux) or install.ps1 / install.bat (windows)
  4. Run start.sh / start.bat to launch

EOF
