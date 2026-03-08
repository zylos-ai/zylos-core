FROM node:20-slim

# Install system dependencies if needed by native modules
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Zylos main entry point is cli/zylos.js
ENTRYPOINT ["node", "cli/zylos.js"]
