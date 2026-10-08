/**
 * P4-07 AC5: "a readability check gates on a target reading level."
 * Promoted to @sentinel/readability (P6-07), so the weekly owner
 * report — generated from apps/api, a separate process with no
 * dependency on apps/analyst — can gate its own copy against the
 * IDENTICAL threshold, rather than a second, independently-drifting
 * copy of the same formula. Re-exported here unchanged so this file's
 * own existing imports (and its own test, readability.test.ts) keep
 * working without modification.
 */
export { TARGET_GRADE_LEVEL, fleschKincaidGradeLevel, isReadable, type ReadabilityResult } from '@sentinel/readability';
