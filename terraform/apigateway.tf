# HTTP API in front of the API Lambda, replacing its Function URL.
#
# WHY THIS EXISTS, because it is not the obvious choice: the Function URL
# worked in every observable respect and still refused every request.
#
#   GET https://<id>.lambda-url.us-east-1.on.aws/health
#   -> 403, x-amzn-ErrorType: AccessDeniedException
#
# while the resource policy was textbook-correct (Principal "*",
# lambda:InvokeFunctionUrl, condition FunctionUrlAuthType = NONE), the
# URL's AuthType was NONE, the function was Active, OPTIONS preflight
# returned 200, and CloudWatch recorded no invocation at all -- the
# requests never reached the function.
#
# Proven by elimination: a brand-new throwaway function, created by hand
# with the CLI, given its own public permission, returned the SAME 403.
# So it was never this stack's configuration. Meanwhile
# `aws lambda invoke` returns 200 and the app is healthy.
#
# Conclusion: this account blocks ANONYMOUS Lambda invocation.
# `lambda get-account-settings` reports ConcurrentExecutions = 10 against
# a normal default of 1000, which is the unverified-new-account posture.
# IAM-authorized invocation is unaffected.
#
# API Gateway sidesteps it because the invocation is no longer anonymous:
# API Gateway calls the function as the `apigateway.amazonaws.com`
# SERVICE principal, authorized by the resource policy below. Nothing
# public invokes Lambda any more.
#
# A support request to lift the account restriction is worth filing in
# parallel -- it would also raise the concurrency ceiling -- but it is
# not on the critical path once this exists.

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  # NO cors_configuration, deliberately. The FastAPI app already runs
  # CORSMiddleware (api/main.py), and two layers each adding
  # Access-Control-Allow-Origin produces a duplicated header, which
  # browsers reject outright -- a failure that reads as "CORS is broken"
  # while both layers are individually correct.
  #
  # With no CORS block here, API Gateway passes OPTIONS through to the
  # function and CORSMiddleware answers the preflight. One owner.
}

resource "aws_apigatewayv2_integration" "api" {
  api_id = aws_apigatewayv2_api.api.id

  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.fn["api"].invoke_arn

  # 2.0 is the same event shape a Function URL sends, which is why the
  # application needed no change: Mangum sees an identical payload.
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000 # API Gateway's ceiling; the Lambda's own timeout is 30s
}

# One catch-all route. The FastAPI app owns its own routing table, so
# declaring routes here would mean maintaining it twice and getting a
# 404 from API Gateway for a path the app serves.
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

# The $default stage serves from the root, so the invoke URL has no
# stage suffix and the frontend's base URL needs no path prefix.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    # Throttling the Function URL could not do (TODO-6). Generous, but
    # finite: the account's Lambda concurrency ceiling is 10, so an
    # unthrottled public endpoint could exhaust it with one loop.
    throttling_burst_limit = 20
    throttling_rate_limit  = 50
  }
}

# The authorization that makes this work: a named service principal
# rather than "*", scoped to this API.
resource "aws_lambda_permission" "apigateway" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn["api"].function_name
  principal     = "apigateway.amazonaws.com"

  # Without source_arn this grants every API Gateway in every account
  # the right to invoke the function.
  source_arn = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
