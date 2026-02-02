#!/bin/bash
# Zylos Installation Script
# Usage: curl -fsSL https://zylos.ai/install.sh | bash

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ZYLOS_DIR="$HOME/zylos"
SKILLS_DIR="$HOME/.claude/skills"
REPO_URL="https://github.com/zylos-ai/zylos-core.git"

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════╗"
echo "║         Zylos Installation            ║"
echo "║    Autonomous AI Agent Infrastructure ║"
echo "╚═══════════════════════════════════════╝"
echo -e "${NC}"

# Check for required tools
check_requirements() {
    echo -e "${BLUE}Checking requirements...${NC}"

    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}Error: Node.js is required but not installed.${NC}"
        echo "Install Node.js 18+ from: https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "${RED}Error: Node.js 18+ required. Found: $(node -v)${NC}"
        exit 1
    fi
    echo "  ✓ Node.js $(node -v)"

    # Check npm
    if ! command -v npm &> /dev/null; then
        echo -e "${RED}Error: npm is required but not installed.${NC}"
        exit 1
    fi
    echo "  ✓ npm $(npm -v)"

    # Check git
    if ! command -v git &> /dev/null; then
        echo -e "${RED}Error: git is required but not installed.${NC}"
        exit 1
    fi
    echo "  ✓ git $(git --version | cut -d' ' -f3)"

    # Check PM2
    if ! command -v pm2 &> /dev/null; then
        echo -e "${YELLOW}PM2 not found. Installing...${NC}"
        npm install -g pm2
    fi
    echo "  ✓ PM2 $(pm2 -v)"

    # Check Claude Code
    if ! command -v claude &> /dev/null; then
        echo -e "${YELLOW}Claude Code not found. Installing...${NC}"
        curl -fsSL https://claude.ai/install.sh | bash
    fi
    echo "  ✓ Claude Code"
}

# Create directory structure
create_directories() {
    echo -e "\n${BLUE}Creating directories...${NC}"

    mkdir -p "$ZYLOS_DIR"/{memory,public,logs,channels}
    mkdir -p "$SKILLS_DIR"

    echo "  ✓ $ZYLOS_DIR"
    echo "  ✓ $SKILLS_DIR"
}

# Clone and install zylos-core
install_core() {
    echo -e "\n${BLUE}Installing Zylos Core...${NC}"

    TEMP_DIR=$(mktemp -d)
    git clone --depth 1 "$REPO_URL" "$TEMP_DIR/zylos-core"

    # Copy skills to Claude skills directory
    cp -r "$TEMP_DIR/zylos-core/skills/"* "$SKILLS_DIR/"
    echo "  ✓ Skills installed to $SKILLS_DIR"

    # Copy templates
    cp "$TEMP_DIR/zylos-core/templates/.env.example" "$ZYLOS_DIR/.env"
    cp "$TEMP_DIR/zylos-core/templates/pm2.config.js" "$ZYLOS_DIR/"
    cp "$TEMP_DIR/zylos-core/templates/CLAUDE.md" "$ZYLOS_DIR/"
    cp -r "$TEMP_DIR/zylos-core/templates/memory/"* "$ZYLOS_DIR/memory/"
    echo "  ✓ Templates installed"

    # Install CLI globally
    cd "$TEMP_DIR/zylos-core"
    npm install
    npm link
    echo "  ✓ CLI installed (zylos command)"

    # Install skill dependencies
    for skill_dir in "$SKILLS_DIR"/*/; do
        if [ -f "$skill_dir/package.json" ]; then
            echo "  Installing dependencies for $(basename "$skill_dir")..."
            (cd "$skill_dir" && npm install --production)
        fi
    done

    # Cleanup
    rm -rf "$TEMP_DIR"
}

# Interactive configuration
configure() {
    echo -e "\n${BLUE}Configuration${NC}"

    # Domain
    read -p "Enter your domain (e.g., zylos.example.com): " DOMAIN
    if [ -n "$DOMAIN" ]; then
        sed -i "s/DOMAIN=.*/DOMAIN=$DOMAIN/" "$ZYLOS_DIR/.env"
    fi

    # Timezone
    read -p "Enter timezone (default: UTC): " TZ
    TZ=${TZ:-UTC}
    sed -i "s/TZ=.*/TZ=$TZ/" "$ZYLOS_DIR/.env"

    echo "  ✓ Configuration saved to $ZYLOS_DIR/.env"
}

# Start services
start_services() {
    echo -e "\n${BLUE}Starting services...${NC}"

    pm2 start "$ZYLOS_DIR/pm2.config.js"
    pm2 save

    echo "  ✓ Services started"
}

# Print completion message
complete() {
    echo -e "\n${GREEN}"
    echo "╔═══════════════════════════════════════╗"
    echo "║     Zylos Installation Complete!      ║"
    echo "╚═══════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Edit $ZYLOS_DIR/.env if needed"
    echo "  2. Run: zylos status"
    echo "  3. Start Claude: tmux new -s claude-main 'claude'"
    echo ""
    echo "Documentation: https://github.com/zylos-ai/zylos-core"
}

# Main
main() {
    check_requirements
    create_directories
    install_core
    configure
    start_services
    complete
}

main
