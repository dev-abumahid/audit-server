provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "aexa-server"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
