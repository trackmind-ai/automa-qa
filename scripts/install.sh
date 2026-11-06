#!/usr/bin/env bash
# AutomaQA prerequisite installer — macOS / Linux
# Installs only what is missing. Every action is printed before it runs.
set -uo pipefail

SCOPE="${1:-both}"
case "$SCOPE" in
  web|mobile|both) ;;
  *) echo "usage: $0 [web|mobile|both]" >&2; exit 2 ;;
esac

ok()   { printf '  [OK]   %s\n' "$1"; }
warn() { printf '  [WARN] %s\n' "$1"; }
step() { printf '\n==> %s\n' "$1"; }

FAILED=0

step "AutomaQA prerequisites (scope: $SCOPE)"
uname -s

if [ "$SCOPE" != "mobile" ]; then
  step "Node.js and npm"
  if command -v node >/dev/null 2>&1; then
    ok "node $(node -v)"
    ok "npm $(npm -v)"
  else
    warn "Node.js not found — install the LTS release from https://nodejs.org"
    FAILED=1
  fi

  if command -v npm >/dev/null 2>&1; then
    step "Playwright and browser drivers"
    npm install --no-fund --no-audit || { warn "npm install failed"; FAILED=1; }
    npx playwright install chromium || { warn "browser install failed"; FAILED=1; }
    if [ "$(uname -s)" = "Linux" ] && [ -n "${CI:-}" ]; then
      npx playwright install --with-deps || warn "system deps install failed"
    fi
    command -v npx >/dev/null 2>&1 && ok "playwright $(npx playwright --version 2>/dev/null || echo '?')"
  fi
fi

# Maestro is installed from Homebrew when available, otherwise from a pinned GitHub
# release whose SHA-256 checksum is verified before anything is unpacked. Nothing is
# ever piped into a shell.
MAESTRO_TAG="cli-2.12.1"
install_maestro() {
  if command -v brew >/dev/null 2>&1; then
    echo "  installing with Homebrew: brew install mobile-dev-inc/tap/maestro"
    brew tap mobile-dev-inc/tap && brew install mobile-dev-inc/tap/maestro
    return
  fi
  local base="https://github.com/mobile-dev-inc/maestro/releases/download/$MAESTRO_TAG"
  local work
  work="$(mktemp -d)" || return 1
  echo "  downloading Maestro $MAESTRO_TAG from GitHub releases"
  (
    cd "$work" || exit 1
    curl -fsSLO "$base/maestro.zip" && curl -fsSLO "$base/checksums_sha256.txt" || exit 1
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum -c checksums_sha256.txt || exit 1
    else
      shasum -a 256 -c checksums_sha256.txt || exit 1
    fi
    unzip -q maestro.zip && mkdir -p "$HOME/.maestro" && cp -R maestro/. "$HOME/.maestro/"
  )
  local rc=$?
  rm -rf "$work"
  return $rc
}

if [ "$SCOPE" != "web" ]; then
  step "Maestro CLI"
  if command -v maestro >/dev/null 2>&1; then
    ok "maestro $(maestro --version 2>/dev/null | head -1)"
  else
    install_maestro || { warn "Maestro install failed"; FAILED=1; }
    export PATH="$PATH:$HOME/.maestro/bin"
    if command -v maestro >/dev/null 2>&1; then
      ok "maestro installed"
      warn "add this to your shell profile: export PATH=\"\$PATH:\$HOME/.maestro/bin\""
    else
      warn "maestro still not on PATH"
      FAILED=1
    fi
  fi

  step "Java (required by Maestro)"
  if command -v java >/dev/null 2>&1; then
    ok "java present"
  else
    warn "Java 17+ not found — install Eclipse Temurin LTS from https://adoptium.net"
  fi

  step "Maestro MCP server"
  if command -v claude >/dev/null 2>&1; then
    if claude mcp list 2>/dev/null | grep -q maestro; then
      ok "maestro MCP already registered"
    else
      claude mcp add --scope user maestro maestro mcp \
        && { ok "registered"; warn "restart Claude Code — MCP servers load at startup"; } \
        || warn "registration failed; run: claude mcp add --scope user maestro maestro mcp"
    fi
  else
    warn "claude CLI not found — skipping MCP registration"
  fi
fi

step "Done"
if [ "$FAILED" -eq 0 ]; then
  echo "  Prerequisites satisfied. Next: run /automaqa:setup inside Claude Code."
  exit 0
else
  echo "  Some items need attention — see [WARN] lines above."
  exit 1
fi
