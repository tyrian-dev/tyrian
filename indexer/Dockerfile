FROM oven/bun:1.2-alpine AS runner
WORKDIR /app

# 1. Copy root workspace definition and all workspace manifests so Bun can resolve all declared members
COPY package.json bun.lock* tsconfig.base.json ./
COPY frontend/package.json ./frontend/package.json
COPY backend/package.json ./backend/package.json
COPY shared/package.json ./shared/package.json
COPY indexer/package.json ./indexer/package.json
COPY contracts/package.json ./contracts/package.json

# 2. Copy source code needed for indexer & shared modules
COPY config ./config
COPY shared ./shared
COPY indexer ./indexer

# 3. Install dependencies across the workspace
RUN bun install --frozen-lockfile

WORKDIR /app/indexer

EXPOSE 42069
ENV PORT=42069
ENV NODE_ENV=production

CMD ["bun", "run", "start"]
