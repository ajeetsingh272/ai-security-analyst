import { describe, expect, it } from 'vitest';
import { glossJargon, findUnglossedJargon, JARGON_GLOSSARY } from '../jargon.js';

describe('glossJargon', () => {
  it('glosses the first occurrence of a known jargon term', () => {
    const result = glossJargon('An inbox rule was created to forward messages.');
    expect(result).toContain(`inbox rule (${JARGON_GLOSSARY['inbox rule']})`);
  });

  it('does not re-gloss a second occurrence of the same term', () => {
    const result = glossJargon('OAuth was used. Later, OAuth was used again.');
    expect(result.match(/\(a way apps get permission/g)).toHaveLength(1);
  });

  it('leaves text with no jargon unchanged', () => {
    expect(glossJargon('Nothing technical here at all.')).toBe('Nothing technical here at all.');
  });

  it('does not match jargon as a substring of an unrelated word', () => {
    // "mfa" must not match inside "umfazi" or similar — word boundaries only.
    expect(glossJargon('umfazi is not a security term')).toBe('umfazi is not a security term');
  });
});

describe('findUnglossedJargon', () => {
  it('T2: finds no unglossed term once glossJargon has run', () => {
    const text = glossJargon('An inbox rule forwarded her messages via OAuth.');
    expect(findUnglossedJargon(text)).toEqual([]);
  });

  it('T2: finds a jargon term that was never glossed', () => {
    expect(findUnglossedJargon('The attacker used an inbox rule to forward messages.')).toContain('inbox rule');
  });

  it('does not flag a term that never appears in the text at all', () => {
    expect(findUnglossedJargon('Nothing technical here.')).toEqual([]);
  });
});
