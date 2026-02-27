#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Zylos One-Click Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash
#
# Supported platforms: Linux (Debian/Ubuntu/RHEL), macOS
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# Wrap entire script in a block so bash must read all of it
# before executing anything — protects against partial downloads
# when piped via curl | bash.
_main() {

# ── Configuration ─────────────────────────────────────────────
ZYLOS_REPO="https://github.com/zylos-ai/zylos-core"
NODE_VERSION="24"               # LTS-track major version
MIN_NODE_MAJOR=20
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"
NVM_INSTALLED_NOW=false

# ── Colors (disabled if not a terminal) ───────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BCYAN='\033[1;36m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BCYAN='' BOLD='' NC=''
fi

info()  { printf "${CYAN}[zylos]${NC} %s\n" "$*"; }
ok()    { printf "${GREEN}[zylos]${NC} %s\n" "$*"; }
warn()  { printf "${YELLOW}[zylos]${NC} %s\n" "$*"; }
fail()  { printf "${RED}[zylos]${NC} %s\n" "$*" >&2; exit 1; }

# ── OS Detection ──────────────────────────────────────────────
detect_os() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux)  OS="linux" ;;
    Darwin) OS="macos" ;;
    *)      fail "Unsupported operating system: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)             fail "Unsupported architecture: $ARCH" ;;
  esac

  info "Detected: $OS ($ARCH)"
}

# ── Package Manager ───────────────────────────────────────────
APT_UPDATED=false

install_system_package() {
  local pkg="$1"
  info "Installing $pkg..."

  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    brew install "$pkg"
  elif [ "$OS" = "linux" ]; then
    # Use sudo if not root; skip if already root (e.g., Docker containers)
    local SUDO=""
    if [ "$(id -u)" -ne 0 ]; then
      if ! command -v sudo &>/dev/null; then
        fail "sudo not found and not running as root. Please install $pkg manually as root, then re-run this script."
      fi
      SUDO="sudo"
    fi
    if command -v apt-get &>/dev/null; then
      if [ "$APT_UPDATED" = false ]; then
        $SUDO apt-get update -qq
        APT_UPDATED=true
      fi
      $SUDO apt-get install -y -qq "$pkg"
    elif command -v dnf &>/dev/null; then
      $SUDO dnf install -y "$pkg"
    elif command -v yum &>/dev/null; then
      $SUDO yum install -y "$pkg"
    else
      fail "No supported package manager found (apt-get, dnf, yum). Please install $pkg manually."
    fi
  fi
}

# ── Prerequisite: curl ────────────────────────────────────────
ensure_curl() {
  if command -v curl &>/dev/null; then
    return
  fi
  install_system_package curl
  ok "curl: installed"
}

# ── Prerequisite: git ─────────────────────────────────────────
ensure_git() {
  if command -v git &>/dev/null; then
    ok "git: $(git --version | head -1)"
    return
  fi
  install_system_package git
  ok "git: installed"
}

# ── Prerequisite: tmux ────────────────────────────────────────
ensure_tmux() {
  if command -v tmux &>/dev/null; then
    ok "tmux: $(tmux -V)"
    return
  fi
  install_system_package tmux
  ok "tmux: installed"
}

# ── Prerequisite: Node.js (via nvm) ──────────────────────────
ensure_node() {
  # Check if Node.js + npm exist and meet minimum version
  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    local current_major
    current_major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [ "$current_major" -ge "$MIN_NODE_MAJOR" ]; then
      ok "node: $(node -v) (meets >= v${MIN_NODE_MAJOR} requirement)"
      return
    fi
    warn "node: $(node -v) is below minimum v${MIN_NODE_MAJOR}, upgrading..."
  elif command -v node &>/dev/null; then
    warn "node found but npm is missing, installing via nvm..."
  fi

  # Install or load nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing nvm..."
    NVM_INSTALLED_NOW=true
    curl -fsSL "$NVM_INSTALL_URL" | bash
  fi

  # Load nvm into current shell
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"

  info "Installing Node.js v${NODE_VERSION} via nvm..."
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
  nvm alias default "$NODE_VERSION"

  ok "node: $(node -v)"
}

# ── Install Zylos ─────────────────────────────────────────────
install_zylos() {
  if command -v zylos &>/dev/null; then
    local current_version
    current_version="$(zylos --version 2>/dev/null || echo 'unknown')"
    warn "zylos is already installed (${current_version}). Upgrading..."
  fi

  info "Installing zylos from GitHub (this may take a minute)..."

  # If npm global prefix is not user-writable (system-installed node),
  # use sudo for npm install -g
  local npm_prefix
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "")"
  if [ -n "$npm_prefix" ] && [ -w "$npm_prefix" ]; then
    npm install -g --install-links "$ZYLOS_REPO"
  else
    warn "npm global directory (${npm_prefix:-unknown}) requires elevated permissions, using sudo..."
    if [ "$(id -u)" -eq 0 ]; then
      npm install -g --install-links "$ZYLOS_REPO"
    else
      sudo npm install -g --install-links "$ZYLOS_REPO"
    fi
  fi

  ok "zylos: $(zylos --version 2>/dev/null || echo 'installed')"
}

# ── Entry Point ───────────────────────────────────────────────
echo ""
printf '%b' "${BCYAN}"
echo "  ███████╗██╗   ██╗██╗      ██████╗ ███████╗"
echo "  ╚══███╔╝╚██╗ ██╔╝██║     ██╔═══██╗██╔════╝"
echo "    ███╔╝  ╚████╔╝ ██║     ██║   ██║███████╗"
printf '%b' "${CYAN}"
echo "   ███╔╝    ╚██╔╝  ██║     ██║   ██║╚════██║"
echo "  ███████╗   ██║   ███████╗╚██████╔╝███████║"
echo "  ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝"
printf '%b' "${NC}"
echo ""
printf '%b' "  ${BOLD}Give your AI a life.${NC}"
echo ""
echo ""

# Warn if running as root (nvm and zylos should run as a normal user)
if [ "$(id -u)" -eq 0 ]; then
  warn "Running as root is not recommended. Zylos and nvm work best under a regular user account."
  warn "Press Ctrl+C to abort, or wait 5 seconds to continue..."
  sleep 5
fi

detect_os

echo ""
info "Checking prerequisites..."
echo ""

ensure_curl
ensure_git
ensure_tmux
ensure_node

echo ""
install_zylos

echo ""
ok "Installation complete!"
echo ""

# Detect the user's shell rc file for hints
_detect_shell_rc() {
  case "${SHELL:-}" in
    */zsh)  echo "~/.zshrc" ;;
    */bash) echo "~/.bashrc" ;;
    *)      echo "~/.bashrc or ~/.zshrc" ;;
  esac
}

if [ "$NVM_INSTALLED_NOW" = true ]; then
  # nvm was freshly installed — PATH only works inside this subshell.
  # Auto-run zylos init so the user doesn't need to source manually first.
  info "Running zylos init automatically..."
  echo ""
  zylos init < /dev/tty

  # After init completes, show a prominent reminder as the very last output.
  # Nothing prints after this, so it won't get scrolled away.
  local shell_rc
  shell_rc="$(_detect_shell_rc)"
  echo ""
  printf '%b' "${YELLOW}"
  echo "  ┌────────────────────────────────────────────────────────┐"
  echo "  │                                                        │"
  echo "  │  Setup complete! Your agent is running.                │"
  echo "  │                                                        │"
  echo "  │  To use zylos commands in this terminal, run:          │"
  echo "  │                                                        │"
  printf "  │    source %-44s │\n" "$shell_rc"
  echo "  │                                                        │"
  echo "  │  New terminal sessions will work automatically.        │"
  echo "  │                                                        │"
  echo "  └────────────────────────────────────────────────────────┘"
  printf '%b' "${NC}"
  echo ""
else
  info "Next step — run:"
  echo ""
  echo "    zylos init"
  echo ""
  info "This will set up your agent environment interactively."
fi

} # end of _main — do not remove (partial download guard)

_main "$@"
