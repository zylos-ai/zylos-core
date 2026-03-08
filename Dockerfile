FROM node:20-slim

# procps is critical for Claude process detection (pgrep/ps)
RUN apt-get update -qq && \
    apt-get install -y -qq git tmux curl procps && \
    rm -rf /var/lib/apt/lists/*

# Install Zylos and Claude Code
RUN npm install -g --install-links https://github.com/zylos-ai/zylos-core#v0.3.5 && \
    npm install -g @anthropic-ai/claude-code

# Web console listens on all interfaces
ENV WEB_CONSOLE_BIND=0.0.0.0

# Persist data
VOLUME ["/root/zylos", "/root/.claude", "/root/.local"]

EXPOSE 3456

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
