data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# RDS PostgreSQL -- db.t4g.micro, single-AZ, gp3. publicly_accessible and
# storage_encrypted are explicit here, not assumed defaults -- exactly the
# kind of setting that silently drifted unsafe on the old VPS.
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${var.project}-db"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${var.project}-db-subnet-group" }
}

resource "random_password" "db" {
  length  = 32
  special = false # avoid characters that need URL-encoding in DATABASE_URL
}

resource "aws_db_instance" "main" {
  identifier     = "${var.project}-prod"
  engine         = "postgres"
  engine_version = var.postgres_version

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage_gb
  storage_type           = "gp3"
  storage_encrypted      = true
  publicly_accessible    = false
  multi_az               = false # deferred until real traffic/revenue justifies it, per plan
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.db_security_group_id]

  db_name  = "aexa"
  username = "aexa_app"
  password = random_password.db.result

  backup_retention_period = 7
  deletion_protection     = true
  skip_final_snapshot     = false
  final_snapshot_identifier = "${var.project}-prod-final-snapshot"

  tags = { Name = "${var.project}-prod-db" }
}

# ---------------------------------------------------------------------------
# ElastiCache Redis -- cache.t4g.micro, single node (no replication --
# BullMQ/session/rate-limit state only, not source-of-truth data).
# Uses a replication group (not aws_elasticache_cluster) because
# transit encryption is only configurable at that resource level.
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "random_password" "redis_auth" {
  length  = 32
  special = false # ElastiCache AUTH tokens disallow most special characters
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project}-redis"
  description           = "aexa-server BullMQ / session / rate-limit store."

  engine         = "redis"
  node_type      = var.redis_node_type
  num_cache_clusters = 1

  subnet_group_name = aws_elasticache_subnet_group.main.name
  security_group_ids = [var.redis_security_group_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result

  automatic_failover_enabled = false # single node -- no standby to fail over to

  tags = { Name = "${var.project}-redis" }
}

# ---------------------------------------------------------------------------
# AWS Config guardrail: rds-instance-public-access-check. Scoped to just
# RDS instances (not ALL_SUPPORTED) to keep recording cost minimal --
# this exists specifically to catch a future drift back to publicly
# accessible, not as a general compliance dashboard.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "config" {
  bucket = "${var.project}-config-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "config" {
  bucket = aws_s3_bucket.config.id
  rule {
    id     = "expire-old-snapshots"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
  }
}

data "aws_iam_policy_document" "config_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "config" {
  name               = "${var.project}-config-recorder"
  assume_role_policy = data.aws_iam_policy_document.config_assume.json
}

resource "aws_iam_role_policy_attachment" "config_managed" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

data "aws_iam_policy_document" "config_s3" {
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.config.arn}/*"]
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
  statement {
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.config.arn]
  }
}

resource "aws_iam_role_policy" "config_s3" {
  name   = "${var.project}-config-s3"
  role   = aws_iam_role.config.id
  policy = data.aws_iam_policy_document.config_s3.json
}

resource "aws_config_configuration_recorder" "main" {
  name     = "${var.project}-recorder"
  role_arn = aws_iam_role.config.arn

  recording_group {
    all_supported                 = false
    resource_types                = ["AWS::RDS::DBInstance"]
    include_global_resource_types = false
  }
}

resource "aws_config_delivery_channel" "main" {
  name           = "${var.project}-delivery"
  s3_bucket_name = aws_s3_bucket.config.id

  depends_on = [aws_config_configuration_recorder.main]
}

resource "aws_config_configuration_recorder_status" "main" {
  name       = aws_config_configuration_recorder.main.name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.main]
}

resource "aws_config_config_rule" "rds_public_access" {
  name = "${var.project}-rds-instance-public-access-check"

  source {
    owner             = "AWS"
    source_identifier = "RDS_INSTANCE_PUBLIC_ACCESS_CHECK"
  }

  depends_on = [aws_config_configuration_recorder.main]
}
