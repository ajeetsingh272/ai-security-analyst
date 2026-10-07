/**
 * Redpanda/Kafka client setup (P4-01) — kafkajs, the first TypeScript
 * Kafka client in this repo (every other consumer/producer so far is
 * Go's franz-go). Mirrors go/sentinelstream's own topic/key
 * conventions directly rather than reinventing them in TypeScript:
 * the `cases` topic name and its `tenant_id:case_id` key format are
 * sentinelstream.Cases / sentinelstream.TenantCaseKey's own literal
 * values, just written here since this package has no Go bridge.
 */
import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';

export const CASES_TOPIC = 'cases';
export const CASES_DLQ_TOPIC = 'cases.dlq';

export function tenantCaseKey(tenantId: string, caseId: string): string {
  return `${tenantId}:${caseId}`;
}

export interface CaseEventMessage {
  tenant_id: string;
  case_id: string;
}

export function parseCaseEventMessage(value: Buffer | string | null): CaseEventMessage {
  if (value === null) {
    throw new Error('cases message had no value');
  }
  const parsed = JSON.parse(value.toString());
  if (typeof parsed.tenant_id !== 'string' || typeof parsed.case_id !== 'string') {
    throw new Error(`cases message did not have the expected {tenant_id, case_id} shape: ${value.toString()}`);
  }
  return parsed;
}

export interface KafkaClients {
  consumer: Consumer;
  producer: Producer;
  disconnect: () => Promise<void>;
}

// `cases`/`cases.dlq`'s own partition/retention spec, mirrored from
// go/sentinelstream.MainTopics (topics.go) — this is the first real
// consumer/producer for these topics that isn't a Go service, so there is
// no go/sentinelstream.Provisioner running ahead of it to guarantee the
// topic already exists with the right partition count. Without this,
// kafkajs's own default (allow topic auto-creation on subscribe/send) lets
// Redpanda silently auto-create `cases` with its broker-default partition
// count the first time anything here touches it — observed for real in
// CI, where this package's own integration tests run before
// go/sentinelstream's, leaving `cases` stuck at 1 partition for the life
// of that broker (Provisioner.Apply treats TOPIC_ALREADY_EXISTS as an
// idempotent no-op and never corrects an existing topic's partition
// count). Explicitly provisioning here first closes that race, the same
// way services/ingest's own startup calls Provisioner.Apply before
// touching Kafka.
const RETENTION_MS = String(30 * 24 * 60 * 60 * 1000);

export async function provisionCasesTopics(kafka: Kafka): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        { topic: CASES_TOPIC, numPartitions: 16, replicationFactor: 1, configEntries: [{ name: 'retention.ms', value: RETENTION_MS }] },
        { topic: CASES_DLQ_TOPIC, numPartitions: 4, replicationFactor: 1, configEntries: [{ name: 'retention.ms', value: RETENTION_MS }] },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

export async function createKafkaClients(brokers: string[], groupId: string): Promise<KafkaClients> {
  const kafka = new Kafka({
    clientId: 'sentinel-analyst',
    brokers,
    logLevel: logLevel.ERROR,
  });
  await provisionCasesTopics(kafka);
  const consumer = kafka.consumer({ groupId });
  const producer = kafka.producer();
  return {
    consumer,
    producer,
    disconnect: async () => {
      await Promise.all([consumer.disconnect(), producer.disconnect()]);
    },
  };
}
