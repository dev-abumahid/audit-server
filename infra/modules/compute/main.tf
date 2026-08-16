data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# ECS cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}"
  retention_in_days = 30 # Chromium/AI-module logging can be verbose -- bounded retention
}

# ---------------------------------------------------------------------------
# ACM certificate -- DNS validation. qiyrix.com is on GoDaddy, not Route53,
# so the validation CNAME has to be added manually; apply this in two
# passes (see infra/environments/prod/README.md).
# ---------------------------------------------------------------------------

resource "aws_acm_certificate" "main" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn = aws_acm_certificate.main.arn
}

# ---------------------------------------------------------------------------
# Task execution role -- pulls the image, reads secrets, writes logs.
# Secrets Manager access is scoped to exactly these 4 ARNs, not a wildcard.
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
      var.db_secret_arn,
      var.redis_secret_arn,
      var.app_secret_arn,
      var.aws_s3_secret_arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.project}-task-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# ---------------------------------------------------------------------------
# Task role -- the app's own runtime identity. No AWS permissions needed
# for app logic itself (S3 uploads authenticate via explicit access keys,
# not this role) -- only what ECS Exec requires.
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
# Task definition
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "app" {
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

      environment = [
        { name = "PORT", value = tostring(var.app_port) },
      ]

      secrets = [
        { name = "DATABASE_URL", valueFrom = "${var.db_secret_arn}:DATABASE_URL::" },
        { name = "HOSTED_REDIS_CONNECTION", valueFrom = "${var.redis_secret_arn}:HOSTED_REDIS_CONNECTION::" },
        { name = "HOSTED_REDIS_DB_URL", valueFrom = "${var.redis_secret_arn}:HOSTED_REDIS_DB_URL::" },
        { name = "AWS_ACCESS_KEY_ID", valueFrom = "${var.aws_s3_secret_arn}:AWS_ACCESS_KEY_ID::" },
        { name = "AWS_SECRET_ACCESS_KEY", valueFrom = "${var.aws_s3_secret_arn}:AWS_SECRET_ACCESS_KEY::" },
        { name = "SESSION_SECRET", valueFrom = "${var.app_secret_arn}:SESSION_SECRET::" },
        { name = "AI_INTERNAL_SECRET", valueFrom = "${var.app_secret_arn}:AI_INTERNAL_SECRET::" },
        { name = "ACCESS_TOKEN", valueFrom = "${var.app_secret_arn}:ACCESS_TOKEN::" },
        { name = "ACCESS_EXPIRES", valueFrom = "${var.app_secret_arn}:ACCESS_EXPIRES::" },
        { name = "REFRESH_TOKEN", valueFrom = "${var.app_secret_arn}:REFRESH_TOKEN::" },
        { name = "REFRESH_EXPIRES", valueFrom = "${var.app_secret_arn}:REFRESH_EXPIRES::" },
        { name = "RESET_SECRET", valueFrom = "${var.app_secret_arn}:RESET_SECRET::" },
        { name = "RESET_EXPIRES", valueFrom = "${var.app_secret_arn}:RESET_EXPIRES::" },
        { name = "VERIFIED_TOKEN", valueFrom = "${var.app_secret_arn}:VERIFIED_TOKEN::" },
        { name = "APP_USER_EMAIL", valueFrom = "${var.app_secret_arn}:APP_USER_EMAIL::" },
        { name = "APP_PASSWORD", valueFrom = "${var.app_secret_arn}:APP_PASSWORD::" },
        { name = "IS_GOOGLE_LOGIN", valueFrom = "${var.app_secret_arn}:IS_GOOGLE_LOGIN::" },
        { name = "GOOGLE_CLIENT_ID", valueFrom = "${var.app_secret_arn}:GOOGLE_CLIENT_ID::" },
        { name = "GOOGLE_CLIENT_SECRET", valueFrom = "${var.app_secret_arn}:GOOGLE_CLIENT_SECRET::" },
        { name = "GOOGLE_CALLBACK_URL", valueFrom = "${var.app_secret_arn}:GOOGLE_CALLBACK_URL::" },
        { name = "IS_FACEBOOK_LOGIN", valueFrom = "${var.app_secret_arn}:IS_FACEBOOK_LOGIN::" },
        { name = "FACEBOOK_APP_ID", valueFrom = "${var.app_secret_arn}:FACEBOOK_APP_ID::" },
        { name = "FACEBOOK_APP_SECRET", valueFrom = "${var.app_secret_arn}:FACEBOOK_APP_SECRET::" },
        { name = "IS_TWITTER_LOGIN", valueFrom = "${var.app_secret_arn}:IS_TWITTER_LOGIN::" },
        { name = "TWITTER_CONSUMER_KEY", valueFrom = "${var.app_secret_arn}:TWITTER_CONSUMER_KEY::" },
        { name = "TWITTER_CONSUMER_SECRET", valueFrom = "${var.app_secret_arn}:TWITTER_CONSUMER_SECRET::" },
        { name = "IS_GITHUB_LOGIN", valueFrom = "${var.app_secret_arn}:IS_GITHUB_LOGIN::" },
        { name = "GITHUB_CLIENT_ID", valueFrom = "${var.app_secret_arn}:GITHUB_CLIENT_ID::" },
        { name = "GITHUB_CLIENT_SECRET", valueFrom = "${var.app_secret_arn}:GITHUB_CLIENT_SECRET::" },
        { name = "FRONT_END_URL", valueFrom = "${var.app_secret_arn}:FRONT_END_URL::" },
        { name = "AWS_BUCKET", valueFrom = "${var.app_secret_arn}:AWS_BUCKET::" },
        { name = "AWS_REGION", valueFrom = "${var.app_secret_arn}:AWS_REGION::" },
        { name = "PRODUCTION_BASE_URL", valueFrom = "${var.app_secret_arn}:PRODUCTION_BASE_URL::" },
        { name = "AI_SERVER_ENDPOINT", valueFrom = "${var.app_secret_arn}:AI_SERVER_ENDPOINT::" },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = data.aws_region.current.id
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])
}

# ---------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------

resource "aws_lb" "main" {
  name               = "${var.project}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_sg_id]
  subnets            = var.public_subnet_ids

  access_logs {
    bucket  = var.alb_logs_bucket
    enabled = true
  }
}

resource "aws_lb_target_group" "app" {
  name        = "${var.project}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip" # required for Fargate awsvpc mode

  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---------------------------------------------------------------------------
# ECS service
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "app" {
  name            = var.project
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_execute_command = true # ECS Exec, in lieu of a bastion host

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_sg_id]
    assign_public_ip = false # explicit, not relied on via subnet placement alone
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = var.project
    container_port   = var.app_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener.https]
}
