module "networking" {
  source   = "../../modules/networking"
  project  = var.project
  app_port = var.app_port
}

module "data" {
  source = "../../modules/data"

  project                 = var.project
  vpc_id                  = module.networking.vpc_id
  private_subnet_ids      = module.networking.private_subnet_ids
  db_security_group_id    = module.networking.db_sg_id
  redis_security_group_id = module.networking.redis_sg_id
}

module "secrets" {
  source = "../../modules/secrets"

  project = var.project

  db_endpoint = module.data.db_endpoint
  db_port     = module.data.db_port
  db_name     = module.data.db_name
  db_username = module.data.db_username
  db_password = module.data.db_password

  redis_endpoint   = module.data.redis_primary_endpoint
  redis_port       = module.data.redis_port
  redis_auth_token = module.data.redis_auth_token

  app_secrets              = var.app_secrets
  aws_s3_access_key_id     = var.aws_s3_access_key_id
  aws_s3_secret_access_key = var.aws_s3_secret_access_key
}

module "deploy" {
  source = "../../modules/deploy"

  project = var.project
}

module "compute" {
  source = "../../modules/compute"

  project            = var.project
  vpc_id             = module.networking.vpc_id
  public_subnet_ids  = module.networking.public_subnet_ids
  private_subnet_ids = module.networking.private_subnet_ids
  alb_sg_id          = module.networking.alb_sg_id
  app_sg_id          = module.networking.app_sg_id
  app_port           = var.app_port
  alb_logs_bucket    = module.networking.alb_logs_bucket
  ecr_repository_url = module.deploy.ecr_repository_url
  domain_name        = var.domain_name

  db_secret_arn     = module.secrets.db_secret_arn
  redis_secret_arn  = module.secrets.redis_secret_arn
  app_secret_arn    = module.secrets.app_secret_arn
  aws_s3_secret_arn = module.secrets.aws_s3_secret_arn
}

# ---------------------------------------------------------------------------
# RDS alarms (plan step 11) -- kept at root level, not inside module.data,
# to avoid a circular module dependency (they need module.compute's SNS
# topic, and module.compute already depends on module.data via the secrets
# module for DB connection details).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.project}-rds-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS CPU above 80% for 15+ minutes."
  dimensions = {
    DBInstanceIdentifier = module.data.db_instance_id
  }
  alarm_actions = [module.compute.ops_alerts_topic_arn]
  ok_actions    = [module.compute.ops_alerts_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${var.project}-rds-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  # db.t4g.micro's practical connection ceiling is in the low hundreds --
  # this is an early-warning threshold, not the actual limit.
  threshold         = 50
  alarm_description = "RDS connection count above 50 for 10+ minutes -- possible connection leak."
  dimensions = {
    DBInstanceIdentifier = module.data.db_instance_id
  }
  alarm_actions = [module.compute.ops_alerts_topic_arn]
  ok_actions    = [module.compute.ops_alerts_topic_arn]
}
