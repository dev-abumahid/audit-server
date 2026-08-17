data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

resource "aws_cloudwatch_log_group" "ai" {
  name              = "/ecs/${var.project}"
  retention_in_days = 30
}

# ---------------------------------------------------------------------------
# Task execution role -- pulls the image, reads secrets, writes logs.
# Secrets Manager access scoped to aexa-ai/app-* only (wildcard suffix,
# same drift-survival reasoning as modules/compute's equivalent policy --
# not a literal fixed ARN, since Secrets Manager appends a random suffix
# on every secret recreation).
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:secret:${var.project}/app-*",
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.project}-task-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# ---------------------------------------------------------------------------
# Task role -- the app's own runtime identity. Only ECS Exec (no bastion
# host) -- aexa-ai has no S3/db-dump equivalent of aexa-server's task role
# permissions, it's stateless beyond Redis/Pinecone (both reached with
# their own API keys/auth tokens, not IAM).
# ---------------------------------------------------------------------------

resource "aws_iam_role" "task" {
  name               = "${var.project}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

data "aws_iam_policy_document" "task_exec_ssm" {
  statement {
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"] # SSM Session Manager channel actions do not support resource-level scoping
  }
}

resource "aws_iam_role_policy" "task_exec_ssm" {
  name   = "${var.project}-ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_exec_ssm.json
}

# ---------------------------------------------------------------------------
# Task definition -- no ALB in front of this service (see modules/networking
# comment: aexa-ai is purely server-to-server), so the container-level
# healthCheck below is the ONLY thing that gates whether Cloud Map/ECS
# consider a task actually ready, not just RUNNING. startPeriod covers
# app/clients.py constructing the OpenAI/Pinecone clients at import time
# (which raise if their API keys are missing -- good fail-fast, but means
# "container running" and "container ready" aren't the same moment).
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "ai" {
  family                   = var.project
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = var.project
      image     = "${var.ecr_repository_url}:latest"
      essential = true

      portMappings = [{
        containerPort = var.app_port
        protocol      = "tcp"
      }]

      # /health is a normal authenticated route (inherits the app-wide
      # X-Internal-Secret dependency like every other route -- see
      # aexa-ai's app/main.py) -- deliberately not an unauthenticated
      # bypass route, since there's no ALB forcing one. The healthcheck
      # supplies the secret itself from the container's own env.
      #
      # Uses python3 (already in the image -- it's the runtime), not curl:
      # the aexa-ai image is python:3.12-slim with zero apt-installed
      # system packages (deliberately minimal, confirmed via its
      # Dockerfile). A curl-based healthCheck command silently fails with
      # "command not found" on every single check, forever, regardless of
      # whether the app itself is healthy -- caught live (task stayed
      # RUNNING with clean startup logs but healthStatus stuck UNHEALTHY)
      # rather than in review. Adding curl via apt-get would be the
      # image's first-ever system package for a single health probe;
      # reusing the interpreter that's already there avoids that.
      healthCheck = {
        command = [
          "CMD-SHELL",
          "python3 -c \"import os,sys,urllib.request; req=urllib.request.Request('http://localhost:${var.app_port}/health', headers={'X-Internal-Secret': os.environ['INTERNAL_SECRET']}); sys.exit(0 if urllib.request.urlopen(req, timeout=5).status == 200 else 1)\" || exit 1"
        ]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 30
      }

      secrets = [
        { name = "INTERNAL_SECRET", valueFrom = "${var.app_secret_arn}:INTERNAL_SECRET::" },
        { name = "OPENAI_API_KEY", valueFrom = "${var.app_secret_arn}:OPENAI_API_KEY::" },
        { name = "PINECONE_API_KEY", valueFrom = "${var.app_secret_arn}:PINECONE_API_KEY::" },
        { name = "CLIENT_PINECONE_API_KEY", valueFrom = "${var.app_secret_arn}:CLIENT_PINECONE_API_KEY::" },
        { name = "TAVILY_API_KEY", valueFrom = "${var.app_secret_arn}:TAVILY_API_KEY::" },
        { name = "REDIS_URL", valueFrom = "${var.app_secret_arn}:REDIS_URL::" },
        { name = "CORS_ORIGIN", valueFrom = "${var.app_secret_arn}:CORS_ORIGIN::" },
        { name = "WEBHOOK_BASE_URL", valueFrom = "${var.app_secret_arn}:WEBHOOK_BASE_URL::" },
      ]

      environment = [
        { name = "ENV", value = "production" }, # keeps /docs, /redoc, /openapi.json disabled -- see aexa-ai's app/main.py
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ai.name
          "awslogs-region"        = data.aws_region.current.id
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# Cloud Map service discovery -- private DNS, no ALB. aws_service_discovery_
# private_dns_namespace is per-VPC; reuses one if aexa-server already has
# one for this VPC, otherwise creates it (see var.existing_namespace_id).
# ---------------------------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "internal" {
  count       = var.existing_namespace_id == null ? 1 : 0
  name        = "${var.cluster_name}.internal"
  vpc         = var.vpc_id
  description = "Private service discovery for cross-service calls within the ${var.cluster_name} VPC (aexa-ai first, others can register here too)."
}

locals {
  namespace_id = var.existing_namespace_id != null ? var.existing_namespace_id : aws_service_discovery_private_dns_namespace.internal[0].id
}

resource "aws_service_discovery_service" "ai" {
  name = var.project

  dns_config {
    namespace_id = local.namespace_id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  # Cloud Map's own health check just tracks ECS's reported task health
  # (via the task definition's healthCheck above) -- not a second,
  # independent HTTP check.
  health_check_custom_config {
    failure_threshold = 1
  }
}

# ---------------------------------------------------------------------------
# ECS service -- on the EXISTING shared aexa-server cluster (var.cluster_
# name), not a new one. No load_balancer block (no ALB); service_registries
# wires it into Cloud Map instead.
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "ai" {
  name            = var.project
  cluster         = var.cluster_name
  task_definition = aws_ecs_task_definition.ai.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.aexa_ai_sg_id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.ai.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.task_execution_managed,
    aws_iam_role_policy.task_execution_secrets,
    aws_iam_role_policy.task_exec_ssm,
  ]
}

# ---------------------------------------------------------------------------
# Alarm on the EXISTING aexa-server ops_alerts SNS topic (var.ops_alerts_
# topic_arn) -- not a new topic, so one subscription covers both services.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_running_tasks_low" {
  alarm_name          = "${var.project}-ecs-running-tasks-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_description   = "Fewer than the desired task count has been running for 2+ consecutive minutes."
  dimensions = {
    ClusterName = var.cluster_name
    ServiceName = aws_ecs_service.ai.name
  }
  alarm_actions = [var.ops_alerts_topic_arn]
  ok_actions    = [var.ops_alerts_topic_arn]
}
