FROM node:22-slim

# tmux is a hard `zylos init` prerequisite (init exits non-zero without it),
# matching the production image. The golden-init bake (below) needs it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash curl git tmux \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

# pm2 is a `zylos init` prerequisite (init exits non-zero if it cannot find or
# install pm2), and matches the production image which installs it globally.
RUN npm install -g pm2@latest \
  && npm install -g --install-links . \
  && zylos --version

# ── Golden post-init workspace ────────────────────────────────────────────────
# Bake one real `zylos init` workspace into the image so scenarios that need a
# post-init state (SETUP=init) can clone it instead of re-running init every
# time. init is run offline with a throwaway `claude` stub on PATH so the auth
# probe resolves without network — the stub answers only `claude auth status`
# (what isClaudeAuthenticated() calls) and lives at a build-only path that is
# absent from the runtime PATH, so it never shadows the real test shims mounted
# at /runtime/bin. The resulting workspace lives at /opt/zylos-golden; run.sh
# clones it per-scenario into an isolated ZYLOS_DIR.
RUN mkdir -p /opt/zylos-buildbin /opt/zylos-buildhome \
  && printf '%s\n' \
       '#!/usr/bin/env bash' \
       'if [ "${1:-}" = "auth" ]; then echo "{\"loggedIn\":true}"; fi' \
       'exit 0' \
       > /opt/zylos-buildbin/claude \
  && chmod +x /opt/zylos-buildbin/claude \
  && PATH="/opt/zylos-buildbin:$PATH" HOME=/opt/zylos-buildhome ZYLOS_DIR=/opt/zylos-golden \
       zylos init --yes --quiet --timezone UTC --runtime claude \
  && rm -rf /opt/zylos-buildhome /opt/zylos-buildbin

WORKDIR /work
