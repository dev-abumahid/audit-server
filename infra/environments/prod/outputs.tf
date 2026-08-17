# Consumed by environments/prod-ai via `terraform_remote_state` -- the
# aexa-ai stack reuses this VPC/cluster/generated-secret rather than
# standing up its own, but lives in a separate state (see prod-ai's own
# backend.tf) so a bad aexa-ai apply can't touch aexa-server's resources.

output "vpc_id" {
  value = module.networking.vpc_id
}

output "private_subnet_ids" {
  value = module.networking.private_subnet_ids
}

output "aexa_ai_sg_id" {
  value = module.networking.aexa_ai_sg_id
}

output "aexa_ai_redis_sg_id" {
  value = module.networking.aexa_ai_redis_sg_id
}

output "ecs_cluster_name" {
  value = module.compute.cluster_name
}

output "ops_alerts_topic_arn" {
  value = module.compute.ops_alerts_topic_arn
}

output "ai_internal_secret" {
  value     = module.secrets.ai_internal_secret
  sensitive = true
}

output "domain_name" {
  value = var.domain_name
}
