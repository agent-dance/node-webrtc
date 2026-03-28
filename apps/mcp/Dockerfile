FROM node:22-alpine
WORKDIR /app

# Copy only the mcp app's package files
COPY apps/mcp/package.json ./
COPY pnpm-lock.yaml ./

# Install production deps only (no pnpm needed, use npm)
RUN npm install --omit=dev

# Copy compiled output
COPY apps/mcp/dist ./dist

ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
