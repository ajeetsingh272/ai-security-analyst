module github.com/ajeetsingh272/ai-security-analyst/services/ingest

go 1.23

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentineldb v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream v0.0.0-00010101000000-000000000000
	github.com/aws/aws-sdk-go-v2 v1.32.6
	github.com/aws/aws-sdk-go-v2/credentials v1.17.47
	github.com/aws/aws-sdk-go-v2/service/s3 v1.69.0
	github.com/jackc/pgx/v5 v5.7.2
	github.com/redis/go-redis/v9 v9.7.0
	github.com/twmb/franz-go v1.18.0
	go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp v0.58.0
	go.opentelemetry.io/otel v1.33.0
	go.opentelemetry.io/otel/metric v1.33.0
)

require (
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.6.7 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.3.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.6.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.3.25 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.12.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.4.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.12.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.18.5 // indirect
	github.com/aws/smithy-go v1.22.1 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/felixge/httpsnoop v1.0.4 // indirect
	github.com/go-logr/logr v1.4.2 // indirect
	github.com/go-logr/stdr v1.2.2 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.24.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/pierrec/lz4/v4 v4.1.30 // indirect
	github.com/twmb/franz-go/pkg/kadm v1.13.0 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.9.0 // indirect
	go.opentelemetry.io/auto/sdk v1.1.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc v1.33.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace v1.33.0 // indirect
	go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc v1.33.0 // indirect
	go.opentelemetry.io/otel/sdk v1.33.0 // indirect
	go.opentelemetry.io/otel/sdk/metric v1.33.0 // indirect
	go.opentelemetry.io/otel/trace v1.33.0 // indirect
	go.opentelemetry.io/proto/otlp v1.4.0 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/net v0.32.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/sys v0.28.0 // indirect
	golang.org/x/text v0.21.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20241209162323-e6fa225c2576 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20241209162323-e6fa225c2576 // indirect
	google.golang.org/grpc v1.68.1 // indirect
	google.golang.org/protobuf v1.35.2 // indirect
)

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelobs => ../../go/sentinelobs

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector => ../../go/sentinelconnector

replace github.com/ajeetsingh272/ai-security-analyst/go/sentineldb => ../../go/sentineldb

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream => ../../go/sentinelstream
