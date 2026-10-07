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

export function createKafkaClients(brokers: string[], groupId: string): KafkaClients {
  const kafka = new Kafka({
    clientId: 'sentinel-analyst',
    brokers,
    logLevel: logLevel.ERROR,
  });
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
