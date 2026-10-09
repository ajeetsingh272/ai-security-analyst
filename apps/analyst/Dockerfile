# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f apps/analyst/Dockerfile -t sentinel-analyst .
#
# Unlike apps/api/dashboard, this app's own "start" script
# (package.json) runs `tsx src/main.ts` directly against source, not a
# compiled dist/ bundle — tsx is a devDependency here, so this image
# installs dev dependencies too rather than inventing a different,
# untested production entrypoint this app doesn't actually use.
# Flagged here rather than silently "fixed", since changing that is a
# package.json/build-pipeline decision outside this ticket's own scope.

FROM node:22-alpine AS pruner
WORKDIR /app
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @sentinel/analyst --docker

FROM node:22-alpine AS runner
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# tsconfig.base.json, same reason as apps/api/Dockerfile's own
# identical comment — tsx's own loader reads this app's tsconfig.json,
# which extends it.
COPY tsconfig.base.json ./
RUN addgroup --system --gid 1001 sentinel && adduser --system --uid 1001 sentinel
RUN chown -R sentinel:sentinel /app
USER sentinel
WORKDIR /app/apps/analyst
EXPOSE 8105
# AC2: GET /health on ANALYST_HEALTH_PORT (src/main.ts's own embedded
# health server, added in this same ticket for exactly this purpose).
CMD ["pnpm", "start"]
