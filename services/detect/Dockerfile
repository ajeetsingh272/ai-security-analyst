# P7-06 / ADR-0013. Build from the REPO ROOT:
#   docker build -f services/detect/Dockerfile -t sentinel-detect .
#
# cmd/detect/main.go's own corpusDir() walks UP from its working
# directory looking for a go.work file, then reads <that dir>/
# detections/rules — a dev-time convenience for running this binary
# from different checkout locations, NOT something this Dockerfile
# changes. Instead of patching that logic for production, the final
# image's own layout simply satisfies it unmodified: an empty go.work
# marker at /app/go.work, the real detections/ corpus at
# /app/detections/, and the binary run with its working directory at
# /app/services/detect — one level down, exactly matching the
# monorepo's own real relative structure, so the existing walk-up
# finds /app/go.work and resolves /app/detections/rules correctly.

# Also needs the whole monorepo as context for the same go.work
# reason the other three services' Dockerfiles disclose (confirmed the
# hard way while building services/ingest's own image).

FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.work go.work.sum ./
COPY go/ go/
COPY services/ services/
WORKDIR /src/services/detect
RUN CGO_ENABLED=0 go build -o /out/detect ./cmd/detect

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app/services/detect
COPY --from=builder /out/detect /app/services/detect/detect
COPY go.work /app/go.work
COPY detections/ /app/detections/
EXPOSE 8104
# AC2: GET /healthz, GET /readyz (cmd/detect/main.go, pre-existing).
ENTRYPOINT ["/app/services/detect/detect"]
