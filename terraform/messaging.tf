resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

# SES identities are deliberately NOT managed here: verification is a
# manual round trip, and destroying the identity on every teardown would
# mean re-verifying before anyone could log in again. See
# docs/13-environments-and-teardown.md, "Deliberate exceptions".
#
# The ARN is composed rather than looked up. A data source would need
# ses:GetIdentityNotificationAttributes just to read an ARN whose shape is
# fixed -- an extra permission to grant, and an extra way for `plan` to
# fail. Cognito only needs the ARN; whether the identity is verified is
# checked at send time regardless.
locals {
  ses_identity_arn = join("", [
    "arn:aws:ses:", var.aws_region, ":",
    data.aws_caller_identity.current.account_id,
    ":identity/", var.ses_sender_email,
  ])
}

# Credits run out silently on the AWS Free plan -- resources are suspended
# rather than billed -- so a budget alarm is the difference between a demo
# that warns and one that just stops.
resource "aws_budgets_budget" "monthly" {
  name         = "${local.prefix}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 50
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.superadmin_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.superadmin_email]
  }
}
