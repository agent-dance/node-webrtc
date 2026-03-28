FROM node:22-alpine
WORKDIR /app
COPY apps/mcp/package.json ./package.json
RUN npm install --omit=dev
COPY apps/mcp/dist ./dist
ENTRYPOINT ["node", "dist/index.js"]
