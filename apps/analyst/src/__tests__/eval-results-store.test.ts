/**
 * P4-08 AC5: results-over-time persistence — real filesystem writes
 * to a temp directory, no network, no database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeResultsSnapshot, readLatestResult, listResultSnapshots } from '../eval/results-store.js';
import { aggregateResults } from '../eval/scoring.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sentinel-eval-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('results-store', () => {
  it('writes a timestamped snapshot and a latest.json that reads back identically', () => {
    const result = aggregateResults([], () => '2026-01-01T00:00:00.000Z');
    writeResultsSnapshot(result, dir);
    expect(readLatestResult(dir)).toEqual(result);
  });

  it('readLatestResult returns null when no run has ever been recorded', () => {
    expect(readLatestResult(dir)).toBeNull();
  });

  it('listResultSnapshots lists every timestamped run, not just the latest', () => {
    writeResultsSnapshot(aggregateResults([], () => '2026-01-01T00:00:00.000Z'), dir);
    writeResultsSnapshot(aggregateResults([], () => '2026-01-02T00:00:00.000Z'), dir);
    expect(listResultSnapshots(dir)).toHaveLength(2);
  });

  it('a later write updates latest.json to the new run, not the old one', () => {
    writeResultsSnapshot(aggregateResults([], () => '2026-01-01T00:00:00.000Z'), dir);
    writeResultsSnapshot(aggregateResults([], () => '2026-01-02T00:00:00.000Z'), dir);
    expect(readLatestResult(dir)!.timestamp).toBe('2026-01-02T00:00:00.000Z');
  });
});
