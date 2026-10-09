# ADR-0013: fills the KMS seam ADR-0008 built and explicitly left
# unimplemented ("Which real cloud KMS a production deployment uses is
# a separate, not-yet-made decision"). KeyManagementService
# (packages/db/src/crypto/kms.ts, mirrored per Go connector) gets its
# first real backend here — LocalKMS remains untouched as the dev/test
# implementation.

resource "aws_kms_key" "envelope" {
  description             = "Sentinel production KEK — wraps every per-tenant DEK (ADR-0008), and encrypts RDS/S3/Secrets Manager at rest"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "envelope" {
  name          = "alias/${var.cluster_name}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

# One Secrets Manager entry per credential every application workload
# needs — never a committed env file (AC4). External Secrets Operator
# (addons.tf) syncs these into native Kubernetes Secret objects that
# infra/k8s/'s own manifests reference by name.

resource "aws_secretsmanager_secret" "postgres" {
  name       = "${var.cluster_name}/postgres"
  kms_key_id = aws_kms_key.envelope.arn
}

resource "aws_secretsmanager_secret_version" "postgres" {
  secret_id = aws_secretsmanager_secret.postgres.id
  secret_string = jsonencode({
    host     = aws_db_instance.postgres.address
    port     = aws_db_instance.postgres.port
    username = aws_db_instance.postgres.username
    password = random_password.postgres_master.result
    database = aws_db_instance.postgres.db_name
  })
}

resource "random_password" "clickhouse_admin" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "clickhouse" {
  name       = "${var.cluster_name}/clickhouse"
  kms_key_id = aws_kms_key.envelope.arn
}

resource "aws_secretsmanager_secret_version" "clickhouse" {
  secret_id = aws_secretsmanager_secret.clickhouse.id
  secret_string = jsonencode({
    username = "default"
    password = random_password.clickhouse_admin.result
  })
}

# Unlike the three above, this secret's VALUE is never generated or
# known by Terraform — an Anthropic API key is obtained out of band
# from Anthropic's own console and written in once by a human (`aws
# secretsmanager put-secret-value`), deliberately with no
# aws_secretsmanager_secret_version resource here: Terraform owns the
# secret's existence/permissions/rotation policy, never a real
# external vendor credential's actual value, which would otherwise end
# up in plan output and state.
resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name       = "${var.cluster_name}/anthropic-api-key"
  kms_key_id = aws_kms_key.envelope.arn
}

resource "random_password" "redpanda_sasl" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "redpanda" {
  name       = "${var.cluster_name}/redpanda"
  kms_key_id = aws_kms_key.envelope.arn
}

resource "aws_secretsmanager_secret_version" "redpanda" {
  secret_id = aws_secretsmanager_secret.redpanda.id
  secret_string = jsonencode({
    username = "sentinel"
    password = random_password.redpanda_sasl.result
  })
}

# IRSA role the External Secrets Operator assumes to READ (never
# write) these entries — scoped to exactly these three ARNs plus the
# connector envelope-encryption key, not a blanket
# secretsmanager:GetSecretValue on every secret in the account.
data "aws_iam_policy_document" "external_secrets_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:external-secrets:external-secrets"]
    }
  }
}

resource "aws_iam_role" "external_secrets" {
  name               = "${var.cluster_name}-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.external_secrets_assume.json
}

data "aws_iam_policy_document" "external_secrets_read" {
  statement {
    actions = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    effect  = "Allow"
    resources = [
      aws_secretsmanager_secret.postgres.arn,
      aws_secretsmanager_secret.clickhouse.arn,
      aws_secretsmanager_secret.redpanda.arn,
      aws_secretsmanager_secret.anthropic_api_key.arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    effect    = "Allow"
    resources = [aws_kms_key.envelope.arn]
  }
}

resource "aws_iam_role_policy" "external_secrets_read" {
  name   = "secrets-read"
  role   = aws_iam_role.external_secrets.id
  policy = data.aws_iam_policy_document.external_secrets_read.json
}

# IRSA role the cold-tier ClickHouse disk and the backup job assume to
# read/write their own two buckets specifically — not blanket S3
# access.
data "aws_iam_policy_document" "clickhouse_s3_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:sentinel:clickhouse", "system:serviceaccount:sentinel:backup-job"]
    }
  }
}

resource "aws_iam_role" "clickhouse_s3" {
  name               = "${var.cluster_name}-clickhouse-s3"
  assume_role_policy = data.aws_iam_policy_document.clickhouse_s3_assume.json
}

data "aws_iam_policy_document" "clickhouse_s3_access" {
  statement {
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    effect  = "Allow"
    resources = [
      aws_s3_bucket.cold_tier.arn, "${aws_s3_bucket.cold_tier.arn}/*",
      aws_s3_bucket.backups.arn, "${aws_s3_bucket.backups.arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "clickhouse_s3_access" {
  name   = "s3-cold-and-backups"
  role   = aws_iam_role.clickhouse_s3.id
  policy = data.aws_iam_policy_document.clickhouse_s3_access.json
}

# IRSA role services/ingest's own pods assume to write the raw-event
# archive — scoped to that one bucket, not the cold-tier/backups
# buckets ClickHouse's own role above already covers.
data "aws_iam_policy_document" "ingest_s3_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    effect  = "Allow"
    principals {
      type        = "Federated"
      identifiers = [module.eks.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${module.eks.oidc_provider}:sub"
      values   = ["system:serviceaccount:sentinel:ingest"]
    }
  }
}

resource "aws_iam_role" "ingest_s3" {
  name               = "${var.cluster_name}-ingest-s3"
  assume_role_policy = data.aws_iam_policy_document.ingest_s3_assume.json
}

data "aws_iam_policy_document" "ingest_s3_access" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    effect    = "Allow"
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]
  }
}

resource "aws_iam_role_policy" "ingest_s3_access" {
  name   = "s3-archive"
  role   = aws_iam_role.ingest_s3.id
  policy = data.aws_iam_policy_document.ingest_s3_access.json
}
