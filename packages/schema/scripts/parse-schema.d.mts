export type SchemaType =
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'array'; of: SchemaType }
  | { kind: 'ref'; name: string };

export interface SchemaField {
  name: string;
  optional: boolean;
  type: SchemaType;
}

export interface SchemaInterface {
  fields: SchemaField[];
}

export interface SchemaShape {
  version: string;
  unions: Record<string, string[]>;
  interfaces: Record<string, SchemaInterface>;
}

export function parseSchema(filePath: string): SchemaShape;
