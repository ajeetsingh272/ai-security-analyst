# ADR-0013: 3 AZs, public+private subnets, one NAT gateway per AZ —
# uses the community terraform-aws-modules/vpc module rather than
# hand-rolling subnet/route-table wiring, the same "don't reinvent a
# well-tested abstraction" discipline this repo already applies
# elsewhere (e.g. choosing Redpanda/ClickHouse's own established
# Helm charts over custom StatefulSet manifests in addons.tf).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.availability_zone_count)
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = "${var.cluster_name}-vpc"
  cidr = var.vpc_cidr
  azs  = local.azs

  private_subnets = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets  = [for i, az in local.azs : cidrsubnet(var.vpc_cidr, 4, i + 8)]

  enable_nat_gateway     = true
  single_nat_gateway     = false # one per AZ — ADR-0013 Alternative D's own "no single-AZ failure" reasoning applies to NAT too
  one_nat_gateway_per_az = true
  enable_dns_hostnames   = true
  enable_dns_support     = true

  # Required tags for the EKS/VPC CNI and AWS Load Balancer Controller
  # to auto-discover subnets for public/internal load balancers.
  public_subnet_tags = {
    "kubernetes.io/role/elb" = "1"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb" = "1"
  }
}
