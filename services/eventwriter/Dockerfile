# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f services/eventwriter/Dockerfile -t sentinel-eventwriter .

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
WORKDIR /src/services/eventwriter
RUN CGO_ENABLED=0 go build -o /out/eventwriter ./cmd/eventwriter

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /out/eventwriter /eventwriter
EXPOSE 8102
# AC2: GET /healthz, GET /readyz (cmd/eventwriter/main.go, pre-existing).
ENTRYPOINT ["/eventwriter"]
