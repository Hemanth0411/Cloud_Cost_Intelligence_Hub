resource "random_password" "db" {
  length  = 32
  special = false # avoids quoting pain in connection strings
}

resource "aws_secretsmanager_secret" "db" {
  name = "${var.name_prefix}/${local.env}/database-url"

  # Default is a 30-day recovery window, which makes destroy-then-recreate
  # fail with "secret already scheduled for deletion". Zero is required
  # for the teardown flow to be repeatable.
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
    host     = aws_db_instance.main.address
    port     = aws_db_instance.main.port
    dbname   = var.db_name
    url      = local.database_url
  })
}

locals {
  database_url = join("", [
    "postgresql://", var.db_username, ":", random_password.db.result,
    "@", aws_db_instance.main.address, ":", aws_db_instance.main.port,
    "/", var.db_name, "?sslmode=require",
  ])
}
