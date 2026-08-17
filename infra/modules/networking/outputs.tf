output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "alb_sg_id" {
  value = aws_security_group.alb.id
}

output "app_sg_id" {
  value = aws_security_group.app.id
}

output "db_sg_id" {
  value = aws_security_group.db.id
}

output "redis_sg_id" {
  value = aws_security_group.redis.id
}

output "aexa_ai_sg_id" {
  value = aws_security_group.aexa_ai.id
}

output "aexa_ai_redis_sg_id" {
  value = aws_security_group.aexa_ai_redis.id
}

output "alb_logs_bucket" {
  value = aws_s3_bucket.alb_logs.id
}
