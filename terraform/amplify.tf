# Amplify Hosting is S3 + CloudFront plus a build pipeline; choosing it is
# choosing not to wire those together. The free tier (1,000 build minutes,
# 15 GB served, 5 GB stored per month) does not expire and covers this.
#
# Amplify Hosting ONLY -- not Amplify Gen 2, which would generate its own
# CDK-managed backend and own resources outside this teardown.

resource "aws_amplify_app" "main" {
  name = local.prefix

  # Left empty by default: a manual deploy keeps a GitHub PAT out of
  # Terraform state. Set amplify_repository + amplify_access_token to
  # switch to build-on-push.
  repository   = var.amplify_repository != "" ? var.amplify_repository : null
  access_token = var.amplify_access_token != "" ? var.amplify_access_token : null

  platform = "WEB"

  # Single-page app: unknown paths must serve index.html, or a refresh on
  # /explore returns 404.
  custom_rule {
    source = "/<*>"
    status = "404-200"
    target = "/index.html"
  }

  environment_variables = {
    VITE_AWS_REGION           = var.aws_region
    AMPLIFY_MONOREPO_APP_ROOT = "frontend"
  }
}

resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.main.id
  branch_name = local.env
  framework   = "React"
  stage       = local.env == "main" ? "PRODUCTION" : "DEVELOPMENT"

  # How stakeholders see the demo before Cognito is finished.
  enable_basic_auth = true
  basic_auth_credentials = base64encode(
    "${var.amplify_basic_auth_user}:${var.amplify_basic_auth_password}"
  )

  enable_auto_build = var.amplify_repository != ""
}
