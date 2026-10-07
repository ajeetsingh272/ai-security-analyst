import type { SchemaShape } from './parse-schema.d.mts';

export function findBreakingChanges(before: SchemaShape, after: SchemaShape): string[];
export function isMajorBump(beforeVersion: string, afterVersion: string): boolean;
