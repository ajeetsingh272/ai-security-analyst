# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f apps/dashboard/Dockerfile -t sentinel-dashboard .
# Same turbo-prune + pnpm pattern as apps/api/Dockerfile — see that
# file's own doc comment for why the whole monorepo is the build
# context.

FROM node:22-alpine AS pruner
WORKDIR /app
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @sentinel/dashboard --docker

FROM node:22-alpine AS installer
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` doesn't trace tsconfig.base.json's own "extends"
# reference (not a package.json edge) — see apps/api/Dockerfile's own
# identical comment, found the same way building that image first.
COPY tsconfig.base.json ./
RUN pnpm turbo run build --filter=@sentinel/dashboard

FROM node:22-alpine AS runner
WORKDIR /app
RUN addgroup --system --gid 1001 sentinel && adduser --system --uid 1001 sentinel
COPY --from=installer --chown=sentinel:sentinel /app .
USER sentinel
WORKDIR /app/apps/dashboard
EXPOSE 3000
# AC2: GET /api/health (src/app/api/health/route.ts) is this app's own
# liveness/readiness target.
CMD ["node_modules/.bin/next", "start"]
