# Grouped secrets, not ~20 individual ones -- injected natively via the ECS
# task definition's `secrets` block (step 6), same env var names the app
# already reads, no application code changes needed.

resource "aws_secretsmanager_secret" "db" {
  name = "${var.project}/db"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    # sslmode=require alone made Prisma reject every query against RDS
    # with "self-signed certificate in certificate chain" -- unlike
    # node-postgres, Prisma's query engine validates the cert chain even
    # under `require`. RDS's default server cert isn't in a public CA
    # bundle Prisma trusts. `no-verify` keeps the connection encrypted
    # (RDS enforces TLS at the network layer regardless) but skips
    # chain validation -- the pragmatic fix without bundling AWS's RDS
    # CA bundle into the image and switching to verify-full.
    DATABASE_URL = "postgresql://${var.db_username}:${urlencode(var.db_password)}@${var.db_endpoint}:${var.db_port}/${var.db_name}?sslmode=no-verify"
  })
}

resource "aws_secretsmanager_secret" "redis" {
  name = "${var.project}/redis"
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    # HOSTED_REDIS_CONNECTION=true routes through connection.ts's `new
    # Redis(url, { tls: {} })` branch -- the only path that supports both
    # TLS and an AUTH token, which ElastiCache's transit_encryption_enabled
    # requires. The plain HOSTED_REDIS_CONNECTION=false / REDIS_HOST path
    # has no password field at all -- not usable against this cluster.
    HOSTED_REDIS_CONNECTION = "true"
    HOSTED_REDIS_DB_URL     = "rediss://:${urlencode(var.redis_auth_token)}@${var.redis_endpoint}:${var.redis_port}"
  })
}

resource "aws_secretsmanager_secret" "app" {
  name = "${var.project}/app"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode(var.app_secrets)
}

resource "aws_secretsmanager_secret" "aws_s3" {
  name = "${var.project}/aws-s3"
}

resource "aws_secretsmanager_secret_version" "aws_s3" {
  secret_id = aws_secretsmanager_secret.aws_s3.id
  secret_string = jsonencode({
    AWS_ACCESS_KEY_ID     = var.aws_s3_access_key_id
    AWS_SECRET_ACCESS_KEY = var.aws_s3_secret_access_key
  })
}
