variable "region" {
  description = "ADR-0013: AWS ap-south-1 (Mumbai) — matches every existing cost/pricing assumption in packages/billing and the dev stack's own AWS_DEFAULT_REGION."
  type        = string
  default     = "ap-south-1"
}

variable "environment" {
  description = "Deployment environment name, used as a resource-name/tag suffix."
  type        = string
  default     = "production"
}

variable "cluster_name" {
  type    = string
  default = "sentinel-prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "availability_zone_count" {
  description = "ADR-0013 Alternative D: 3 AZs, not 1 — a single-AZ failure must not take down every tenant sharing this cluster."
  type        = number
  default     = 3
}

variable "eks_node_instance_types" {
  description = "General-purpose node group for the 7 Sentinel application workloads (ingest/detect/correlate/eventwriter/api/dashboard/analyst)."
  type        = list(string)
  default     = ["m6i.xlarge"]
}

variable "eks_node_min_size" {
  type    = number
  default = 3
}

variable "eks_node_max_size" {
  description = "Ceiling for the general app-workload node group. The stateful-service node group (ClickHouse/Redpanda/Valkey) is sized separately in addons.tf."
  type        = number
  default     = 12
}

variable "rds_instance_class" {
  type    = string
  default = "db.r6g.xlarge"
}

variable "rds_allocated_storage_gb" {
  type    = number
  default = 200
}

variable "rds_backup_retention_days" {
  description = "P7-09's own RPO input for the control-plane Postgres."
  type        = number
  default     = 14
}

variable "clickhouse_hot_volume_gb" {
  description = "Per-node EBS gp3 size for ClickHouse's hot-tier StatefulSet volumes — ADR-0005's own ~4.5TB/90-day sizing, split across the stateful node group."
  type        = number
  default     = 500
}

variable "cold_storage_bucket_name" {
  description = "Must match db/clickhouse/0001_events.sql's own Production tiering comment and infra/docker/clickhouse-storage.xml's dev bucket name exactly — ClickHouse's storage policy references this bucket by name, not by a Terraform-generated one."
  type        = string
  default     = "sentinel-cold"
}

variable "backup_bucket_name" {
  description = "P7-09's own target for Postgres/ClickHouse backup artifacts."
  type        = string
  default     = "sentinel-backups"
}

variable "archive_bucket_name" {
  description = "Matches services/ingest/cmd/ingest/main.go's own S3_ARCHIVE_BUCKET default exactly — the raw-event archive go/sentinelconnector's S3ArchiveWriter/S3RawArchiveWriter already write to in code, never provisioned as real infrastructure until this file."
  type        = string
  default     = "sentinel-archive"
}
