FROM node:24-slim AS base
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
COPY packages/better-auth-app-store/certs/AppleRootCA-G3.cer /app/packages/better-auth-app-store/certs/AppleRootCA-G3.cer
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

ENV NODE_ENV=production
ENV COPILOTKIT_TELEMETRY_DISABLED=true
ARG BUILD_SHA=development
ARG BUILD_TIME=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
RUN cd apps/server && bun run build
ENV SKIP_ENV_VALIDATION=

# 非 root 运行（最佳实践）；node 镜像自带 node 用户；制品目录归 node，命名卷挂载继承所有权
RUN chown -R node:node /app && mkdir -p /app/apps/server/data && chown -R node:node /app/apps/server/data

EXPOSE 3000

USER node
WORKDIR /app/apps/server

# Schema changes run in a separate, reviewed migration job before this process starts.
CMD ["bun", "dist/index.mjs"]
