output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.ai.primary_endpoint_address
}

output "redis_port" {
  value = aws_elasticache_replication_group.ai.port
}

output "redis_auth_token" {
  value     = random_password.ai_redis_auth.result
  sensitive = true
}
