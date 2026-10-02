// Command ingest runs the connector scheduler: it polls each tenant's
// configured sources, normalises their records to OCSF, and publishes them to
// the stream.
//
// Checkpointing contract (ADR-0002): a cursor advances only after the batch is
// durably acknowledged by Kafka. Delivery is therefore at-least-once, and the
// duplicates that produces are collapsed downstream by ClickHouse rather than
// prevented here — exactly-once across a vendor API boundary is not achievable,
// so we make duplicates harmless instead of pretending otherwise.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	// Readiness is distinct from liveness: a connector whose credentials have
	// been revoked is alive but not ready, and must surface as degraded rather
	// than stalling silently.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})

	srv := &http.Server{
		Addr:              envOr("INGEST_ADDR", ":8101"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info("ingest listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	// TODO(P1-01): start the connector scheduler here.

	<-ctx.Done()
	log.Info("draining in-flight batches before exit")

	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("shutdown", "err", err)
	}
	log.Info("ingest stopped")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
