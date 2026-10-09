# P7-06 / ADR-0013. Build from the REPO ROOT, not this directory:
#   docker build -f apps/api/Dockerfile -t sentinel-api .
# Needs the whole monorepo as context because `turbo prune` resolves
# this app's own workspace dependencies (packages/db, packages/schema,
# etc.) before pruning everything else away — the standard Turborepo
# + pnpm production-image pattern, not invented for this app alone.
#
# Never built or pushed to a real registry in this sandbox (no cloud
# credentials) — `docker build` itself is real and locally checkable;
# see infra/README.md's own verification-status section.

FROM node:22-alpine AS pruner
WORKDIR /app
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @sentinel/api --docker

FROM node:22-alpine AS installer
WORKDIR /app
RUN npm install -g pnpm@10.18.0
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
# `turbo prune` traces package.json workspace edges only — it does not
# see tsconfig.base.json's own "extends" reference from every package,
# since that is not a package.json dependency. Confirmed the hard way:
# the build fails with "Cannot read file '/app/tsconfig.base.json'"
# without this.
COPY tsconfig.base.json ./
# Still run the real build as a compile-gate (a broken build must fail
# the image, not just be skipped) — but see this file's own CMD
# comment below for why it is NOT what the container actually runs.
RUN pnpm turbo run build --filter=@sentinel/api

FROM node:22-alpine AS runner
WORKDIR /app
RUN npm install -g tsx@4.19.2
RUN addgroup --system --gid 1001 sentinel && adduser --system --uid 1001 sentinel
COPY --from=installer --chown=sentinel:sentinel /app .
USER sentinel
WORKDIR /app/apps/api
EXPOSE 4000
# AC2: apps/api/src/app.ts already registers real GET /health and
# GET /ready routes — infra/k8s/api.yaml's own liveness/readiness
# probes point at these, not invented endpoints.
#
# Deliberately `tsx src/server.ts`, NOT `node dist/server.js`
# (package.json's own "start" script) — a REAL, FOUND gap, not a
# style choice: every workspace package in this monorepo (packages/db
# included) points its own package.json "main"/"exports" directly at
# TypeScript source (./src/index.ts), which only resolves at runtime
# because `tsx`'s dev loader transpiles it on the fly. `node
# dist/server.js` crashes immediately in a real container with no tsx
# loader active ("Cannot find module '.../schema.js'") — confirmed by
# actually running the built image, not assumed. The correct, durable
# fix is conditional package.json exports (an "import"/"development"
# vs. "default" condition pointing at dist/ in production) across
# every workspace package — out of this ticket's own safe blast
# radius to do silently across 15+ packages; disclosed here and in
# infra/README.md as real follow-up work, not hidden by this
# workaround. apps/analyst already ships via tsx too, so this is not a
# new pattern for this repo, just now applied to apps/api's image as
# the one that actually works today.
CMD ["tsx", "src/server.ts"]
