# The YYC AI UI image (DE0CH/jarvis3 docs/CLAUDE-CODE.md): this CloudCLI fork (client + server) and the router
# jarvis/router.mjs, which runs one CloudCLI server per signed-in user. Built by .github/workflows/jarvis-image.yml
# (ghcr.io/de0ch/yyc-ai-ui:<commit 12>). Build context: the repo root.
FROM node:22.23.3-bookworm AS build
WORKDIR /app
ENV HUSKY=0 ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build \
 && node --test jarvis/test/router.test.mjs \
 && npm prune --omit=dev \
 && npm cache clean --force \
 && rm -rf src electron docker plugins redirect-package .github dist-server.old dist-server.next \
      node_modules/.cache

FROM node:22.23.3-bookworm-slim
# tini: PID 1 forwards SIGTERM to the router (which drains, then stops the user processes) and reaps them
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=0:0 /app /app
# per-user HOME folders (an emptyDir in the pod); the node user is uid 1000, the sandbox user's uid on JuiceFS
RUN install -d -o 1000 -g 1000 /var/lib/cloudcli /var/lib/cloudcli/home
USER 1000:1000
ENV NODE_ENV=production PORT=8080 JARVIS_UI_SERVER=/app/dist-server/server/index.js
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/jarvis/router.mjs"]
