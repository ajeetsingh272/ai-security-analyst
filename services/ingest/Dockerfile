# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f services/ingest/Dockerfile -t sentinel-ingest .
# Needs the whole monorepo as context because go.work lists every
# services/* module by path — building even ONE of them requires every
# module go.work references to resolve, not just the one being built
# (confirmed the hard way: `go build` refused to run with sibling
# services/* directories missing, even though this binary never
# imports their code) — the same reason the TS Dockerfiles need the
# full pnpm workspace, not just one app's own directory.

FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.work go.work.sum ./
COPY go/ go/
COPY services/ services/
WORKDIR /src/services/ingest
RUN CGO_ENABLED=0 go build -o /out/ingest ./cmd/ingest

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/ingest /ingest
EXPOSE 8101
# AC2: GET /healthz, GET /readyz (cmd/ingest/main.go, pre-existing).
ENTRYPOINT ["/ingest"]
