/**
 * THROWAWAY — proves P0-02 T1: a PR with a deliberately failing TypeScript test
 * is blocked from merging. Never merged to main; this file and the branch that
 * carries it are deleted once the probe PR confirms the required check fails
 * and the merge is blocked.
 */
import { describe, expect, it } from 'vitest';

describe('ci merge-block probe', () => {
  it('deliberately fails', () => {
    expect(true).toBe(false);
  });
});
