# P7-06 / ADR-0013. This file, and every other .tf file in this
# directory, is real, syntactically valid Terraform — checked with
# `terraform validate`/`terraform fmt -check` in this same session —
# but has never been run against a real AWS account. See README.md's
# own "Verification status" section before treating anything here as
# proven infrastructure rather than a declared, reviewable starting
# point.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.33"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.15"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No remote backend configured. Before the first real `terraform
  # apply` against an actual AWS account, bootstrap a state bucket +
  # DynamoDB lock table by hand ONCE (the one thing Terraform cannot
  # bootstrap itself without something to point at) and uncomment:
  #
  # backend "s3" {
  #   bucket         = "sentinel-terraform-state"
  #   key            = "production/terraform.tfstate"
  #   region         = "ap-south-1"
  #   dynamodb_table = "sentinel-terraform-locks"
  #   encrypt        = true
  # }
}
