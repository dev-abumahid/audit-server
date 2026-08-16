output "alb_dns_name" {
  value = aws_lb.main.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "service_name" {
  value = aws_ecs_service.app.name
}

output "ops_alerts_topic_arn" {
  value = aws_sns_topic.ops_alerts.arn
}

output "db_dumps_bucket" {
  value = aws_s3_bucket.db_dumps.id
}

output "acm_certificate_arn" {
  value = aws_acm_certificate.main.arn
}

output "acm_validation_records" {
  description = "DNS validation record(s) to add at the domain registrar (GoDaddy) -- manual step, no API automation available for a non-Route53 zone."
  value = [
    for dvo in aws_acm_certificate.main.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}
