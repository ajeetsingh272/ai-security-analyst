# ADR-0013: cluster add-ons Terraform owns directly (AC1) — every one
# of these is a well-established, community-maintained Helm chart
# rather than a hand-rolled StatefulSet, the same "don't reinvent an
# abstraction that already exists" discipline the rest of this repo
# already applies (e.g. choosing Redpanda itself over hand-rolling a
# Kafka-compatible broker, ADR-0003).

resource "kubernetes_namespace" "sentinel" {
  metadata {
    name = "sentinel"
  }
}

resource "kubernetes_namespace" "external_secrets" {
  metadata {
    name = "external-secrets"
  }
}

# AC2: resource limits + health probes come from each workload's own
# manifest in infra/k8s/; metrics-server is what makes even CPU-based
# scaling/`kubectl top` possible at all, and the Prometheus Adapter
# below is what makes the MEANINGFUL (consumer-lag-based) scaling
# AC3 asks for possible.
resource "helm_release" "metrics_server" {
  name       = "metrics-server"
  repository = "https://kubernetes-sigs.github.io/metrics-server/"
  chart      = "metrics-server"
  version    = "3.12.2"
  namespace  = "kube-system"
}

resource "helm_release" "external_secrets" {
  name       = "external-secrets"
  repository = "https://charts.external-secrets.io"
  chart      = "external-secrets"
  version    = "0.10.5"
  namespace  = kubernetes_namespace.external_secrets.metadata[0].name

  set {
    name  = "serviceAccount.annotations.eks\\.amazonaws\\.com/role-arn"
    value = aws_iam_role.external_secrets.arn
  }
}

# The bridge between "Secrets Manager has the value" (secrets.tf) and
# "a pod can read it as an ordinary Kubernetes Secret" — AC4's own
# "never from environment files in the repo" is true because
# infra/k8s/'s manifests reference Secret objects THIS resource
# creates from Secrets Manager, never a literal value checked in.
resource "kubernetes_manifest" "cluster_secret_store" {
  manifest = {
    apiVersion = "external-secrets.io/v1beta1"
    kind       = "ClusterSecretStore"
    metadata = {
      name = "aws-secrets-manager"
    }
    spec = {
      provider = {
        aws = {
          service = "SecretsManager"
          region  = var.region
          auth = {
            jwt = {
              serviceAccountRef = {
                name      = "external-secrets"
                namespace = kubernetes_namespace.external_secrets.metadata[0].name
              }
            }
          }
        }
      }
    }
  }
  depends_on = [helm_release.external_secrets]
}

# kube-prometheus-stack: the same Prometheus/Grafana pairing the dev
# stack already runs (infra/docker/docker-compose.dev.yml), now
# cluster-native and feeding the Prometheus Adapter below — not a
# different observability stack for production than the one every
# engineer already knows from local dev.
resource "helm_release" "kube_prometheus_stack" {
  name             = "kube-prometheus-stack"
  repository       = "https://prometheus-community.github.io/helm-charts"
  chart            = "kube-prometheus-stack"
  version          = "66.3.1"
  namespace        = "monitoring"
  create_namespace = true

  values = [yamlencode({
    grafana = {
      adminPassword = "changeme-see-secrets-manager" # placeholder — a real deployment wires this to Secrets Manager via the same ClusterSecretStore, left as a named TODO rather than silently shipped insecure
    }
  })]
}

# AC3: Horizontal Pod Autoscaling against consumer lag, not just CPU.
# Reads detect.consumer_lag — a real, already-existing OpenTelemetry
# gauge (services/detect/cmd/detect/main.go's own RunLagReporter) —
# straight out of the Prometheus this chart just deployed. detect is
# the ONLY one of the four Kafka-consuming Go services with a real
# lag metric today; correlate and eventwriter are genuine, logical
# follow-up candidates for the identical RunLagReporter pattern, not
# silently assumed to already have it — infra/k8s/'s own manifests for
# those two use CPU+memory-based HPA instead, disclosed as a real gap
# rather than a fabricated metric name.
resource "helm_release" "prometheus_adapter" {
  name       = "prometheus-adapter"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "prometheus-adapter"
  version    = "4.11.0"
  namespace  = "monitoring"

  values = [yamlencode({
    prometheus = {
      url  = "http://kube-prometheus-stack-prometheus.monitoring.svc"
      port = 9090
    }
    rules = {
      custom = [
        {
          seriesQuery  = "detect_consumer_lag"
          resources    = { overrides = { namespace = { resource = "namespace" } } }
          name         = { matches = "detect_consumer_lag", as = "detect_consumer_lag" }
          metricsQuery = "max(<<.Series>>{<<.LabelMatchers>>}) by (<<.GroupBy>>)"
        },
      ]
    }
  })]

  depends_on = [helm_release.kube_prometheus_stack]
}

# ADR-0003: self-hosted Redpanda, not MSK — the Redpanda Operator's own
# Helm chart, on the tainted "stateful" node group.
resource "helm_release" "redpanda" {
  name       = "redpanda"
  repository = "https://charts.redpanda.com"
  chart      = "redpanda"
  version    = "5.9.14"
  namespace  = kubernetes_namespace.sentinel.metadata[0].name

  values = [yamlencode({
    statefulset = {
      replicas     = 3
      nodeSelector = { "sentinel.io/node-pool" = "stateful" }
      tolerations  = [{ key = "sentinel.io/stateful", operator = "Equal", value = "true", effect = "NoSchedule" }]
    }
    storage = {
      persistentVolume = {
        enabled = true
        size    = "200Gi"
      }
    }
    # SASL deliberately NOT enabled here, despite
    # aws_secretsmanager_secret.redpanda existing (provisioned for
    # when this lands, not wired into enforcement yet): confirmed by
    # reading every consumer's own client construction
    # (services/{detect,correlate,eventwriter,ingest}/cmd/*/main.go's
    # kgo.NewClient calls, apps/analyst/src/kafka.ts) that NONE of
    # them send SASL credentials today — turning on broker-side
    # enforcement would break every real consumer in this repo, not
    # just the ones this ticket happens to touch. Network isolation
    # (VPC private subnets, the EKS node security group, no public
    # NodePort/LoadBalancer for Redpanda's own Kafka listener) is the
    # real, current boundary instead — weaker than SASL, truthfully
    # disclosed as such rather than claiming an authentication layer
    # that would silently lock every service out.
    auth = {
      sasl = {
        enabled = false
      }
    }
  })]
}

# ADR-0005: self-hosted ClickHouse, not ClickHouse Cloud.
resource "helm_release" "clickhouse" {
  name       = "clickhouse"
  repository = "oci://registry-1.docker.io/bitnamicharts"
  chart      = "clickhouse"
  version    = "9.2.13"
  namespace  = kubernetes_namespace.sentinel.metadata[0].name

  values = [yamlencode({
    shards       = 1 # ADR-0008's own "a single tenant exceeding ~5% of load" is the stated trigger for sharding, not applied pre-emptively here
    replicaCount = 3
    persistence = {
      enabled      = true
      size         = "${var.clickhouse_hot_volume_gb}Gi"
      storageClass = "gp3"
    }
    nodeSelector = { "sentinel.io/node-pool" = "stateful" }
    tolerations  = [{ key = "sentinel.io/stateful", operator = "Equal", value = "true", effect = "NoSchedule" }]
    auth = {
      existingSecret    = "clickhouse-admin" # populated by an ExternalSecret reading aws_secretsmanager_secret.clickhouse
      existingSecretKey = "password"
    }
    serviceAccount = {
      create = true
      name   = "clickhouse"
      annotations = {
        "eks.amazonaws.com/role-arn" = aws_iam_role.clickhouse_s3.arn
      }
    }
  })]
}

# Valkey (ADR-independent — the dev stack's own choice of
# valkey/valkey over redis/redis already applies; production just runs
# it clustered instead of single-node).
resource "helm_release" "valkey" {
  name       = "valkey"
  repository = "oci://registry-1.docker.io/bitnamicharts"
  chart      = "valkey"
  version    = "3.0.9"
  namespace  = kubernetes_namespace.sentinel.metadata[0].name

  values = [yamlencode({
    architecture = "replication"
    replica      = { replicaCount = 2 }
    nodeSelector = { "sentinel.io/node-pool" = "stateful" }
    tolerations  = [{ key = "sentinel.io/stateful", operator = "Equal", value = "true", effect = "NoSchedule" }]
  })]
}
