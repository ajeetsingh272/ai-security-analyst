// Command detect evaluates normalised events against the compiled rule corpus.
//
// Rules are compiled to Go at build time (ADR-0004) rather than interpreted
// from YAML at runtime, which is roughly an order of magnitude cheaper per
// event — the difference between a three-node and a thirty-node detection tier
// at 30k EPS.
//
// Rules marked critical publish to the alert channel directly, in parallel with
// entering correlation. That bypass is what keeps the customer warned when the
// AI analyst is unavailable (product guarantee TG4).
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

	srv := &http.Server{
		Addr:              envOr("DETECT_ADDR", ":8102"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Info("detect listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("listen failed", "err", err)
			stop()
		}
	}()

	// TODO(P2-04): consume events.normalized and evaluate the compiled corpus.
	// TODO(P2-08): wire the critical-severity bypass to the alert channel.

	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdown); err != nil {
		log.Error("shutdown", "err", err)
	}
	log.Info("detect stopped")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
