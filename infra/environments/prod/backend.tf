terraform {
  required_version = ">= 1.10" # use_lockfile (native S3 locking) below needs 1.10+

  backend "s3" {
    bucket       = "qiyrix-terraform-state-029099142365"
    key          = "aexa-server/prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true # native S3 locking (Terraform 1.10+) -- no DynamoDB table needed
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
