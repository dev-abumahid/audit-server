provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "aexa-ai"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Reads environments/prod's outputs (VPC, aexa-ai security groups, ECS
# cluster, ops-alerts topic, the generated shared INTERNAL_SECRET) --
# aexa-server's own infra is what actually creates those; this state only
# consumes them, it doesn't manage them.
data "terraform_remote_state" "prod" {
  backend = "s3"
  config = {
    bucket = "qiyrix-terraform-state-029099142365"
    key    = "aexa-server/prod/terraform.tfstate"
    region = "us-east-1"
  }
}
