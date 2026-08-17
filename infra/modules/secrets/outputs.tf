output "db_secret_arn" {
  value = aws_secretsmanager_secret.db.arn
}

output "redis_secret_arn" {
  value = aws_secretsmanager_secret.redis.arn
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "aws_s3_secret_arn" {
  value = aws_secretsmanager_secret.aws_s3.arn
}

output "ai_internal_secret" {
  description = "Shared X-Internal-Secret value between aexa-server and aexa-ai. Consumed by environments/prod-ai via remote state to populate aexa-ai/app's INTERNAL_SECRET -- generated once, here, not hand-copied."
  value       = random_password.ai_internal_secret.result
  sensitive   = true
}

output "secret_arns" {
  description = "All four grouped secret ARNs, for scoping the ECS task execution role's Secrets Manager IAM permission."
  value = [
    aws_secretsmanager_secret.db.arn,
    aws_secretsmanager_secret.redis.arn,
    aws_secretsmanager_secret.app.arn,
    aws_secretsmanager_secret.aws_s3.arn,
  ]
}
