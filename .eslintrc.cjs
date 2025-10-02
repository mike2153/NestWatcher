/* eslint-env node */
module.exports = {
  root: true,
  ignorePatterns: [
    'node_modules/',
    'packages/**/dist/',
  ],
  overrides: [
    {
      files: ['packages/**/*.ts', 'packages/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module'
      },
      plugins: ['@typescript-eslint'],
      extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended'
      ],
      rules: {
        '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/consistent-type-imports': 'warn'
      }
    },
    {
      files: ['packages/renderer/**/*.{ts,tsx}'],
      env: { browser: true },
      plugins: ['react', 'react-hooks'],
      extends: [
        'plugin:react/recommended',
        'plugin:react-hooks/recommended'
      ],
      settings: { react: { version: 'detect' } },
      rules: {
        'react/react-in-jsx-scope': 'off'
      }
    },
    {
      files: ['packages/main/**/*.ts', 'packages/preload/**/*.ts'],
      env: { node: true }
    },
    {
      files: ['tests/**/*.{ts,tsx}'],
      env: { node: true },
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        beforeEach: 'readonly',
        afterAll: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
        page: 'readonly',
        browser: 'readonly',
        context: 'readonly'
      }
    }
  ]
};
