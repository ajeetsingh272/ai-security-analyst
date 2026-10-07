/**
 * P4-11 AC2/AC4: replays a captured transcript against a different
 * model (or the same one, for regression comparison) WITHOUT ever
 * calling a tool live or taking any real action — the captured
 * `messages` already contains every `tool_result` from the original
 * run, so replay only ever asks a model for a FINAL answer from
 * evidence that already settled, never to gather new evidence. That
 * alone is what makes "replay never emits a real alert or executes a
 * real action" true by construction: no tool call, no Kafka produce,
 * no report render happens anywhere in this file.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Verdict } from '@sentinel/schema';
import { parseVerdict } from './investigation-model.js';
import type { Transcript } from './transcript.js';

export interface ReplayOptions {
  apiKey: string;
  /** The model/prompt version to replay against — deliberately
   * independent of `transcript.model`, since testing "would a
   * DIFFERENT model draw a different conclusion from the SAME
   * evidence" is the entire point (AC2). */
  model: string;
  client?: Anthropic;
  maxTokens?: number;
}

export async function replayInvestigation(transcript: Transcript, opts: ReplayOptions): Promise<Verdict> {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  const response = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: transcript.system,
    messages: transcript.messages,
  });
  const block = response.content.find((b) => b.type === 'text');
  const text = block && block.type === 'text' ? block.text : '';
  return parseVerdict(text);
}
