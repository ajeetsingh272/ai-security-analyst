module github.com/ajeetsingh272/ai-security-analyst/services/correlate

go 1.23

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentineldb v0.0.0-00010101000000-000000000000
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.7.2
)

require (
	github.com/aws/aws-sdk-go-v2 v1.32.6 // indirect
	github.com/aws/aws-sdk-go-v2/aws/protocol/eventstream v1.6.7 // indirect
	github.com/aws/aws-sdk-go-v2/internal/configsources v1.3.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/endpoints/v2 v2.6.25 // indirect
	github.com/aws/aws-sdk-go-v2/internal/v4a v1.3.25 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding v1.12.1 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/checksum v1.4.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/presigned-url v1.12.6 // indirect
	github.com/aws/aws-sdk-go-v2/service/internal/s3shared v1.18.5 // indirect
	github.com/aws/aws-sdk-go-v2/service/s3 v1.69.0 // indirect
	github.com/aws/smithy-go v1.22.1 // indirect
	github.com/cespare/xxhash/v2 v2.2.0 // indirect
	github.com/dgryski/go-rendezvous v0.0.0-20200823014737-9f7001d12a5f // indirect
	github.com/klauspost/compress v1.17.11 // indirect
	github.com/pierrec/lz4/v4 v4.1.30 // indirect
	github.com/redis/go-redis/v9 v9.7.0 // indirect
	github.com/twmb/franz-go/pkg/kadm v1.13.0 // indirect
	github.com/twmb/franz-go/pkg/kmsg v1.9.0 // indirect
	go.opentelemetry.io/otel v1.33.0 // indirect
	go.opentelemetry.io/otel/metric v1.33.0 // indirect
)

require (
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector v0.0.0-00010101000000-000000000000 // indirect
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal v0.0.0-00010101000000-000000000000
	github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream v0.0.0-00010101000000-000000000000
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/twmb/franz-go v1.18.0
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)

replace github.com/ajeetsingh272/ai-security-analyst/go/sentineldb => ../../go/sentineldb

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelstream => ../../go/sentinelstream

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelsignal => ../../go/sentinelsignal

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelconnector => ../../go/sentinelconnector

replace github.com/ajeetsingh272/ai-security-analyst/go/sentinelaudit => ../../go/sentinelaudit
