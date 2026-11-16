# ChatLens container. glibc base: the Agent SDK pulls its
# linux-x64 Claude binary as an optional npm package.
FROM node:24-bookworm-slim

# Tools for Claude's shell when "Full tools" is on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates python3 openssh-client jq less procps ripgrep \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY lib ./lib
COPY public ./public

# uid 1000 (the usual first user on the host), so bind-mounted data stays writable.
USER node
ENV NODE_ENV=production \
    CHATLENS_HOSTED=1 \
    CHATLENS_HOST=0.0.0.0 \
    CHATLENS_PORT=4477 \
    CHATLENS_PROJECTS_DIR=/data/sync/projects \
    CHATLENS_DESKTOP_FILE=/data/sync/desktop.json \
    CHATLENS_LIVE_FILE=/data/sync/live.json \
    CHATLENS_BRIDGE_DIR=/data/bridge \
    CHATLENS_DATA_DIR=/data/app/state \
    CHATLENS_WORKSPACE=/data/app/workspace \
    HOME=/data/app/home
EXPOSE 4477
CMD ["node", "server.mjs"]
