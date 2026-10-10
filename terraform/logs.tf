# Declared explicitly on purpose. Lambda creates /aws/lambda/<name>
# implicitly, Terraform never learns about it, and it then survives
# destroy as orphaned cost plus a naming collision on the next apply.
resource "aws_cloudwatch_log_group" "lambda" {
  for_each = toset(local.all_function_names)

  name              = "/aws/lambda/${local.prefix}-${each.value}"
  retention_in_days = var.log_retention_days
}
