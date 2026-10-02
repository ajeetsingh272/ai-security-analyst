// Flat config, run once from the root across the whole workspace.
//
// Per-package lint scripts would need eslint installed seven times under
// pnpm's strict linking. One root invocation is faster and leaves one config
// to keep correct.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      'site/**',
      'bin/**',
      // Generated from packages/schema — a lint failure here is a generator bug,
      // not something to fix by hand.
      '**/*.gen.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Applies to every linted file, JS and TS alike. typescript-eslint's
  // recommended set reaches .mjs too, so scoping this to **/*.ts would leave
  // the build tooling judged by the default options.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Unused args are normal in handler signatures; an underscore marks intent.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          // `const { omitMe: _, ...rest }` is the idiomatic way to drop a key.
          ignoreRestSiblings: true,
        },
      ],
      // This codebase handles security telemetry. `any` erases the type safety
      // that stops a tenant id being confused with a user id.
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // Build and planning tooling is expected to write to stdout.
  {
    files: ['scripts/**/*.{js,mjs}', 'tools/**/*.{js,mjs}', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  // Tests assert on shapes that are deliberately wrong.
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
