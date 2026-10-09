# ADR-0013: the cold-tier bucket ClickHouse's own storage policy
# (P7-05) references by name, the Postgres/ClickHouse backup bucket
# P7-09 writes to, and the raw-ingest archive bucket
# services/ingest/cmd/ingest/main.go already reads (S3_ARCHIVE_BUCKET,
# default "sentinel-archive") but which this repo had never actually
# provisioned anywhere until this file. All three: private, encrypted,
# versioned.

resource "aws_s3_bucket" "cold_tier" {
  bucket = var.cold_storage_bucket_name
}

resource "aws_s3_bucket_versioning" "cold_tier" {
  bucket = aws_s3_bucket.cold_tier.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cold_tier" {
  bucket = aws_s3_bucket.cold_tier.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.envelope.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "cold_tier" {
  bucket                  = aws_s3_bucket.cold_tier.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# P7-09: a 365-day lifecycle mirrors db/clickhouse's own table-level
# TTL DELETE ceiling exactly — once ClickHouse itself would have
# deleted a partition anyway, there is no reason for the S3 object
# backing it to outlive that by policy, only by the time it takes the
# lifecycle rule to run.
resource "aws_s3_bucket_lifecycle_configuration" "cold_tier" {
  bucket = aws_s3_bucket.cold_tier.id
  rule {
    id     = "expire-past-ttl-ceiling"
    status = "Enabled"
    filter {} # applies to every object in the bucket — required explicitly since provider v5+ no longer infers it from an empty rule
    expiration {
      days = 365
    }
  }
}

resource "aws_s3_bucket" "backups" {
  bucket = var.backup_bucket_name
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.envelope.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# P7-09's own RPO/RTO: backups are retained 90 days, then expired —
# long enough to cover "restore from three months ago" without this
# bucket growing unboundedly against daily full + incremental backups.
resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-after-90-days"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

resource "aws_s3_bucket" "archive" {
  bucket = var.archive_bucket_name
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.envelope.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket                  = aws_s3_bucket.archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# No expiration rule — this is the durable raw-event archive
# go/sentinelconnector's own S3ArchiveWriter/S3RawArchiveWriter write
# to, kept for as long as compliance/replay needs it, not governed by
# the same 90/365-day ceilings the OPERATIONAL cold tier and backups
# buckets use.
