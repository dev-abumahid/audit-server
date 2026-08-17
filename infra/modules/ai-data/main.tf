# ---------------------------------------------------------------------------
# ElastiCache Redis for aexa-ai -- cache.t4g.micro, single node, dedicated
# (not sharing aexa-server's cluster via a logical DB index). aexa-server's
# Redis holds BullMQ queue state that must not be evicted; aexa-ai's
# job-status keys sharing maxmemory/eviction policy with it risked queue
# data loss under AI-traffic bursts. ~$12-13/mo for the isolation.
#
# Same shape as modules/data's aexa-server Redis: a replication group (not
# aws_elasticache_cluster), since transit encryption is only configurable
# at that resource level.
# ---------------------------------------------------------------------------

resource "aws_elasticache_subnet_group" "ai" {
  name       = "${var.project}-aexa-ai-redis"
  subnet_ids = var.private_subnet_ids
}

resource "random_password" "ai_redis_auth" {
  length  = 32
  special = false # ElastiCache AUTH tokens disallow most special characters
}

resource "aws_elasticache_replication_group" "ai" {
  replication_group_id = "${var.project}-aexa-ai-redis"
  description          = "aexa-ai job-status store -- dedicated, not shared with aexa-server's Redis."

  engine             = "redis"
  node_type          = var.redis_node_type
  num_cache_clusters = 1
  # Explicit, not left to the provider's computed default -- at plan time
  # (resource not yet created), the `port` computed attribute resolves to
  # null rather than "known after apply" on this provider version, which
  # breaks string interpolation in anything referencing it (see
  # environments/prod-ai's REDIS_URL construction). Setting it explicitly
  # sidesteps that entirely and matches the standard Redis port anyway.
  port = 6379

  subnet_group_name  = aws_elasticache_subnet_group.ai.name
  security_group_ids = [var.redis_security_group_id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token                 = random_password.ai_redis_auth.result

  automatic_failover_enabled = false # single node -- no standby to fail over to

  tags = { Name = "${var.project}-aexa-ai-redis" }
}
