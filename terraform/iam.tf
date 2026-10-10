# All roles live under a path, so a work-account admin can grant
# iam:CreateRole scoped to /costhub/ -- a far easier approval than
# unrestricted IAM, because it provably cannot touch anything else.
locals {
  iam_path = "/${var.name_prefix}/"

  # Roles to assume in other accounts for cost data. Entries without a
  # role_arn are read with this account's own credentials.
  assume_role_arns = compact([
    for a in var.data_source_accounts : try(a.role_arn, null)
  ])
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${local.prefix}-lambda"
  path               = local.iam_path
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "lambda" {
  # Cost data from THIS account.
  statement {
    sid = "CostExplorerRead"
    actions = [
      "ce:GetCostAndUsage",
      "ce:GetCostForecast",
      "ce:GetDimensionValues",
      "ce:GetTags",
      "ce:GetAnomalies",
      "ce:GetAnomalyMonitors",
      "ce:GetAnomalySubscriptions",
      "ce:ListCostAllocationTags",
    ]
    resources = ["*"] # Cost Explorer has no resource-level permissions
  }

  statement {
    sid       = "ReadDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.db.arn]
  }

  statement {
    sid       = "PublishAlerts"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]
  }

  statement {
    sid       = "SendAlertEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [var.ses_sender_email]
    }
  }

  statement {
    sid = "ManageInvitedUsers"
    actions = [
      "cognito-idp:AdminCreateUser",
      "cognito-idp:AdminGetUser",
      "cognito-idp:ListUsers",
    ]
    resources = [aws_cognito_user_pool.main.arn]
  }
}

resource "aws_iam_role_policy" "lambda" {
  name   = "${local.prefix}-lambda"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.lambda.json
}

# Only created when there is actually a cross-account role to assume, so
# an empty statement never ends up in the policy.
data "aws_iam_policy_document" "assume_cost_roles" {
  count = length(local.assume_role_arns) > 0 ? 1 : 0

  statement {
    sid       = "AssumeCostReaderRoles"
    actions   = ["sts:AssumeRole"]
    resources = local.assume_role_arns
  }
}

resource "aws_iam_role_policy" "assume_cost_roles" {
  count  = length(local.assume_role_arns) > 0 ? 1 : 0
  name   = "${local.prefix}-assume-cost-roles"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.assume_cost_roles[0].json
}
