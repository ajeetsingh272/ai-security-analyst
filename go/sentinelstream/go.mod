module github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream

go 1.23

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector v0.0.0-00010101000000-000000000000
	github.com/twmb/franz-go v1.18.0
	github.com/twmb/franz-go/pkg/kadm v1.13.0
)

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentineldb v0.0.0-00010101000000-000000000000 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/pgx/v5 v5.7.2 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/pierrec/lz4/v4 v4.1.30 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.9.0 // indirect
	go.opentelemetry.io/otel v1.33.0 // indirect
	go.opentelemetry.io/otel/metric v1.33.0 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector => ../sentinelconnector

replace github.com/ajeetsingh272/ai-security-analyst/go/sentineldb => ../sentineldb
