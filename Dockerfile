# ---- base ----
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# ---- deps ----
FROM base AS deps
# Native build tools: better-sqlite3 compiles from source when no prebuild
# matches; this keeps image builds self-contained on any base.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
# package.json declares "type": "module"; NodeNext requires it to emit ESM.
COPY package.json ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY api ./api
COPY worker ./worker
COPY cli ./cli
COPY dashboard ./dashboard
COPY scripts ./scripts
COPY setup.sh ./
RUN npm run build

FROM build AS test
COPY tests ./tests
COPY vitest.config.ts ./
CMD ["sh", "-c", "npm run typecheck && npm test && npm run build"]

# ---- api runtime ----
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# dist/api/admin-server.js resolves assets at ../dashboard/ (dist/dashboard/).
COPY dashboard ./dist/dashboard
COPY scripts/db-set-setting.mjs ./scripts/db-set-setting.mjs
COPY package.json ./
EXPOSE 3000
CMD ["node", "dist/api/index.js"]

# ---- worker runtime ----
FROM base AS worker
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
CMD ["node", "dist/worker/index.js"]
