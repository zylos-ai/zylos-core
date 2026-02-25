#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────
# Zylos One-Click Installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash
#
# Supported platforms: Linux (Debian/Ubuntu), macOS
# ──────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────
ZYLOS_REPO="https://github.com/zylos-ai/zylos-core"
NODE_VERSION="24"               # LTS-track major version
MIN_NODE_MAJOR=20
NVM_INSTALL_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh"

# ── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

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
install_system_package() {
  local pkg="$1"
  info "Installing $pkg..."

  if [ "$OS" = "macos" ]; then
    if ! command -v brew &>/dev/null; then
      fail "Homebrew not found. Install it first: https://brew.sh"
    fi
    brew install "$pkg"
  elif [ "$OS" = "linux" ]; then
    if command -v apt-get &>/dev/null; then
      sudo apt-get update -qq && sudo apt-get install -y -qq "$pkg"
    elif command -v yum &>/dev/null; then
      sudo yum install -y "$pkg"
    elif command -v dnf &>/dev/null; then
      sudo dnf install -y "$pkg"
    else
      fail "No supported package manager found (apt-get, yum, dnf). Please install $pkg manually."
    fi
  fi
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
  # Check if Node.js exists and meets minimum version
  if command -v node &>/dev/null; then
    local current_major
    current_major="$(node -v | sed 's/v//' | cut -d. -f1)"
    if [ "$current_major" -ge "$MIN_NODE_MAJOR" ]; then
      ok "node: $(node -v) (meets >= v${MIN_NODE_MAJOR} requirement)"
      return
    fi
    warn "node: $(node -v) is below minimum v${MIN_NODE_MAJOR}, upgrading..."
  fi

  # Install or load nvm
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    info "Installing nvm..."
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

  info "Installing zylos from GitHub..."
  npm install -g --install-links "$ZYLOS_REPO"
  ok "zylos: $(zylos --version 2>/dev/null || echo 'installed')"
}

# ── Initialize ────────────────────────────────────────────────
init_zylos() {
  info "Running zylos init..."
  echo ""
  zylos init
}

# ── Main ──────────────────────────────────────────────────────
main() {
  echo ""
  printf "${BOLD}${CYAN}"
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║         Zylos Installer               ║"
  echo "  ║   Give your AI a life.                ║"
  echo "  ╚═══════════════════════════════════════╝"
  printf "${NC}"
  echo ""

  detect_os

  echo ""
  info "Checking prerequisites..."
  echo ""

  ensure_git
  ensure_tmux
  ensure_node

  echo ""
  install_zylos

  echo ""
  init_zylos
}

main "$@"
