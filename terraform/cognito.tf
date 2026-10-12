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
    # EMAIL_OTP only. Leaving PASSWORD in the list made the pool
    # password-capable, and AdminCreateUser on a password-capable pool
    # generates a temporary password -- which puts the seeded superadmin
    # into FORCE_CHANGE_PASSWORD, a state an OTP-only client cannot
    # clear. The comment on aws_cognito_user below claiming "the pool is
    # passwordless" was false until this line changed.
    allowed_first_auth_factors = ["EMAIL_OTP"]
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

  read_attributes = ["email", "email_verified"]

  # write_attributes is deliberately NOT set to []. AWS exempts required
  # attributes from it -- all app clients can write a pool's required
  # attributes -- and `email` is required = true in the schema above, so
  # the empty list was either silently ignored or an apply error. It read
  # like a control and was not one.
  #
  # The actual defence against a user rewriting their email to a
  # superadmin's address is in the API: api/deps.py requires
  # email_verified to be exactly True before it will look the row up, and
  # changing email through Cognito resets email_verified to false.
}

resource "aws_cognito_user_pool_domain" "main" {
  domain                = "${local.prefix}-${data.aws_caller_identity.current.account_id}"
  user_pool_id          = aws_cognito_user_pool.main.id
  managed_login_version = 2 # 1 is the classic Hosted UI, which cannot do OTP
}


# The first superadmin, created declaratively.
#
# Without this, `invite_user` writes a Postgres row and nothing else:
# the user does not exist in the pool, so Cognito can never send them a
# code. A fresh environment had zero users and no way in.
#
# No password and no temporary_password: the pool is passwordless, and
# AdminCreateUser without a password puts the user straight into
# CONFIRMED rather than FORCE_CHANGE_PASSWORD.
resource "aws_cognito_user" "superadmin" {
  user_pool_id = aws_cognito_user_pool.main.id

  # The pool's pre-sign-up trigger fires on AdminCreateUser too, and
  # Cognito needs permission to invoke it. Without an explicit edge
  # Terraform is free to create this user before that permission exists,
  # which fails the apply roughly half the time -- the kind of bug that
  # passes once and breaks a demo.
  depends_on = [aws_lambda_permission.cognito_presignup]
  username   = var.superadmin_email

  attributes = {
    email          = var.superadmin_email
    email_verified = true
  }

  # SUPPRESS: no invitation email. The user signs in with an email OTP,
  # so there is nothing to send them in advance.
  message_action = "SUPPRESS"

  lifecycle {
    # Changing the superadmin's address should not silently destroy and
    # recreate the account that administers the environment.
    ignore_changes = [attributes]
  }
}
