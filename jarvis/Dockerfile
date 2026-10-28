# syntax=docker/dockerfile:1.7
# The YYC AI UI image (DE0CH/jarvis3 docs/CLAUDE-CODE.md): this CloudCLI fork (client + server) and the router
# jarvis/router.mjs, which runs one CloudCLI server per signed-in user. Built by .github/workflows/jarvis-image.yml
# (ghcr.io/de0ch/yyc-ai-ui:<commit 12>). Build context: the repo root.
FROM node:22.23.3-bookworm AS build
WORKDIR /app
ENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
# The browser UI is the Paseo web app (docs/paseo-ui.md): its own npm workspace, installed from its manifests first so
# the install is cached while only sources change
COPY paseo/package.json paseo/package-lock.json ./paseo/
COPY paseo/scripts ./paseo/scripts
COPY paseo/patches ./paseo/patches
COPY paseo/packages/app/package.json ./paseo/packages/app/
COPY paseo/packages/client/package.json ./paseo/packages/client/
COPY paseo/packages/expo-two-way-audio/package.json ./paseo/packages/expo-two-way-audio/
COPY paseo/packages/highlight/package.json ./paseo/packages/highlight/
COPY paseo/packages/plugin/package.json ./paseo/packages/plugin/
COPY paseo/packages/protocol/package.json ./paseo/packages/protocol/
COPY paseo/packages/relay/package.json ./paseo/packages/relay/
RUN npm --prefix paseo ci
COPY . .
RUN npm run build \
 && node --test jarvis/test/router.test.mjs \
 && npm prune --omit=dev \
 && npm cache clean --force \
 && rm -rf paseo electron docker plugins redirect-package .github dist-server.old dist-server.next \
      node_modules/.cache

# the JuiceFS client, only for `juicefs clone` (copy-on-write copies of sent files through the mount's .control file:
# router.mjs "Sent files", jarvis-clone.ts); the official static build, the volume's own version, checksum-pinned
FROM debian:bookworm-slim AS juicefs
ADD --checksum=sha256:01ee09a21a9351a465e09906f113845e1c6a19bea70f530e5e2b2125b2dd3b82 \
    https://github.com/juicedata/juicefs/releases/download/v1.4.1/juicefs-1.4.1-linux-amd64.tar.gz /tmp/juicefs.tgz
RUN tar -xzf /tmp/juicefs.tgz -C /usr/local/bin juicefs && /usr/local/bin/juicefs version

FROM node:22.23.3-bookworm-slim
# tini: PID 1 forwards SIGTERM to the router (which drains, then stops the user processes) and reaps them
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=0:0 /app /app
COPY --from=juicefs /usr/local/bin/juicefs /usr/local/bin/juicefs
# per-user HOME folders (an emptyDir in the pod); the node user is uid 1000, the sandbox user's uid on JuiceFS
RUN install -d -o 1000 -g 1000 /var/lib/cloudcli /var/lib/cloudcli/home
USER 1000:1000
ENV NODE_ENV=production PORT=8080 JARVIS_UI_SERVER=/app/dist-server/server/index.js
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/jarvis/router.mjs"]
