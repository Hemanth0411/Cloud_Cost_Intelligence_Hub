resource "aws_db_subnet_group" "main" {
  name       = "${local.prefix}-db"
  subnet_ids = data.aws_subnets.default.ids
}

# A custom parameter group only to force TLS; the default group cannot be
# modified.
resource "aws_db_parameter_group" "main" {
  name   = "${local.prefix}-pg16"
  family = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "main" {
  identifier     = "${local.prefix}-db"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username
  password = random_password.db.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.main.name
  publicly_accessible    = true

  backup_retention_period    = local.env == "main" ? 7 : 1
  apply_immediately          = true
  auto_minor_version_upgrade = true

  # Teardown flags. Without all three, `terraform destroy` stalls or
  # leaves a snapshot behind that blocks the next apply.
  skip_final_snapshot = true
  deletion_protection = false

  tags = { Name = "${local.prefix}-db" }
}
