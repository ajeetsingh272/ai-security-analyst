# ADR-0013: Amazon EKS, managed node groups — not self-managed EC2 +
# kubeadm. Two node groups: "apps" for the seven Sentinel application
# workloads (infra/k8s/), "stateful" for ClickHouse/Redpanda/Valkey
# (addons.tf), tainted so ordinary app pods never schedule onto
# storage-heavy nodes meant for a StatefulSet.

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.31"

  cluster_name    = var.cluster_name
  cluster_version = "1.30"

  vpc_id                   = module.vpc.vpc_id
  subnet_ids               = module.vpc.private_subnets
  control_plane_subnet_ids = module.vpc.private_subnets

  # IRSA (IAM Roles for Service Accounts) — what lets the External
  # Secrets Operator and the ClickHouse/Redpanda pods assume a
  # narrowly-scoped IAM role (read Secrets Manager, read/write the
  # cold-tier S3 bucket) without ever holding a static AWS access key
  # anywhere in the cluster.
  enable_irsa = true

  cluster_endpoint_public_access = true # restricted to known CIDRs in a real deployment; left open here as a declared starting point, not a recommendation to apply as-is

  eks_managed_node_groups = {
    apps = {
      instance_types = var.eks_node_instance_types
      min_size       = var.eks_node_min_size
      max_size       = var.eks_node_max_size
      desired_size   = var.eks_node_min_size

      labels = {
        "sentinel.io/node-pool" = "apps"
      }
    }

    stateful = {
      # Larger, fewer nodes — ClickHouse/Redpanda/Valkey StatefulSets,
      # not autoscaled by the HPA (they scale by adding replicas
      # deliberately, a capacity-planning decision, not a reactive one).
      instance_types = ["r6i.2xlarge"]
      min_size       = 3
      max_size       = 3
      desired_size   = 3

      labels = {
        "sentinel.io/node-pool" = "stateful"
      }
      taints = {
        stateful = {
          key    = "sentinel.io/stateful"
          value  = "true"
          effect = "NO_SCHEDULE"
        }
      }
    }
  }
}
