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
    # PASSWORD IS MANDATORY HERE. Cognito rejects a list without it:
    #
    #   InvalidParameterException: Password should be configured as one
    #   of the allowed first auth factors.
    #
    # This briefly said ["EMAIL_OTP"] alone, on the theory that leaving
    # PASSWORD in made the pool "password-capable" and would push the
    # seeded superadmin into FORCE_CHANGE_PASSWORD. That was wrong twice
    # over: the list is invalid without PASSWORD, and AdminCreateUser
    # does not generate a password when a passwordless factor is active.
    # Per the AdminCreateUser docs on TemporaryPassword: "If you don't
    # specify a value, Amazon Cognito generates one for you UNLESS you
    # have passwordless options active for your user pool."
    #
    # So listing EMAIL_OTP is what makes the omitted password mean
    # "passwordless, CONFIRMED" rather than "generate a temporary one".
    # Including PASSWORD does not weaken that: the app client below
    # enables only the choice-based flow, and no screen offers a
    # password.
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

    # Direct email + password sign-in, so the app can post credentials to
    # InitiateAuth and get tokens back WITHOUT the hosted-page redirect.
    # That redirect is what made OTP unpleasant: it leaves the app for an
    # AWS-skinned page mid-flow.
    #
    # USER_PASSWORD_AUTH, not USER_SRP_AUTH. SRP never puts the password
    # on the wire, which is better, and it needs an SRP implementation in
    # the browser. This is one HTTPS POST. The trade is deliberate and
    # the password still only travels to Cognito over TLS.
    #
    # OTP IS KEPT as a fallback -- `allowed_first_auth_factors` below
    # still lists EMAIL_OTP, and /login still offers it. Removing it
    # would also strand the Terraform-created superadmin: a user created
    # with no password only lands on CONFIRMED because a passwordless
    # factor is active.
    "ALLOW_USER_PASSWORD_AUTH",
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

  # PORT 3000, NOT 5173. The frontend is Next.js (`next dev` serves on
  # 3000); 5173 was Vite's port, from the frontend this one replaced. A
  # redirect_uri that is not listed here fails at Cognito with
  # `redirect_mismatch` before any code is issued, so local sign-in is
  # simply impossible without it.
  #
  # Both `/auth/callback` and the bare origin are listed. The app uses
  # `/auth/callback`: Next's root page is a server component that
  # redirects to /dashboard, and a server redirect DROPS the query
  # string -- so a code delivered to `/` is lost before any client code
  # can read it. The bare origin stays listed so a hand-built authorize
  # URL against the root still works.
  callback_urls = [
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/auth/callback",
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/",
    "http://localhost:3000/auth/callback",
    "http://localhost:3000/",
  ]
  logout_urls = [
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/login",
    "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}/",
    "http://localhost:3000/login",
    "http://localhost:3000/",
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
# No password and no temporary_password. Because EMAIL_OTP is an active
# first-auth factor, AdminCreateUser treats the omission as "create a
# passwordless user" and lands on CONFIRMED -- it only generates a
# temporary password (and so FORCE_CHANGE_PASSWORD) for pools with no
# passwordless option. That is why sign_in_policy above must keep
# EMAIL_OTP listed, and why it must also keep PASSWORD: Cognito refuses
# the list without it.
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
