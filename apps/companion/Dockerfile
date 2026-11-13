# syntax=docker/dockerfile:1
# Phone panel image: the Angular production build served by nginx, which also proxies /api to the backend.
# Build context: the repository root (docker-compose.yml sets it), because the panel imports the API types
# type-only from packages/*/src through its tsconfig `paths`, e.g.
#   docker build -f apps/companion/Dockerfile -t bmw-copilot-panel .

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginx:stable-alpine

# --- build: the panel has its own package.json and lockfile (not an npm workspace) -------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app/apps/companion
COPY apps/companion/package.json apps/companion/package-lock.json ./
RUN npm ci --no-audit --no-fund
# Types only (the paths mapping resolves to ../../packages/*/src/index.ts); nothing from them is bundled at runtime.
COPY packages/vehicle-core/src /app/packages/vehicle-core/src
COPY packages/event-engine/src /app/packages/event-engine/src
COPY packages/shared/src /app/packages/shared/src
COPY apps/companion/angular.json apps/companion/tsconfig.json apps/companion/tsconfig.app.json apps/companion/tsconfig.spec.json ./
COPY apps/companion/public ./public
COPY apps/companion/src ./src
RUN npm run build

# --- serve: static files plus the /api reverse proxy -----------------------------------------------------------------
FROM ${NGINX_IMAGE} AS serve
COPY apps/companion/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/companion/dist/companion/browser /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1/"]
