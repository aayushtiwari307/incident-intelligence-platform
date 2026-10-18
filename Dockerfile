FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
WORKDIR /app
COPY . .
RUN npm run build -w @platform/shared
RUN npm run build -w @platform/api
RUN NEXT_PUBLIC_API_URL="" NEXT_PUBLIC_REALTIME_ENABLED=false npm run build -w @platform/web
RUN npm prune --omit=dev --no-audit --no-fund

FROM caddy:2.8.4-alpine AS caddy

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    API_HOST=127.0.0.1 \
    API_PORT=3001 \
    WEB_PORT=3000 \
    HOSTNAME=127.0.0.1 \
    PORT=10000
WORKDIR /app
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --chown=node:node scripts/deploy/combined-runtime.mjs ./scripts/deploy/combined-runtime.mjs
COPY --chown=node:node scripts/deploy/runtime-config.mjs ./scripts/deploy/runtime-config.mjs
COPY --chown=node:node deploy/render/Caddyfile ./deploy/render/Caddyfile
USER node
EXPOSE 10000
CMD ["node", "scripts/deploy/combined-runtime.mjs"]
