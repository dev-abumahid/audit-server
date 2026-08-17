locals {
  prod = data.terraform_remote_state.prod.outputs
}

module "ai_data" {
  source = "../../modules/ai-data"

  project                 = "aexa-server" # matches aexa-server's own ${var.project} naming prefix -- this is the shared account's resource-naming convention, not a typo
  private_subnet_ids      = local.prod.private_subnet_ids
  redis_security_group_id = local.prod.aexa_ai_redis_sg_id
}

# ---------------------------------------------------------------------------
# aexa-ai's own app secret. A single small secret (not split into 4 grouped
# secrets like aexa-server's) since aexa-ai has no database/redis-connection-
# details-vs-app-config split -- everything here is "app config."
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "ai_app" {
  name = "aexa-ai/app"
}

resource "aws_secretsmanager_secret_version" "ai_app" {
  secret_id = aws_secretsmanager_secret.ai_app.id
  secret_string = jsonencode(merge(var.ai_app_secrets, {
    INTERNAL_SECRET  = local.prod.ai_internal_secret
    REDIS_URL        = "rediss://:${urlencode(module.ai_data.redis_auth_token)}@${module.ai_data.redis_primary_endpoint}:${module.ai_data.redis_port}"
    CORS_ORIGIN      = "https://qiyrix.com" # aexa-ai is server-to-server only (see modules/networking comment) -- no real browser caller, but the app fails to boot without this var set
    WEBHOOK_BASE_URL = "https://${local.prod.domain_name}"
    ENV              = "production"
  }))
}

module "ai_deploy" {
  source = "../../modules/ai-deploy"

  cluster_name = local.prod.ecs_cluster_name
}

module "ai_compute" {
  source = "../../modules/ai-compute"

  cluster_name         = local.prod.ecs_cluster_name
  vpc_id               = local.prod.vpc_id
  private_subnet_ids   = local.prod.private_subnet_ids
  aexa_ai_sg_id        = local.prod.aexa_ai_sg_id
  ecr_repository_url   = module.ai_deploy.ecr_repository_url
  app_secret_arn       = aws_secretsmanager_secret.ai_app.arn
  ops_alerts_topic_arn = local.prod.ops_alerts_topic_arn
}
