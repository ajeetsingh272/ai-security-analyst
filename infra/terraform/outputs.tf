output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "postgres_address" {
  value = aws_db_instance.postgres.address
}

output "cold_tier_bucket" {
  value = aws_s3_bucket.cold_tier.bucket
}

output "backups_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "envelope_kms_key_arn" {
  value = aws_kms_key.envelope.arn
}
