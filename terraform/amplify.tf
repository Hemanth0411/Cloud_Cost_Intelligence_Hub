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

  # WEB_COMPUTE, not WEB. The frontend on the cloudlens-frontend branch
  # is Next.js 15 with the app router, and "WEB" is static-hosting only --
  # an Amplify build of a Next app on that platform either fails or
  # serves a broken tree. WEB_COMPUTE is what Amplify Hosting uses for
  # Next.js SSR.
  #
  # This said "WEB" because the build spec called for Vite + React. The
  # frontend that actually got written is Next, so the infrastructure
  # follows it rather than the other way round.
  platform = "WEB_COMPUTE"

  # NO SPA rewrite rule. That `/<*>` -> /index.html 404-200 rule is the
  # right fix for a Vite single-page app and actively wrong for Next on
  # WEB_COMPUTE: Next owns its own routing, and rewriting every unknown
  # path to /index.html would shadow its server routes. Amplify applies
  # the correct Next rules itself when the platform is WEB_COMPUTE.

  # NEXT_PUBLIC_ prefix, not VITE_. Next only exposes a variable to the
  # browser when its name starts with NEXT_PUBLIC_, so the old VITE_
  # name was being set and silently ignored by the app.
  #
  # ONLY values that depend on nothing else live here. The API URL and
  # the Cognito ids deliberately do NOT, because adding them creates a
  # dependency cycle:
  #
  #   amplify_app -> cognito_client -> (callback_urls) -> amplify_branch
  #   amplify_app -> lambda_function_url -> (cors) -> amplify_branch
  #
  # Amplify's domain is already an input to the Cognito callback URLs and
  # the Lambda CORS origins, so Amplify has to stay a leaf. Terraform
  # catches this as "Cycle:" at validate time.
  #
  # Those values reach the frontend through `./do.sh outputs <env>`,
  # which writes frontend/.env.<env> from the Terraform outputs. For an
  # Amplify build, set them once in the Amplify console (or pass them to
  # the manual deploy) -- they only change if the stack is rebuilt.
  environment_variables = {
    NEXT_PUBLIC_AWS_REGION    = var.aws_region
    AMPLIFY_MONOREPO_APP_ROOT = "frontend"
  }
}

# ORDERING CONSTRAINT Terraform cannot infer.
#
# An app with no `repository` creates its branches in MANUAL-DEPLOY mode,
# and Amplify then refuses to attach a repository while such a branch
# exists:
#
#   BadRequestException: Cannot connect your app to repository while
#   manually deployed branch still exists. Please delete all branches and
#   try again.
#
# Terraform sees only "update the app" and has no reason to destroy the
# branch first, so switching an already-deployed app from manual to
# build-on-push needs the branch removed by hand first:
#
#   terraform destroy -target=aws_amplify_branch.main -var-file=env/dev.tfvars
#   ./do.sh up dev
#
# Setting amplify_repository BEFORE the first apply avoids this entirely.
resource "aws_amplify_branch" "main" {
  app_id      = aws_amplify_app.main.id
  branch_name = local.env
  framework   = "Next.js - SSR"
  stage       = local.env == "main" ? "PRODUCTION" : "DEVELOPMENT"

  # How stakeholders see the demo before Cognito is finished.
  enable_basic_auth = true
  basic_auth_credentials = base64encode(
    "${var.amplify_basic_auth_user}:${var.amplify_basic_auth_password}"
  )

  enable_auto_build = var.amplify_repository != ""
}
