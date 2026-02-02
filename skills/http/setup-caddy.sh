#!/bin/bash
# C6 HTTP Layer - Caddy Setup Script
# Sets up Caddy web server for file sharing and optional proxies
#
# Usage: ./setup-caddy.sh [--with-lark] [--with-browser]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZYLOS_DIR="${ZYLOS_DIR:-$HOME/zylos}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Parse arguments
WITH_LARK=false
WITH_BROWSER=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --with-lark)
            WITH_LARK=true
            shift
            ;;
        --with-browser)
            WITH_BROWSER=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: ./setup-caddy.sh [--with-lark] [--with-browser]"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}C6 HTTP Layer - Caddy Setup${NC}"
echo "============================"
echo ""

# Check for .env file
ENV_FILE="$ZYLOS_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Error: $ENV_FILE not found${NC}"
    echo "Create .env file with DOMAIN=your.domain.com"
    exit 1
fi

# Read domain from .env
DOMAIN=$(grep "^DOMAIN=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'")

if [ -z "$DOMAIN" ]; then
    echo -e "${YELLOW}No domain configured in .env${NC}"
    read -p "Enter your domain (e.g., zylos.example.com): " DOMAIN
    if [ -n "$DOMAIN" ]; then
        echo "DOMAIN=$DOMAIN" >> "$ENV_FILE"
    else
        echo -e "${RED}Domain is required. Exiting.${NC}"
        exit 1
    fi
fi

echo "Domain: $DOMAIN"
echo "Zylos directory: $ZYLOS_DIR"
echo ""

# Create required directories
mkdir -p "$ZYLOS_DIR/public"
mkdir -p "$ZYLOS_DIR/logs"

# Fix permissions for Caddy to read public files
chmod o+rx "$HOME" 2>/dev/null || true
chmod o+rx "$ZYLOS_DIR" 2>/dev/null || true
chmod -R o+r "$ZYLOS_DIR/public" 2>/dev/null || true

# Generate Caddyfile from template
CADDYFILE="$ZYLOS_DIR/Caddyfile"
echo "Generating Caddyfile..."

# Start with base config
cat > "$CADDYFILE" << EOF
# Zylos C6 HTTP Layer - Generated Caddyfile
# Domain: $DOMAIN
# Generated: $(date)

$DOMAIN {
    root * $ZYLOS_DIR/public

    file_server {
        hide .git .env *.db *.json
    }

    @markdown path *.md
    handle @markdown {
        header Content-Type "text/plain; charset=utf-8"
    }

    handle /health {
        respond "OK" 200
    }
EOF

# Add Lark proxy if requested
if [ "$WITH_LARK" = true ]; then
    echo -e "  ${GREEN}+${NC} Adding Lark webhook proxy"
    cat >> "$CADDYFILE" << 'EOF'

    # Lark webhook proxy
    handle /lark/* {
        uri strip_prefix /lark
        reverse_proxy localhost:3457
    }
EOF
fi

# Add browser/VNC proxy if requested
if [ "$WITH_BROWSER" = true ]; then
    echo -e "  ${GREEN}+${NC} Adding VNC/browser proxy"
    cat >> "$CADDYFILE" << 'EOF'

    # noVNC remote desktop
    handle /vnc/* {
        uri strip_prefix /vnc
        reverse_proxy localhost:6080
    }

    # Browser agent WebSocket
    handle /ws {
        reverse_proxy localhost:8765
    }
EOF
fi

# Add logging and close
cat >> "$CADDYFILE" << EOF

    log {
        output file $ZYLOS_DIR/logs/caddy-access.log {
            roll_size 10mb
            roll_keep 3
        }
    }
}
EOF

echo ""
echo "Generated Caddyfile:"
echo "---"
cat "$CADDYFILE"
echo "---"
echo ""

# Check if Caddy is installed
if ! command -v caddy &> /dev/null; then
    echo -e "${YELLOW}Caddy is not installed.${NC}"
    echo "Install with: sudo apt install -y caddy"
    echo "Or see: https://caddyserver.com/docs/install"
    echo ""
    echo "Caddyfile saved to: $CADDYFILE"
    exit 0
fi

# Apply configuration
read -p "Apply Caddy configuration now? (Y/n): " apply
if [ "$apply" != "n" ] && [ "$apply" != "N" ]; then
    sudo cp "$CADDYFILE" /etc/caddy/Caddyfile
    sudo systemctl enable caddy 2>/dev/null || true
    sudo systemctl restart caddy

    echo ""
    echo -e "${GREEN}Caddy configured and started!${NC}"
    echo ""
    echo "Your site is live at: https://$DOMAIN/"
    echo ""
    echo "Verify with:"
    echo "  sudo systemctl status caddy"
    echo "  curl -I https://$DOMAIN/health"
else
    echo ""
    echo "Caddyfile saved to: $CADDYFILE"
    echo "Apply manually:"
    echo "  sudo cp $CADDYFILE /etc/caddy/Caddyfile"
    echo "  sudo systemctl restart caddy"
fi
