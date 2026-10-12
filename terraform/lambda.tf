# One zip, five handlers. The code is small, and a single artifact means
# one build step and no chance of the API drifting from the jobs.
#
# Built by `make build` (pip --platform manylinux2014_x86_64, since there
# is no Docker on the dev machine). Terraform only consumes the result.
locals {
  # fileexists guard: filebase64sha256 is evaluated even by
  # `terraform plan -destroy`, so a missing bundle made DESTROY
  # impossible on a fresh clone (dist/ is gitignored). Verified by
  # reproducing the error.
  bundle        = "${path.module}/../dist/lambda.zip"
  bundle_exists = fileexists("${path.module}/../dist/lambda.zip")

  # The app functions. `presignup` is deliberately NOT here: the user pool
  # needs that function's ARN, while these need the pool's id, so keeping
  # them in one resource is a dependency cycle. Splitting it is the fix --
  # and it is honest, since the trigger needs none of the pool's config.
  functions = {
    api     = { handler = "costhub.lambda_handlers.handler_api", timeout = 30, memory = 512 }
    ingest  = { handler = "costhub.lambda_handlers.handler_ingest", timeout = 600, memory = 512 }
    anomaly = { handler = "costhub.lambda_handlers.handler_anomaly", timeout = 300, memory = 512 }
    alerts  = { handler = "costhub.lambda_handlers.handler_alerts", timeout = 300, memory = 512 }
  }

  # Everything that gets a log group.
  all_function_names = concat(keys(local.functions), ["presignup"])

  common_env = {
    APP_ENV              = local.env
    DATABASE_URL         = local.database_url
    SYSTEM_ACTOR         = "system@${var.name_prefix}.internal"
    ALLOWED_EMAIL_DOMAIN = var.allowed_email_domain
    AWS_REGION_NAME      = var.aws_region
    SES_SENDER_EMAIL     = var.ses_sender_email
    SUPERADMIN_EMAIL     = var.superadmin_email
  }
}

resource "aws_lambda_function" "fn" {
  for_each = local.functions

  function_name = "${local.prefix}-${each.key}"
  role          = aws_iam_role.lambda.arn
  handler       = each.value.handler
  runtime       = "python3.11"
  timeout       = each.value.timeout
  memory_size   = each.value.memory

  filename         = local.bundle
  source_code_hash = local.bundle_exists ? filebase64sha256(local.bundle) : null

  environment {
    variables = merge(local.common_env, {
      COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id
      COGNITO_CLIENT_ID    = aws_cognito_user_pool_client.web.id
      # The ONLY CORS configuration now. API Gateway deliberately adds
      # none (see apigateway.tf), so CORSMiddleware in the app is the
      # single owner -- and that means localhost has to be listed here.
      # The Function URL used to supply it at the edge, so dropping the
      # URL without this would break local dev against the deployed API
      # with an opaque "Failed to fetch".
      CORS_ORIGINS = join(",", concat(
        ["https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}"],
        var.allow_local_frontend ? ["http://localhost:3000"] : [],
      ))
    })
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

# NO Function URL. It is replaced by the HTTP API in apigateway.tf,
# because this account refuses anonymous Lambda invocation -- the URL
# returned 403 AccessDeniedException to every request with a correct
# public resource policy, and a hand-built throwaway function URL did
# the same. The full evidence is in apigateway.tf; it is written up
# there rather than here because that is where the replacement lives.
#
# Removing this also removes the duplicate public-access statement the
# AWS console added while the 403 was being diagnosed. Terraform does
# not know about that one, so clear it by hand after the apply:
#
#   aws lambda remove-permission --function-name costhub-dev-api \
#     --statement-id FunctionURLAllowPublicAccess --region us-east-1

# Standalone, and deliberately depends on the ROLE rather than the role
# POLICY: the policy references the user pool, the pool references this
# function, and this function needs none of those permissions.
resource "aws_lambda_function" "presignup" {
  function_name = "${local.prefix}-presignup"
  role          = aws_iam_role.lambda.arn
  handler       = "costhub.lambda_handlers.handler_presignup"
  runtime       = "python3.11"
  timeout       = 10
  memory_size   = 256

  filename         = local.bundle
  source_code_hash = local.bundle_exists ? filebase64sha256(local.bundle) : null

  environment {
    variables = {
      APP_ENV              = local.env
      ALLOWED_EMAIL_DOMAIN = var.allowed_email_domain
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy_attachment.lambda_logs,
  ]
}

resource "aws_lambda_permission" "cognito_presignup" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.main.arn
}
