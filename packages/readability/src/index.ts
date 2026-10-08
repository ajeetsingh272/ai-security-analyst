/**
 * P4-07 AC5 / P6-07: "a readability check gates on a target reading
 * level" — the Flesch-Kincaid Grade Level formula, a deterministic,
 * widely published readability metric (no model call, no external
 * service). Syllable counting is a heuristic (vowel-group counting
 * with common English exceptions), not a dictionary lookup — accurate
 * enough for a gate, not claimed to be a precise linguistic analysis.
 *
 * Promoted out of apps/analyst/src/readability.ts (P4-07's own
 * original home) into this shared package so P6-07's weekly owner
 * report — generated from apps/api, a separate deployable process with
 * no dependency on apps/analyst — can gate its own copy against the
 * IDENTICAL threshold case reports use, rather than a second,
 * independently-drifting copy of the same 60-line formula.
 * apps/analyst/src/readability.ts now re-exports this package; nothing
 * about its own behaviour changed.
 */

/**
 * Flesch-Kincaid is known to be noisy on SHORT passages — a single
 * short sentence containing one or two necessarily multi-syllable
 * words (e.g. "fraud preparation," "critical") can swing several grade
 * levels on its own, since the formula averages syllables per word
 * over very few words. 10 is calibrated empirically against this
 * package's own two reference texts (readability.test.ts): a
 * realistic, plain-English security-report sentence scores ~8, while
 * genuinely dense, jargon-heavy prose scores 25+ — a wide enough
 * margin that 10 cleanly separates the two without being so strict
 * that ordinary short sentences containing one unavoidable
 * multi-syllable word fail the gate on noise alone.
 */
export const TARGET_GRADE_LEVEL = 10;

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  // Silent trailing 'e' (but not '-le' as in "little").
  const stripped = w.endsWith('e') && !w.endsWith('le') ? w.slice(0, -1) : w;
  const groups = stripped.match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function splitSentences(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
}

export interface ReadabilityResult {
  gradeLevel: number;
  wordCount: number;
  sentenceCount: number;
}

export function fleschKincaidGradeLevel(text: string): ReadabilityResult {
  const sentences = splitSentences(text);
  const words = splitWords(text);
  const sentenceCount = Math.max(1, sentences.length);
  const wordCount = Math.max(1, words.length);
  const syllableCount = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const gradeLevel = 0.39 * (wordCount / sentenceCount) + 11.8 * (syllableCount / wordCount) - 15.59;
  return { gradeLevel, wordCount, sentenceCount };
}

/** T1 (P4-07) / T4 (P6-07): "generated reports pass the readability threshold." */
export function isReadable(text: string, targetGradeLevel: number = TARGET_GRADE_LEVEL): boolean {
  return fleschKincaidGradeLevel(text).gradeLevel <= targetGradeLevel;
}
