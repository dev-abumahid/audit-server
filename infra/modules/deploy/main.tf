data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ---------------------------------------------------------------------------
# ECR repository
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "main" {
  name                 = var.project
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "main" {
  repository = aws_ecr_repository.main.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# GitHub Actions OIDC deploy role -- reuses the OIDC provider already
# created for the frontend's deploy pipeline (one provider per AWS
# account, not per repo). Trust policy sub is pinned to this specific
# repo *and* branch, not just the GitHub org -- an org-scoped-only trust
# policy would let any workflow in any repo under that org assume this
# role, which is the exact under-scoping gap found on the frontend's
# equivalent role earlier.
# ---------------------------------------------------------------------------

data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "deploy_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/${var.github_branch}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  name               = "${var.project}-deploy"
  assume_role_policy = data.aws_iam_policy_document.deploy_assume.json
}

data "aws_iam_policy_document" "deploy_permissions" {
  statement {
    sid    = "ECRAuth"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"] # GetAuthorizationToken does not support resource-level scoping
  }

  statement {
    sid    = "ECRPush"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = [aws_ecr_repository.main.arn]
  }

  statement {
    sid    = "ECSTaskDefinitions"
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"] # neither action supports resource-level scoping
  }

  # RunTask/DescribeTasks/UpdateService/DescribeServices *do* support
  # resource-level scoping and are split out from the statement above --
  # without this, this role (assumable by any workflow run on
  # repo:${var.github_repo}:ref:refs/heads/${var.github_branch}) could call
  # UpdateService/RunTask against *any* ECS cluster/service in the account,
  # not just this project's.
  statement {
    sid       = "ECSRunTask"
    effect    = "Allow"
    actions   = ["ecs:RunTask"]
    resources = ["arn:aws:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:task-definition/${var.project}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:cluster/${var.project}"]
    }
  }

  statement {
    sid       = "ECSDescribeTasks"
    effect    = "Allow"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:task/${var.project}/*"]
  }

  statement {
    sid    = "ECSUpdateService"
    effect = "Allow"
    actions = [
      "ecs:UpdateService",
      "ecs:DescribeServices",
    ]
    resources = ["arn:aws:ecs:${data.aws_region.current.id}:${data.aws_caller_identity.current.account_id}:service/${var.project}/${var.project}"]
  }

  statement {
    sid    = "PassEcsRoles"
    effect = "Allow"
    actions = ["iam:PassRole"]
    # Scoped by naming convention (both roles are created in the compute
    # module, step 6) rather than a direct reference, to avoid a circular
    # module dependency between deploy and compute.
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project}-ecs-*",
    ]
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "${var.project}-deploy-permissions"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy_permissions.json
}
