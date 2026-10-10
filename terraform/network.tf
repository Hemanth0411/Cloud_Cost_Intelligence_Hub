# The database is reachable from the internet with TLS enforced, because
# Lambda runs outside a VPC: putting it inside one so it could reach a
# private database would require a NAT Gateway (~$32/month) to still reach
# the Cost Explorer API. See TODO-1 and TODO-2.

resource "aws_security_group" "db" {
  name        = "${local.prefix}-db"
  description = "Postgres access for ${local.prefix}"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "Postgres"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.db_public_access_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.prefix}-db" }
}
