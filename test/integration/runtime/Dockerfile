FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash curl git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

RUN npm install -g --install-links . \
  && zylos --version

WORKDIR /work
