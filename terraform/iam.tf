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
    sid       = "SendAlertEmail"
    actions   = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = ["*"]
    condition {
      # StringEquals. This was briefly StringLike on the theory that a
      # display name ("CostHub <x@y>") would break an exact match -- but
      # ses:FromAddress is the parsed ADDRESS, not the raw From header,
      # so the exact match was never at risk and the wildcard only
      # widened what this role could send as. Reverted, and recorded
      # because loosening a control to fix a problem that does not exist
      # is worse than the problem.
      # (Original, incorrect, note: an exact match breaks the moment
      # anyone sends from a display name ("CostHub <a@b>"), and ses.py
      # swallows the resulting AccessDenied into a log.warning -- so
      # alerting would fail silently, which is the one failure mode this
      # system is built to avoid.
      test     = "StringEquals"
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

      # Removing a user from the app disables their pool user, or they
      # keep a working sign-in after being removed -- see
      # rbac/pool.disable_user for why disable and not delete. Enable is
      # the other half: inviting a removed person back has to clear it,
      # otherwise the revived account cannot log in and the invite is a
      # lie. AdminDeleteUser is deliberately NOT here; nothing in the
      # code calls it, and identities.subject would be orphaned by it.
      "cognito-idp:AdminDisableUser",
      "cognito-idp:AdminEnableUser",
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

# Narration for GET /insights (backend/costhub/insights).
#
# ONE model, by ARN -- not bedrock:* and not resource "*". The Converse
# API is authorized by bedrock:InvokeModel; there is no separate action.
#
# The model is Amazon Nova Lite, on-demand in this region, so the grant
# is a single foundation-model ARN. It was not the first choice: every
# Anthropic model in this account is refused until someone submits the
# Anthropic use-case form in the Bedrock console (an attestation the
# account owner has to make). Nova Micro is cheaper and also works; Lite
# was kept for better choices. See docs/16-insights-api.md.
#
# To change model, change it in BOTH places: this variable, and
# INSIGHTS_MODEL_ID on the API function (the code default is the value
# below). They are two settings until lambda.tf passes this variable to
# the function as INSIGHTS_MODEL_ID; change only this one and every call
# is denied, which the endpoint reports as "access_denied". A model served only through an inference profile, as Claude
# is here, needs the profile ARN and each destination region's
# foundation-model ARN listed -- one ARN will not be enough.
#
# Its own policy rather than a statement in `lambda` above, so adding or
# removing it never rewrites the policy the rest of the stack depends on.
# The role is shared by every function in lambda.tf, so the job Lambdas
# hold this permission too; only the API uses it.
variable "insights_model_id" {
  description = "Bedrock model GET /insights may invoke. Keep in step with INSIGHTS_MODEL_ID."
  type        = string
  default     = "amazon.nova-lite-v1:0"
}

data "aws_iam_policy_document" "insights_bedrock" {
  statement {
    sid     = "InvokeInsightsModel"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.insights_model_id}",
    ]
  }
}

resource "aws_iam_role_policy" "insights_bedrock" {
  name   = "${local.prefix}-insights-bedrock"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.insights_bedrock.json
}

# Connection credentials written from the UI
# (backend/costhub/connections/key_store.py).
#
# This is the first WRITE path to Secrets Manager in the stack. Before
# it, this role could read exactly one secret -- the database password,
# by ARN, in the `lambda` policy above -- and could not create any. An
# AWS connection in `credential_mode = "secret"` needs the API to put a
# user's access key somewhere that is not Postgres, so the role needs
# CreateSecret, PutSecretValue, GetSecretValue and DeleteSecret.
#
# SCOPED TO A DEDICATED PREFIX, which is the whole reason this is
# acceptable. The resource is one name pattern:
#
#   costhub/<env>/connections/*
#
# and NOT "*". That matters in both directions. It keeps this role away
# from every other secret in the account, and -- because the API will
# only ever DELETE something matching this prefix (`key_store.owned`) --
# it means a bug in the delete path cannot reach the database password,
# which lives at `costhub/<env>/database-url`, one segment short of the
# wildcard. The two controls are deliberately the same shape in IAM and
# in the code, so neither is the only thing standing between a delete
# and the wrong secret.
#
# The trailing `*` also covers the six random characters Secrets Manager
# appends to every secret ARN; a pattern without it matches nothing.
#
# TagResource is here because CreateSecret with Tags is authorized as
# both actions, and the tags are not decoration: `./do.sh sweep` proves
# a teardown by listing resources tagged Project/Environment, Terraform's
# default_tags cannot reach a secret this API creates, and `destroy` will
# not remove it. Untagged, a live credential would survive a teardown
# with nothing to reveal it.
#
# DescribeSecret is deliberately absent -- nothing calls it. So is
# RotateSecret: rotation here means a human supplying a new key, not
# Secrets Manager invoking a rotation Lambda.
#
# Its own policy, like the Bedrock one above, so adding or removing this
# never rewrites the policy the rest of the stack depends on. The role is
# shared by every function in lambda.tf, so the job Lambdas can read
# these secrets too -- which is required, since the 06:00 ingest is what
# reads them -- but only the API can write or delete one.
data "aws_iam_policy_document" "connection_secrets" {
  statement {
    sid = "ManageConnectionCredentials"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
      "secretsmanager:DeleteSecret",
      "secretsmanager:TagResource",
    ]
    resources = [
      join("", [
        "arn:aws:secretsmanager:${var.aws_region}:",
        "${data.aws_caller_identity.current.account_id}:secret:",
        "${var.name_prefix}/${local.env}/connections/*",
      ])
    ]
  }
}

resource "aws_iam_role_policy" "connection_secrets" {
  name   = "${local.prefix}-connection-secrets"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.connection_secrets.json
}
