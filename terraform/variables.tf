# Per-environment values live in env/<env>.tfvars -- one file each, and
# nowhere else. The environment itself comes from the Terraform workspace
# (see main.tf), so state and environment cannot disagree.

variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "Cost Explorer and Budgets are us-east-1 only, wherever else this runs."
}

variable "name_prefix" {
  type        = string
  default     = "costhub"
  description = "Suffixed with the workspace; do not include the environment here."
}

# ---- administration --------------------------------------------------
variable "superadmin_email" {
  type        = string
  description = "Seeded as the first superadmin. Must be in allowed_email_domain."
}

variable "allowed_email_domain" {
  type    = string
  default = "chryselys.com"
}

# ---- email (REQUIRED: email OTP does not work without SES) ----------
variable "ses_sender_email" {
  type        = string
  description = "A verified SES identity. Login OTPs are sent from here."
}

# ---- frontend --------------------------------------------------------
variable "amplify_basic_auth_user" {
  type    = string
  default = "demo"
}

variable "amplify_basic_auth_password" {
  type        = string
  sensitive   = true
  description = "Gates the demo for stakeholders before Cognito is finished."
}

variable "amplify_repository" {
  type        = string
  default     = ""
  description = "Optional git repo for auto-deploy. Left empty, deploys are manual, which keeps a PAT out of Terraform state."
}

variable "amplify_access_token" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Only needed when amplify_repository is set."
}

# ---- database --------------------------------------------------------
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "costhub"
}

variable "db_username" {
  type    = string
  default = "costhub_app"
}

variable "db_public_access_cidrs" {
  type        = list(string)
  default     = ["0.0.0.0/0"]
  description = <<-TXT
    Who may reach the database. Open by default because Lambda runs
    outside a VPC and so has no fixed address to allowlist -- putting it
    in one would need a NAT Gateway at ~$32/month, more than the rest of
    the stack combined. TLS is enforced and the password is generated.
    This is TODO-2 in docs/10-todo-future.md, not an oversight.
  TXT
}

# ---- data sources ----------------------------------------------------
variable "data_source_accounts" {
  description = "Cloud accounts to read cost from. account_id 'self' = this account."
  type = list(object({
    account_id  = string
    name        = string
    role_arn    = optional(string)
    external_id = optional(string)
  }))
  default = []
}

# ---- operations ------------------------------------------------------
variable "excluded_availability_zones" {
  type        = list(string)
  default     = ["us-east-1e"]
  description = <<-TXT
    AZs to keep out of the DB subnet group. us-east-1e does not offer
    every instance-class/storage combination, so including it makes RDS
    placement fail non-deterministically. Named rather than discovered,
    because the discovery data source needs an extra IAM permission.
  TXT
}

variable "log_retention_days" {
  type    = number
  default = 7
}

variable "ingest_schedule" {
  type        = string
  default     = "cron(0 6 * * ? *)"
  description = "06:00 UTC: cost data for yesterday has usually landed by then."
}

variable "anomaly_schedule" {
  type    = string
  default = "cron(30 6 * * ? *)"
}

variable "alerts_schedule" {
  type    = string
  default = "cron(0 7 * * ? *)"
}

variable "budget_limit_usd" {
  type        = number
  default     = 80
  description = "On the AWS Free plan, exhausted credits SUSPEND resources rather than bill."
}
