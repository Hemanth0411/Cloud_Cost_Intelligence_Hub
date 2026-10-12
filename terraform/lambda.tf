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
      CORS_ORIGINS         = "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}"
    })
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda,
  ]
}

# A Function URL rather than API Gateway: one less component, and nothing
# here needs request transformation. The trade is no built-in throttling,
# which is TODO-6.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.fn["api"].function_name
  authorization_type = "NONE" # the app verifies Cognito JWTs itself

  cors {
    allow_origins = concat(
      ["https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}"],
      # 3000 is `next dev`. This said 5173 (Vite), which is the port the
      # previous frontend used -- every local API call failed CORS
      # preflight, which presents as an opaque "Failed to fetch".
      var.allow_local_frontend ? ["http://localhost:3000"] : [],
    )
    allow_methods = ["*"]
    # x-dev-user is deliberately ABSENT. A public, unauthenticated
    # Function URL must not advertise the dev-auth bypass header --
    # and ALLOW_DEV_AUTH is never set here, so it would be refused
    # anyway. Both, because either alone is one mistake from a leak.
    allow_headers     = ["authorization", "content-type"]
    allow_credentials = true
    max_age           = 3600
  }
}

# WITHOUT THIS THE API RETURNS 403 AND TERRAFORM REPORTS SUCCESS.
#
# authorization_type = "NONE" controls who Lambda *asks* about the call,
# not whether the call is allowed: the function still needs a
# resource-based policy permitting lambda:InvokeFunctionUrl. The console
# adds one when you create a URL by hand, Terraform does not, so this is
# a config that plans and applies cleanly and then serves nothing.
#
# function_url_auth_type = "NONE" is what scopes this to the URL rather
# than granting the world lambda:InvokeFunction generally.
resource "aws_lambda_permission" "api_url" {
  statement_id           = "AllowFunctionUrlInvoke"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.fn["api"].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}


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
