module "networking" {
  source  = "../../modules/networking"
  project = var.project
}

module "data" {
  source = "../../modules/data"

  project                 = var.project
  vpc_id                  = module.networking.vpc_id
  private_subnet_ids      = module.networking.private_subnet_ids
  db_security_group_id    = module.networking.db_sg_id
  redis_security_group_id = module.networking.redis_sg_id
}

module "secrets" {
  source = "../../modules/secrets"

  project = var.project

  db_endpoint = module.data.db_endpoint
  db_port     = module.data.db_port
  db_name     = module.data.db_name
  db_username = module.data.db_username
  db_password = module.data.db_password

  redis_endpoint   = module.data.redis_primary_endpoint
  redis_port       = module.data.redis_port
  redis_auth_token = module.data.redis_auth_token

  app_secrets              = var.app_secrets
  aws_s3_access_key_id     = var.aws_s3_access_key_id
  aws_s3_secret_access_key = var.aws_s3_secret_access_key
}

module "deploy" {
  source = "../../modules/deploy"

  project = var.project
}
