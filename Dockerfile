# ============================================================
# Backspace — Multi-stage Docker build
# ============================================================

# Stage 1: Production dependencies
#
# better-sqlite3 12.x ships a prebuilt binary for Node ABI v137, which is the ABI
# of Node 24. prebuild-install downloads it, so this stage needs no Python and no
# C++ compiler. The runtime stage copies the resulting node_modules and runs no
# install of its own.
#
# The base is node:24-slim, Node v24.20.0. All three stages pin it by the digest
# of the multi-arch index, so the same pin resolves on amd64 and on arm64.
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS deps

RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package.json files for all workspace packages
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Copy patches (referenced by pnpm-lock.yaml)
COPY patches/ patches/

# The production dependency tree that ships in the runtime image
RUN pnpm install --prod --frozen-lockfile

# ============================================================
# Stage 2: Build the frontend
#
# Installs only @backspace/web and what it depends on (@backspace/shared). That
# keeps the server dependencies, better-sqlite3 among them, out of this stage, so
# the native module is fetched once, in `deps`.
#
# Base: node:24-slim, Node v24.20.0.
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS builder

RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package.json files for all workspace packages
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Copy patches (referenced by pnpm-lock.yaml)
COPY patches/ patches/

RUN pnpm install --frozen-lockfile --filter @backspace/web...

# Copy source code (excluding desktop — not needed in Docker)
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

# Build the web frontend
RUN pnpm --filter @backspace/web build

# ============================================================
# Stage 3: Production runtime
#
# Base: node:24-slim, Node v24.20.0.
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS runtime

RUN corepack enable && corepack prepare pnpm@10.34.3 --activate

# Runtime deps only: ffmpeg (media processing) + gosu (drop to non-root in the
# entrypoint). No C toolchain. The native modules come from `deps` as prebuilt
# binaries and are copied in below.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg gosu && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package.json files
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Copy shared source (needed at runtime since server imports types directly)
COPY packages/shared/ packages/shared/

# Copy server source
COPY packages/server/ packages/server/

# Production dependencies, built in the `deps` stage. All of pnpm's symlinks are
# relative to /app, so the tree works unchanged after the copy.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/server/node_modules packages/server/node_modules

# Copy built frontend from builder stage
COPY --from=builder /app/packages/web/dist packages/web/dist

# Create data directories
RUN mkdir -p /app/data/uploads

# Non-root hardening: copy the privilege-dropping entrypoint. It chowns the
# data volume as root, then execs the CMD as the unprivileged `node` user.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/backspace.db
ENV UPLOAD_DIR=/app/data/uploads

# AGPL-3.0 § 13 source offer: bake the running build's git commit into the image
# so GET /api/instance/info can advertise the exact version. Passed via
# --build-arg BACKSPACE_COMMIT=$(git rev-parse --short HEAD) (see deploy.sh /
# docker-compose.yml). Empty when git is unavailable → server treats as null.
ARG BACKSPACE_COMMIT=""
ENV BACKSPACE_COMMIT=$BACKSPACE_COMMIT

EXPOSE 3000

# Health check — reads PORT from environment so it works with any configured port
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server using tsx from the server package directory
WORKDIR /app/packages/server
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
