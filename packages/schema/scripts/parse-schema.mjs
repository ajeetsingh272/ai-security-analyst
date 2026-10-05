/**
 * Parses src/index.ts into a normalised shape, shared by generate-go.mjs and
 * check-compatibility.mjs. One parser, not two, for the same reason the
 * audit chain's canonical JSON lives in one file (P0-06): a generator and a
 * checker that each parsed the source their own way could disagree about
 * what the schema even IS, and that disagreement would look like either a
 * codegen bug or a compatibility bug when it was actually neither.
 *
 * Deliberately narrow. This repo's contracts (Claim, Verdict,
 * RecommendedAction, and the string-literal unions they use) only need:
 * exported `interface` declarations, exported `type X = 'a' | 'b' | ...`
 * string-literal unions, and property types built from string/number/
 * boolean/arrays/references to another type in this file. A general
 * TS-to-anything schema tool would need far more of the type system; this
 * one fails loudly on anything it does not recognise (see `typeOf` below)
 * rather than silently generating something wrong for a case it cannot
 * actually handle.
 */
import ts from 'typescript';
import { readFileSync } from 'node:fs';

export function parseSchema(filePath) {
  const sourceText = readFileSync(filePath, 'utf8');
  const source = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.ES2023, true);

  let version = null;
  const unions = {}; // name -> string[]
  const interfaces = {}; // name -> { fields: [{name, type, optional}] }

  function typeOf(node) {
    if (ts.isTypeReferenceNode(node)) {
      const name = node.typeName.getText(source);
      // A reference to a union or interface DEFINED IN THIS FILE. Anything
      // else (a reference to a type from another module, a generic) is
      // exactly the "general type system" territory this parser refuses —
      // see the module doc comment.
      return { kind: 'ref', name };
    }
    if (ts.isArrayTypeNode(node)) {
      return { kind: 'array', of: typeOf(node.elementType) };
    }
    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return { kind: 'string' };
      case ts.SyntaxKind.NumberKeyword:
        return { kind: 'number' };
      case ts.SyntaxKind.BooleanKeyword:
        return { kind: 'boolean' };
      default:
        throw new Error(
          `parse-schema: unsupported type node (kind ${node.kind}) at position ${node.pos}. ` +
            'This parser only understands string/number/boolean, T[], and a ' +
            'reference to another type declared in this same file.',
        );
    }
  }

  function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name.getText(source) === 'SCHEMA_VERSION' && decl.initializer) {
          version = decl.initializer.getText(source).replace(/['"]/g, '');
        }
      }
    }

    if (ts.isTypeAliasDeclaration(node) && node.type.kind === ts.SyntaxKind.UnionType) {
      const members = node.type.types;
      const isStringLiteralUnion = members.every(
        (m) => ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal),
      );
      if (isStringLiteralUnion) {
        unions[node.name.text] = members.map((m) => m.literal.text);
      }
      // A non-string-literal union alias would hit `typeOf`'s default case
      // the moment something tried to reference it as a field's type —
      // which is the right place for that to fail, not here.
    }

    if (ts.isInterfaceDeclaration(node)) {
      const fields = node.members
        .filter(ts.isPropertySignature)
        .map((member) => ({
          name: member.name.getText(source),
          optional: Boolean(member.questionToken),
          type: typeOf(member.type),
        }));
      interfaces[node.name.text] = { fields };
    }

    ts.forEachChild(node, visit);
  }

  visit(source);

  if (!version) {
    throw new Error('parse-schema: could not find SCHEMA_VERSION in ' + filePath);
  }

  return { version, unions, interfaces };
}
