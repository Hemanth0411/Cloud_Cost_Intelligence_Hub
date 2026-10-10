locals {
  schedules = {
    ingest  = var.ingest_schedule
    anomaly = var.anomaly_schedule
    alerts  = var.alerts_schedule
  }
}

# Ordered deliberately: ingest, then detect on what it wrote, then alert
# on what was detected. Spread across the hour rather than chained, which
# keeps each independently retryable.
resource "aws_cloudwatch_event_rule" "job" {
  for_each = local.schedules

  name                = "${local.prefix}-${each.key}"
  description         = "Scheduled ${each.key} for ${local.prefix}"
  schedule_expression = each.value
}

resource "aws_cloudwatch_event_target" "job" {
  for_each = local.schedules

  rule      = aws_cloudwatch_event_rule.job[each.key].name
  target_id = each.key
  arn       = aws_lambda_function.fn[each.key].arn
}

resource "aws_lambda_permission" "events" {
  for_each = local.schedules

  statement_id  = "AllowEventBridge-${each.key}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.job[each.key].arn
}
