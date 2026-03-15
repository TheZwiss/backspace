# ============================================================
# Backspace — Multi-stage Docker build
# ============================================================

# Stage 1: Install dependencies and build frontend
FROM node:20-slim AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package.json files for all workspace packages
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code (excluding desktop — not needed in Docker)
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/

# Build the web frontend
RUN pnpm --filter @backspace/web build

# ============================================================
# Stage 2: Production runtime
FROM node:20-slim AS runtime

RUN corepack enable && corepack prepare pnpm@latest --activate

# Install build dependencies for better-sqlite3 native module
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.base.json ./

# Copy package.json files
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# Install production dependencies only (plus tsx for running TS)
RUN pnpm install --frozen-lockfile || pnpm install

# Copy shared source (needed at runtime since server imports types directly)
COPY packages/shared/ packages/shared/

# Copy server source
COPY packages/server/ packages/server/

# Copy built frontend from builder stage
COPY --from=builder /app/packages/web/dist packages/web/dist

# Create data directories
RUN mkdir -p /app/data/uploads

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/backspace.db
ENV UPLOAD_DIR=/app/data/uploads

EXPOSE 3000

# Health check — reads PORT from environment so it works with any configured port
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 3000) + '/api/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Run the server using tsx from the server package directory
WORKDIR /app/packages/server
CMD ["node", "--import", "tsx/esm", "src/index.ts"]
