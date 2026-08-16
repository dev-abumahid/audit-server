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

output "secret_arns" {
  description = "All four grouped secret ARNs, for scoping the ECS task execution role's Secrets Manager IAM permission."
  value = [
    aws_secretsmanager_secret.db.arn,
    aws_secretsmanager_secret.redis.arn,
    aws_secretsmanager_secret.app.arn,
    aws_secretsmanager_secret.aws_s3.arn,
  ]
}
