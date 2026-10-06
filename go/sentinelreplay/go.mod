module github.com/ajeetsingh272/ai-security-analyst/go/sentinelreplay

go 1.23

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream v0.0.0-00010101000000-000000000000
	github.com/aws/aws-sdk-go-v2 v1.32.6
	github.com/aws/aws-sdk-go-v2/credentials v1.17.47
	github.com/aws/aws-sdk-go-v2/service/s3 v1.69.0
	github.com/twmb/franz-go v1.18.0
)

require (
	github.com/ClickHouse/ch-go v0.61.5 // indirect
	github.com/ajeetsingh272/ai-security-analyst/go/sentineldb v0.0.0-00010101000000-000000000000 // indirect
	github.com/andybalholm/brotli v1.1.1 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.6.7 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.3.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.6.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.3.24 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.12.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.4.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.12.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.18.5 // indirect
	github.com/aws/smithy-go v1.22.1 // indirect
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/go-faster/city v1.0.1 // indirect
	github.com/go-faster/errors v0.7.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/pgx/v5 v5.7.2 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/paulmach/orb v0.11.1 // indirect
	github.com/pierrec/lz4/v4 v4.1.30 // indirect
	github.com/pkg/errors v0.9.1 // indirect
	github.com/redis/go-redis/v9 v9.7.0 // indirect
	github.com/segmentio/asm v1.2.0 // indirect
	github.com/shopspring/decimal v1.4.0 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.9.0 // indirect
	go.opentelemetry.io/otel v1.33.0 // indirect
	go.opentelemetry.io/otel/metric v1.33.0 // indirect
	go.opentelemetry.io/otel/trace v1.33.0 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/sys v0.28.0 // indirect
	golang.org/x/text v0.21.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector => ../sentinelconnector

replace github.com/ajeetsingh272/ai-security-analyst/go/sentineldb => ../sentineldb

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream => ../sentinelstream

require (
	github.com/ClickHouse/clickhouse-go/v2 v2.30.0
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents v0.0.0-00010101000000-000000000000
	github.com/twmb/franz-go/pkg/kadm v1.13.0
)

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelevents => ../sentinelevents
