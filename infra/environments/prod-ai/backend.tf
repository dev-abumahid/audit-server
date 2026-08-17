terraform {
  required_version = ">= 1.10"

  # Same S3 bucket as environments/prod, DIFFERENT state key -- deliberate:
  # two independently-deployed repos (aexa-server, aexa-ai) both eventually
  # running `terraform apply` against the SAME state would mean a bad
  # aexa-ai apply (or a lock held mid-deploy) could block or corrupt an
  # aexa-server deploy. Separate keys cost nothing and remove that risk.
  backend "s3" {
    bucket       = "qiyrix-terraform-state-029099142365"
    key          = "aexa-ai/prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
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
