FROM node:24-slim AS builder
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ARG VITE_SERVER_URL
ARG VITE_BRAND_NAME=Northwind
ARG VITE_WEB_URL=http://localhost:3001
ARG VITE_ENABLE_INDEXING=false
ARG VITE_POSTHOG_PROJECT_TOKEN
# Empty uses POSTHOG_BROWSER_PROXY_HOST from packages/env/src/posthog-hosts.ts.
ARG VITE_POSTHOG_HOST
ARG BUILD_SHA=development
ENV VITE_SERVER_URL=${VITE_SERVER_URL}
ENV VITE_BRAND_NAME=${VITE_BRAND_NAME}
ENV VITE_WEB_URL=${VITE_WEB_URL}
ENV VITE_ENABLE_INDEXING=${VITE_ENABLE_INDEXING}
ENV VITE_POSTHOG_PROJECT_TOKEN=${VITE_POSTHOG_PROJECT_TOKEN}
ENV VITE_POSTHOG_HOST=${VITE_POSTHOG_HOST}
ENV NODE_ENV=production
RUN cd apps/web && bun run build

FROM node:24-slim AS runner
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

ARG BUILD_SHA=development
ENV BUILD_SHA=${BUILD_SHA}
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3001

COPY --from=builder --chown=node:node /app/apps/web/.output ./.output

USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=5 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3001/version.json').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", ".output/server/index.mjs"]
