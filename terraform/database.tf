# Taking EVERY default subnet includes AZs that do not offer every
# instance-class/storage combination (us-east-1e is the usual culprit),
# so RDS can fail with an unsupported-AZ error non-deterministically
# between environments.
#
# Excluded by NAME rather than by querying aws_rds_orderable_db_instance:
# that data source needs rds:DescribeOrderableDBInstanceOptions, so it
# adds a permission to request and a fresh way for `plan` to fail --
# exactly the trap already removed from the SES lookup in messaging.tf.
# I reintroduced it here and the plan failed the same way; a variable
# keeps this overridable without needing a new grant.
data "aws_subnet" "default" {
  for_each = toset(data.aws_subnets.default.ids)
  id       = each.value
}

locals {
  usable_subnet_ids = [
    for id, s in data.aws_subnet.default : id
    if !contains(var.excluded_availability_zones, s.availability_zone)
  ]
}

resource "aws_db_subnet_group" "main" {
  name = "${local.prefix}-db"
  # RDS needs at least two AZs; fall back to all of them rather than
  # failing the plan if the exclusion list is somehow too aggressive.
  subnet_ids = length(local.usable_subnet_ids) >= 2 ? local.usable_subnet_ids : data.aws_subnets.default.ids
}

# A custom parameter group only to force TLS; the default group cannot be
# modified.
resource "aws_db_parameter_group" "main" {
  # name_prefix, not name: create_before_destroy with a fixed name
  # guarantees DBParameterGroupAlreadyExists the first time anything
  # forces replacement (e.g. bumping family to postgres17).
  name_prefix = "${local.prefix}-pg"
  family      = "postgres16"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
    # rds.force_ssl is a STATIC parameter, and RDS rejects the provider's
    # default apply_method of "immediate" for static parameters with
    # InvalidParameterCombination. pending-reboot is the only valid value
    # -- and because the instance is created WITH this group attached, the
    # setting is in effect from first boot; no reboot is pending.
    apply_method = "pending-reboot"
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
