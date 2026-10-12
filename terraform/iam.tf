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

  # Kept deliberately: operators and a future config.py that reads the
  # secret instead of taking DATABASE_URL in plaintext both need it. The
  # plaintext env var is the weaker half of the pair and is noted as
  # TODO in docs/10.
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
      # StringLike, not StringEquals: an exact match breaks the moment
      # anyone sends from a display name ("CostHub <a@b>"), and ses.py
      # swallows the resulting AccessDenied into a log.warning -- so
      # alerting would fail silently, which is the one failure mode this
      # system is built to avoid.
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*${var.ses_sender_email}*"]
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

# Cross-account cost roles.
#
# This used to be count-gated on var.data_source_accounts, but the
# RUNTIME reads roles from the cloud_connections TABLE -- connections are
# added through the UI, not tfvars -- so the first account registered
# that way failed with AccessDenied against a policy that did not exist.
#
# The grant is therefore unconditional and name-constrained instead:
# any role called CostHubCostReader, in any account, which is the
# convention the onboarding instructions hand out. It cannot assume
# arbitrary roles, and it does not depend on tfvars being kept in step
# with the database.
data "aws_iam_policy_document" "assume_cost_roles" {
  statement {
    sid     = "AssumeCostReaderRolesByName"
    actions = ["sts:AssumeRole"]
    resources = concat(
      ["arn:aws:iam::*:role/CostHubCostReader"],
      local.assume_role_arns,
    )
  }
}

resource "aws_iam_role_policy" "assume_cost_roles" {
  name   = "${local.prefix}-assume-cost-roles"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.assume_cost_roles.json
}
