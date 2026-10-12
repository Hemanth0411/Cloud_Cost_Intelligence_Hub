output "environment" {
  value = local.env
}

output "frontend_url" {
  description = "Branch URL. Basic-auth protected; share with the credentials."
  value       = "https://${aws_amplify_branch.main.branch_name}.${aws_amplify_app.main.default_domain}"
}

output "api_url" {
  value = aws_apigatewayv2_stage.default.invoke_url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_domain" {
  value = "${aws_cognito_user_pool_domain.main.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "database_endpoint" {
  value = aws_db_instance.main.endpoint
}

output "database_secret_arn" {
  description = "Read the connection string from here; it is not an output."
  value       = aws_secretsmanager_secret.db.arn
}

output "database_url" {
  description = "For `make migrate`. Sensitive: never echo this into a log."
  value       = local.database_url
  sensitive   = true
}

output "amplify_app_id" {
  description = "For manual deploys: aws amplify create-deployment --app-id ..."
  value       = aws_amplify_app.main.id
}

# What `make sweep` greps for after a teardown.
output "resource_tags" {
  value = {
    Project     = var.name_prefix
    Environment = local.env
  }
}

# Read by `./do.sh restore`, which has to delete the row migration 006
# seeds before replaying a backup that contains the same email.
output "superadmin_email" {
  value = var.superadmin_email
}
