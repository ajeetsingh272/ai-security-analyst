# ADR-0013: RDS for the control-plane Postgres — NOT a reversal of
# ADR-0005 (which chose ClickHouse over an OLTP store for EVENT data
# specifically, and says nothing about the control plane's own
# database). Multi-AZ, encrypted, automated backups — P7-09's own RPO
# input.

resource "aws_db_subnet_group" "postgres" {
  name       = "${var.cluster_name}-postgres"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "postgres" {
  name        = "${var.cluster_name}-postgres"
  description = "Postgres access from the EKS cluster's own node security group only"
  vpc_id      = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "random_password" "postgres_master" {
  length  = 32
  special = false # avoid characters RDS's own master-password charset rejects; Secrets Manager stores the real value either way
}

# ADR-0013: never a plaintext env file — the generated password goes
# straight into Secrets Manager (secrets.tf), and the only thing
# referencing random_password.postgres_master directly is the RDS
# resource itself.
resource "aws_db_instance" "postgres" {
  identifier     = "${var.cluster_name}-postgres"
  engine         = "postgres"
  engine_version = "16.4"
  instance_class = var.rds_instance_class

  allocated_storage     = var.rds_allocated_storage_gb
  max_allocated_storage = var.rds_allocated_storage_gb * 3 # storage autoscaling ceiling
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.envelope.arn

  db_name  = "sentinel"
  username = "sentinel"
  password = random_password.postgres_master.result

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.postgres.name
  vpc_security_group_ids = [aws_security_group.postgres.id]

  backup_retention_period = var.rds_backup_retention_days
  backup_window           = "17:00-18:00" # 22:30-23:30 IST — low-traffic window for an India-market product
  maintenance_window      = "sun:18:00-sun:19:00"

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.cluster_name}-postgres-final"

  performance_insights_enabled = true
}
