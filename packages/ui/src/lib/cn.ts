/**
 * Joins class names, dropping falsy values. Not clsx's full feature set (no
 * array/object inputs) — components here only ever build a flat list of
 * static and conditional strings, and a smaller surface is less to get wrong.
 */
import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(...inputs);
}
