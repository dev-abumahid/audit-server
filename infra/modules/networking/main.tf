# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.project}-vpc" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${var.project}-igw" }
}

# ---------------------------------------------------------------------------
# Subnets -- 2 public (ALB + NAT), 2 private (Fargate, RDS, ElastiCache)
# across 2 AZs. Design choice: security groups are the real network
# boundary here, not NACLs -- default (allow-all) NACLs are left as-is
# deliberately, not an oversight.
# ---------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${var.project}-public-${var.azs[count.index]}" }
}

resource "aws_subnet" "private" {
  count                   = length(var.azs)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.private_subnet_cidrs[count.index]
  availability_zone       = var.azs[count.index]
  map_public_ip_on_launch = false

  tags = { Name = "${var.project}-private-${var.azs[count.index]}" }
}

# ---------------------------------------------------------------------------
# NAT Gateway -- single NAT in the first public subnet. Plan explicitly
# chooses NAT Gateway over a cheaper NAT instance for the initial cutover
# (boring/managed philosophy); the NAT-instance swap is a deferred
# cost-optimization once the new setup has been stable for a month or two.
# ---------------------------------------------------------------------------

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${var.project}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${var.project}-nat" }

  depends_on = [aws_internet_gateway.main]
}

# ---------------------------------------------------------------------------
# Route tables
# ---------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${var.project}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
  tags = { Name = "${var.project}-private-rt" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# Security groups: alb-sg -> app-sg -> {db-sg, redis-sg}. Nothing in the
# private subnets gets a public IP or an inbound rule from 0.0.0.0/0 --
# this is the direct fix for the actual vulnerability (public
# Postgres/Redis with weak/no auth) that this migration exists to escape.
# ---------------------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.project}-alb-sg"
  description = "Public HTTPS/HTTP ingress for the ALB only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP from anywhere (redirected to HTTPS at the listener)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-alb-sg" }
}

resource "aws_security_group" "app" {
  name = "${var.project}-app-sg"
  # NOTE: `description` is ForceNew on aws_security_group (AWS has no
  # update-in-place API for it) -- left as the original text rather than
  # updated to mention aexa-ai, since editing it would destroy/recreate
  # this live, in-use production security group.
  description = "aexa-server ECS tasks -- ingress only from the ALB."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from ALB only"
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # review follow-up (PR #343): no direct aexa-ai -> app-sg ingress rule
  # here. aexa-ai's callback to aexa-server (WEBHOOK_BASE_URL, see
  # environments/prod-ai) goes through the public ALB domain
  # (api.qiyrix.com), same as any other external caller -- traffic
  # arriving at this SG from the ALB always presents the ALB's own SG as
  # its source (ALB forwards from its own ENI), already covered by the
  # ingress block above. A direct aexa-ai-sg-to-app-sg rule was added in
  # an earlier version of this PR on the assumption of a direct in-VPC
  # call, but nothing actually uses that path -- removed as dead/
  # misleading rather than left in as an unused `allow`.

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-app-sg" }
}

# ---------------------------------------------------------------------------
# aexa-ai -- separate ECS service on the same cluster (no ALB, reached via
# Cloud Map service discovery -- see modules/ai-compute). Its own SG, not
# folded into app-sg, so its ingress/egress surface stays independently
# auditable even though both services share this VPC/cluster.
#
# No inline `ingress {}` block here (only egress is inline) -- its ingress
# rule (below, as aws_vpc_security_group_ingress_rule.aexa_ai_from_app) is
# entirely standalone-managed instead. Mixing would hit the exact
# inline-vs-standalone conflict described on app-sg above; since THIS SG
# has zero inline ingress blocks, there's nothing for Terraform to treat
# as an authoritative "complete" ingress set, so the standalone rule
# coexists cleanly. This also breaks the app<->aexa-ai mutual-reference
# cycle: app's inline block depends on aexa_ai.id, but aexa_ai's own
# resource no longer depends back on app.id (only the separate standalone
# rule resource does, which isn't part of either SG's own create/update).
# ---------------------------------------------------------------------------

resource "aws_security_group" "aexa_ai" {
  name        = "${var.project}-aexa-ai-sg"
  description = "aexa-ai ECS tasks -- ingress only from aexa-server app tasks."
  vpc_id      = aws_vpc.main.id

  # Explicit, not assumed -- Terraform security groups do NOT default to
  # allow-all egress the way the AWS console default SG does. aexa-ai
  # calls OpenAI/Pinecone/Tavily over the internet via the existing NAT
  # Gateway; omitting this would silently break every external LLM call.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-aexa-ai-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "aexa_ai_from_app" {
  security_group_id            = aws_security_group.aexa_ai.id
  description                  = "aexa-ai app port from aexa-server app-sg only"
  from_port                    = var.ai_app_port
  to_port                      = var.ai_app_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = aws_security_group.app.id
}

resource "aws_security_group" "aexa_ai_redis" {
  name        = "${var.project}-aexa-ai-redis-sg"
  description = "aexa-ai dedicated ElastiCache Redis node -- ingress only from aexa-ai tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from aexa-ai-sg only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.aexa_ai.id]
  }

  # review follow-up (PR #343): no egress rule -- a Redis cache node only
  # ever serves inbound client connections, it never originates outbound
  # traffic. Unlike aexa-ai-sg (which genuinely needs internet egress for
  # OpenAI/Pinecone/Tavily), an allow-all egress here would be pure
  # unused attack surface with no real traffic ever using it.

  tags = { Name = "${var.project}-aexa-ai-redis-sg" }
}

resource "aws_security_group" "db" {
  name        = "${var.project}-db-sg"
  description = "RDS Postgres -- ingress only from the app tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from app-sg only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-db-sg" }
}

resource "aws_security_group" "redis" {
  name        = "${var.project}-redis-sg"
  description = "ElastiCache Redis -- ingress only from the app tasks."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from app-sg only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${var.project}-redis-sg" }
}

# ---------------------------------------------------------------------------
# ALB access logging bucket -- cheap, high forensic value, enabled now
# rather than deferred alongside WAF/security headers.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "alb_logs" {
  bucket = "${var.project}-alb-logs-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "alb_logs" {
  bucket                  = aws_s3_bucket.alb_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
  }
}

# ELB's regional log-delivery account, per AWS docs, for the classic
# account-ID-based bucket policy method (us-east-1).
data "aws_elb_service_account" "main" {}

data "aws_iam_policy_document" "alb_logs" {
  statement {
    sid    = "AllowALBLogDelivery"
    effect = "Allow"
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.main.arn]
    }
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.alb_logs.arn}/*"]
  }
}

resource "aws_s3_bucket_policy" "alb_logs" {
  bucket = aws_s3_bucket.alb_logs.id
  policy = data.aws_iam_policy_document.alb_logs.json
}

data "aws_caller_identity" "current" {}
