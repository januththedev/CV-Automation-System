# ---- base ----
FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# ---- build ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY api ./api
COPY worker ./worker
COPY cli ./cli
RUN npx tsc -p tsconfig.build.json

# ---- api runtime ----
FROM base AS api
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY dashboard ./dashboard
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
