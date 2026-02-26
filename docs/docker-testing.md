# Docker Testing Guide

Use a disposable Docker container to test zylos installation and initialization without affecting your host machine.

## Quick Start

```bash
# Launch a clean Ubuntu container
docker run -it --rm ubuntu:24.04 bash
```

Once inside the container:

```bash
# Install curl (minimal image doesn't have it)
apt-get update && apt-get install -y curl

# One-click install
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/main/scripts/install.sh | bash

# Reload shell (nvm needs it)
exec bash

# Initialize
zylos init
```

## Testing a Branch

To test a feature branch before merging:

```bash
docker run -it --rm ubuntu:24.04 bash
```

**Option A — install.sh from branch:**

```bash
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/zylos-ai/zylos-core/<branch-name>/scripts/install.sh | bash
exec bash
zylos init
```

**Option B — npm install from branch:**

```bash
apt-get update && apt-get install -y curl git
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec bash
nvm install 24
npm install -g zylos-ai/zylos-core#<branch-name>
zylos init
```

Replace `<branch-name>` with the actual branch, e.g. `feat/init-improvements`.

## Persistent Container

If you want to keep the container around for multiple test rounds:

```bash
# Create (without --rm)
docker run -it --name zylos-test ubuntu:24.04 bash

# Exit and re-enter later
docker start -i zylos-test

# Done — clean up
docker rm zylos-test
```

## Testing Checklist

After installing, verify:

| Check | Command |
|-------|---------|
| CLI installed | `zylos --version` |
| Init completes | `zylos init` |
| Status works | `zylos status` |
| Services running | `pm2 list` |

## Notes

- Docker runs as root by default — install.sh handles this (skips sudo)
- `curl | bash` mode has no TTY for stdin — `zylos init` must be run separately
- Each `docker run --rm` gives you a completely clean slate
