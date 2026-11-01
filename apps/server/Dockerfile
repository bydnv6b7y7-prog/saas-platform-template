# Workspace manifests only, so the dependency layer below is rebuilt when dependencies change, not on every source edit.
FROM node:24-slim AS manifests
WORKDIR /src
COPY . .
RUN mkdir /out && cp package.json bun.lock bunfig.toml /out/ \
  && for manifest in apps/*/package.json packages/*/package.json; do mkdir -p "/out/$(dirname "$manifest")" && cp "$manifest" "/out/$manifest"; done

FROM node:24-slim AS base
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
ENV SKIP_ENV_VALIDATION=1
# Everything under /app belongs to node, as the process (migration, API, worker, CLIs) runs as node;
# installing as node avoids a recursive chown that would copy node_modules into another layer.
RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app

COPY --from=manifests --chown=node:node /out/ ./
RUN --mount=type=cache,target=/home/node/.bun/install/cache,uid=1000,gid=1000 bun install --frozen-lockfile

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV COPILOTKIT_TELEMETRY_DISABLED=true
ARG BUILD_SHA=development
ARG BUILD_TIME=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}
RUN cd apps/server && bun run build && mkdir -p /app/apps/server/data
ENV SKIP_ENV_VALIDATION=

EXPOSE 3000

WORKDIR /app/apps/server

# Schema changes run in a separate, reviewed migration job before this process starts.
CMD ["bun", "dist/index.mjs"]
