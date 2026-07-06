# ── Stage 1: Frontend bauen ──────────────────────────────────
FROM node:20-alpine AS webbuild
WORKDIR /web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── Stage 2: Server ──────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/src ./src
COPY --from=webbuild /web/dist ./public
EXPOSE 3000
CMD ["node", "src/index.js"]
