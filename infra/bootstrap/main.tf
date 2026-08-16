# One-time bootstrap: creates the S3 bucket + DynamoDB table that the real
# environments/prod config uses as its remote state backend. This module's
# own state is intentionally local (see README.md in this directory) --
# a remote backend can't bootstrap itself.

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}

# ---------------------------------------------------------------------------
# Terraform state bucket
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "tf_state" {
  bucket = "qiyrix-terraform-state-${data.aws_caller_identity.current.account_id}"

  # State files can contain resource ARNs, IDs, and metadata worth
  # protecting even though secrets themselves live in Secrets Manager, not
  # in Terraform state directly.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ---------------------------------------------------------------------------
# No DynamoDB lock table: Terraform 1.10+ supports native S3 locking
# (backend "s3" { use_lockfile = true }), so a separate lock table is
# unnecessary overhead for a single-operator setup.
# ---------------------------------------------------------------------------
# Billing alarm -- set up now, not after the first surprise bill.
# Billing metrics only publish from us-east-1 regardless of which region
# resources actually live in.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "billing_alerts" {
  name = "qiyrix-billing-alerts"
}

resource "aws_sns_topic_subscription" "billing_alerts_email" {
  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = var.billing_alert_email
}

resource "aws_cloudwatch_metric_alarm" "billing" {
  alarm_name          = "qiyrix-monthly-billing-threshold"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods   = 1
  metric_name         = "EstimatedCharges"
  namespace           = "AWS/Billing"
  period              = 21600 # 6h -- billing metrics don't update faster than this
  statistic           = "Maximum"
  threshold           = var.billing_alert_threshold_usd
  alarm_description   = "Fires when this month's estimated AWS charges cross the threshold set for the aexa-server migration budget."
  dimensions = {
    Currency = "USD"
  }
  alarm_actions = [aws_sns_topic.billing_alerts.arn]
}

output "state_bucket" {
  value = aws_s3_bucket.tf_state.id
}
