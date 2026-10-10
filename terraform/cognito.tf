# Passwordless email OTP. Two hard requirements, both easy to miss:
#   * the ESSENTIALS tier (LITE does not offer passwordless)
#   * Managed Login -- the classic Hosted UI cannot do passwordless
# And email OTP needs SES; Cognito's built-in sender does not support it.

resource "aws_cognito_user_pool" "main" {
  name           = local.prefix
  user_pool_tier = "ESSENTIALS"

  # Invite only. No self-service sign-up surface at all.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  sign_in_policy {
    allowed_first_auth_factors = ["EMAIL_OTP", "PASSWORD"]
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = local.ses_identity_arn
    from_email_address    = var.ses_sender_email
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.presignup.arn
  }

  # Teardown: a protected pool blocks destroy.
  deletion_protection = "INACTIVE"

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 5
      max_length = 256
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.prefix}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret = false # a browser cannot keep one

  explicit_auth_flows = [
    "ALLOW_USER_AUTH", # choice-based auth, which email OTP needs
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  # Shortened deliberately: with a 30-day refresh token nobody would see
  # the OTP flow during a demo week.
  refresh_token_validity = 2
  access_token_validity  = 60
  id_token_validity      = 60
  token_validity_units {
    refresh_token = "days"
    access_token  = "minutes"
    id_token      = "minutes"
  }

  callback_urls = [
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/",
    "http://localhost:5173/",
  ]
  logout_urls = [
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/",
    "http://localhost:5173/",
  ]

  supported_identity_providers         = ["COGNITO"]
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["email", "openid", "profile"]
  allowed_oauth_flows_user_pool_client = true

  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = local.prefix
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2 # 1 is the classic Hosted UI, which cannot do OTP
}
