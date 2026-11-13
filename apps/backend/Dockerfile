# syntax=docker/dockerfile:1
# Backend image. Build context: the repository root (docker-compose.yml sets it), e.g.
#   docker build -f apps/backend/Dockerfile -t bmw-copilot-backend .
# Only the files named below are copied: never .env, .research/, data/ or the car app.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- build: bundle src/main.ts (with the @copilot/* packages) into one file, dist/main.js -------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
# Every workspace manifest, so `npm ci` can check the lockfile.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/vehicle-core/package.json packages/vehicle-core/
COPY packages/event-engine/package.json packages/event-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/ai-core/package.json packages/ai-core/
COPY apps/backend/package.json apps/backend/
COPY car/package.json car/
RUN npm ci --no-audit --no-fund
COPY packages/vehicle-core/src packages/vehicle-core/src
COPY packages/event-engine/src packages/event-engine/src
COPY packages/shared/src packages/shared/src
COPY packages/ai-core/src packages/ai-core/src
# Each package tsconfig extends tsconfig.base.json, whose `paths` map @copilot/* to the package sources. esbuild
# resolves imports made inside packages/* with the nearest tsconfig, so without these files it would leave
# @copilot/* imports external and the runtime image (which has no built packages) could not start.
COPY packages/vehicle-core/tsconfig.json packages/vehicle-core/
COPY packages/event-engine/tsconfig.json packages/event-engine/
COPY packages/shared/tsconfig.json packages/shared/
COPY packages/ai-core/tsconfig.json packages/ai-core/
COPY apps/backend/tsconfig.json apps/backend/
COPY apps/backend/src apps/backend/src
RUN npm run build -w @copilot/backend
# Guard: every @copilot/* package must be inside the bundle, never a runtime require().
RUN if grep -q 'require("@copilot/' apps/backend/dist/main.js; then \
      echo 'dist/main.js still requires an @copilot/* package' >&2; exit 1; \
    fi

# --- runtime: production dependencies only, non-root, database on a volume ----------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/vehicle-core/package.json packages/vehicle-core/
COPY packages/event-engine/package.json packages/event-engine/
COPY packages/shared/package.json packages/shared/
COPY packages/ai-core/package.json packages/ai-core/
COPY apps/backend/package.json apps/backend/
COPY car/package.json car/
# The bundle keeps only third-party packages external (fastify, @fastify/cors, pino, zod, @anthropic-ai/sdk).
RUN npm ci --omit=dev --workspace @copilot/backend --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /app/apps/backend/dist/main.js apps/backend/dist/main.js

# The `node` user (uid 1000) comes with the official image; it owns only the data directory.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/copilot.sqlite
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Exec form: node is PID 1 and receives SIGTERM directly, so `docker stop` triggers the graceful shutdown.
CMD ["node", "apps/backend/dist/main.js"]
