# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f services/correlate/Dockerfile -t sentinel-correlate .

# Needs the whole monorepo as context — go.work lists every
# services/* module by path, and `go build` refuses to run if any of
# them is missing from the workspace, even one this binary never
# imports. Confirmed the hard way while writing services/ingest's own
# Dockerfile.

FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.work go.work.sum ./
COPY go/ go/
COPY services/ services/
WORKDIR /src/services/correlate
RUN CGO_ENABLED=0 go build -o /out/correlate ./cmd/correlate

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/correlate /correlate
EXPOSE 8103
# AC2: GET /healthz, GET /readyz (cmd/correlate/main.go, pre-existing).
ENTRYPOINT ["/correlate"]
