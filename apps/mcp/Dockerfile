FROM node:22-alpine AS builder
WORKDIR /app

# Copy source files needed for compilation
COPY apps/mcp/package.json ./
COPY apps/mcp/tsconfig.json ./
COPY apps/mcp/src ./src

# Install all deps (including devDependencies for tsc)
RUN npm install

# Compile TypeScript
RUN npm run build

# ── Runtime stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY apps/mcp/package.json ./

# Install production deps only
RUN npm install --omit=dev

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
