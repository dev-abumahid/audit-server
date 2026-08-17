output "service_name" {
  value = aws_ecs_service.ai.name
}

output "cloud_map_namespace_name" {
  value = var.existing_namespace_id != null ? null : aws_service_discovery_private_dns_namespace.internal[0].name
}

# Private DNS name aexa-server's AI_SERVER_ENDPOINT should point at, e.g.
# http://aexa-ai.aexa-server.internal:8000
output "service_discovery_name" {
  value = aws_service_discovery_service.ai.name
}
