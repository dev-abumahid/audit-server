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
