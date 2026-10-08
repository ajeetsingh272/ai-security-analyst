import { describe, expect, it } from 'vitest';
import { fleschKincaidGradeLevel, isReadable, TARGET_GRADE_LEVEL } from '../index.js';

describe('fleschKincaidGradeLevel', () => {
  it('scores simple, short sentences at a low grade level', () => {
    const { gradeLevel } = fleschKincaidGradeLevel('Someone signed in from Russia. They copied her messages. This looks bad.');
    expect(gradeLevel).toBeLessThan(TARGET_GRADE_LEVEL);
  });

  it('scores long, complex, jargon-heavy sentences at a higher grade level', () => {
    const plain = fleschKincaidGradeLevel('Someone signed in from Russia and copied her messages.');
    const complex = fleschKincaidGradeLevel(
      'An unauthorized authentication event originating from an anomalous geolocation subsequently facilitated the exfiltration of confidential correspondence through an automated forwarding mechanism.',
    );
    expect(complex.gradeLevel).toBeGreaterThan(plain.gradeLevel);
  });
});

describe('isReadable', () => {
  it('T1 (P4-07) / T4 (P6-07): a plain-English report passes the readability threshold', () => {
    expect(isReadable('Someone in Russia signed in to her account. They set up a rule to copy her emails. Turn off the rule today.')).toBe(true);
  });

  it('a dense, jargon-heavy paragraph fails the threshold', () => {
    expect(
      isReadable(
        'The adversary leveraged credential-based lateral movement techniques to establish persistence via an obfuscated command-and-control channel, facilitating subsequent exfiltration of sensitive organizational data assets through encrypted communication protocols.',
      ),
    ).toBe(false);
  });
});
