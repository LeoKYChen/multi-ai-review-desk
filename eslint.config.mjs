import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    rules: {
      // Empty catches deliberately absorb unavailable storage or closed windows.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
      // Full-width spaces are intentional separators in displayed Chinese text.
      'no-irregular-whitespace': ['error', { skipTemplates: true }],
    },
  },
  {
    files: ['docs/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: globals.browser },
  },
  {
    files: ['verification/**/*.cjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.browser } },
  },
];
