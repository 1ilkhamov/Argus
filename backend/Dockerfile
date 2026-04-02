FROM node:22-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps chromium
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/data /app/dist/agent/identity/config
COPY --from=builder /app/src/agent/identity/config/soul.default.yml ./dist/agent/identity/config/soul.default.yml
COPY .env.example ./.env.example
EXPOSE 3000
CMD ["node", "dist/main"]
