provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "sentinel"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Configured against whatever cluster module.eks actually creates —
# terraform_remote_state-free because this is all one root module; a
# real multi-environment setup would split these into separate state
# files, deliberately not done here (P7-11, cuttable, is the ticket
# that would need that).
provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  token                  = data.aws_eks_cluster_auth.this.token
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    token                  = data.aws_eks_cluster_auth.this.token
  }
}

data "aws_eks_cluster_auth" "this" {
  name = module.eks.cluster_name
}
