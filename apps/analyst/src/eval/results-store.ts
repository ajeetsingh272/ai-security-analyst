/**
 * P4-08 AC5: "results are tracked over time so drift is visible" — one
 * timestamped JSON file per run, plus "the latest one," so
 * `detectDrift` (scoring.ts) always has something real to compare
 * against without needing to parse every filename's own timestamp.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { SuiteResult } from './scoring.js';

export function writeResultsSnapshot(result: SuiteResult, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const filename = `eval-${result.timestamp.replace(/[:.]/g, '-')}.json`;
  const filePath = path.join(dir, filename);
  writeFileSync(filePath, JSON.stringify(result, null, 2));
  writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 2));
  return filePath;
}

export function readLatestResult(dir: string): SuiteResult | null {
  const latestPath = path.join(dir, 'latest.json');
  if (!existsSync(latestPath)) return null;
  return JSON.parse(readFileSync(latestPath, 'utf8')) as SuiteResult;
}

export function listResultSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith('eval-') && f.endsWith('.json'))
    .sort();
}
