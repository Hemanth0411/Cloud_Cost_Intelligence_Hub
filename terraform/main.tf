terraform {
  required_version = ">= 1.5"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 5.70" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
    archive = { source = "hashicorp/archive", version = "~> 2.6" }
  }
}

# The workspace IS the environment. Deriving it rather than passing a
# variable means state and environment cannot disagree -- there is no
# flag to forget -- and `terraform destroy` in dev physically cannot
# reach main.
locals {
  env    = terraform.workspace
  prefix = "${var.name_prefix}-${terraform.workspace}"
}

# Refuse to run in the implicit `default` workspace, which would otherwise
# create an unnamed fourth environment by accident.
resource "terraform_data" "workspace_guard" {
  input = local.env

  lifecycle {
    precondition {
      condition     = contains(["dev", "staging", "main"], terraform.workspace)
      error_message = "Select a workspace first: terraform workspace select dev|staging|main"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Tagging everything is what makes `make sweep` able to PROVE a teardown
  # removed everything, rather than assuming it did.
  default_tags {
    tags = {
      Project     = var.name_prefix
      Environment = local.env
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Default VPC, so there is no network to build or tear down.
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
